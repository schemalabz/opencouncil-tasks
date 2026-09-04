import fs from 'fs';
import path from 'path';
import { createMuxAsset } from "../lib/mux.js";
import { GenerateHighlightRequest, GenerateHighlightResult } from "../types.js";
import { Task } from "./pipeline.js";
import {
  splitAndUploadMedia,
  generateSocialFilter,
  getVideoResolution,
  downloadFile,
  getFileParts,
  normalizeUtteranceTimestamps,
  getPresetConfig,
} from "./utils/mediaOperations.js";
import { forcedAlign, AlignedWord } from '../lib/ElevenLabsAlign.js';
import { resolveWordTimings } from '../lib/captions/wordTimings.js';
import { buildCaptionTimeline } from '../lib/captions/timeline.js';
import { resolveForOrientation } from '../lib/captions/presets.js';
import { getCaptionConfig, presetFingerprint, selectPreset } from '../lib/captions/presetConfig.js';
import { renderAss } from '../lib/captions/assRenderer.js';
import { ensureFonts, getFontsDir } from '../lib/captions/fonts.js';
import type { UtteranceForCaptions, WordTiming } from '../lib/captions/types.js';
import { getDataDir } from '../lib/dataDir.js';

const dataDir = getDataDir();

/**
 * Merge consecutive video segments to simplify FFmpeg operations
 * When segments are continuous (end of one = start of next), merge them into single ranges
 * This reduces the number of trim+concat operations FFmpeg needs to perform
 */
export function mergeConsecutiveSegments(
  segments: Array<{ startTimestamp: number; endTimestamp: number }>
): Array<{ startTimestamp: number; endTimestamp: number }> {
  if (segments.length === 0) {
    return [];
  }
  
  const merged: Array<{ startTimestamp: number; endTimestamp: number }> = [];
  let currentMerge = { ...segments[0] };
  
  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i];
    
    // Check if this segment is consecutive with the current merge
    // Use small epsilon for floating point comparison
    const isConsecutive = Math.abs(currentMerge.endTimestamp - segment.startTimestamp) < 0.001;
    
    if (isConsecutive) {
      // Extend the current merge to include this segment
      currentMerge.endTimestamp = segment.endTimestamp;
    } else {
      // Gap detected - save current merge and start a new one
      merged.push(currentMerge);
      currentMerge = { ...segment };
    }
  }
  
  // Don't forget the last merge
  merged.push(currentMerge);
  
  return merged;
}

/**
 * Bridge small gaps between consecutive utterances to avoid jarring cuts
 * Extends utterance end times to meet the next utterance's start time if gap is small
 * Returns both the video segments (for FFmpeg) and adjusted utterances (for captions/overlays sync)
 * Merges consecutive segments to simplify FFmpeg operations
 */
export function bridgeUtteranceGaps(
  utterances: GenerateHighlightRequest['parts'][0]['utterances'],
  maxGapSeconds: number = 2.0
): {
  segments: Array<{ startTimestamp: number; endTimestamp: number }>;
  adjustedUtterances: GenerateHighlightRequest['parts'][0]['utterances'];
} {
  if (utterances.length === 0) {
    return { segments: [], adjustedUtterances: [] };
  }
  
  const segments: Array<{ startTimestamp: number; endTimestamp: number }> = [];
  const adjustedUtterances = utterances.map((utterance, index) => {
    if (index < utterances.length - 1) {
      const nextUtterance = utterances[index + 1];
      const gap = nextUtterance.startTimestamp - utterance.endTimestamp;
      
      // Only bridge if gap is positive and small (less than threshold)
      if (gap > 0 && gap <= maxGapSeconds) {
        console.log(`🔗 Bridging ${gap.toFixed(3)}s gap between utterances ${index} and ${index + 1}`);
        
        // Extend the segment to bridge the gap
        segments.push({
          startTimestamp: utterance.startTimestamp,
          endTimestamp: nextUtterance.startTimestamp,  // Extended to next utterance
        });
        
        // Also extend the utterance end time for caption/overlay sync
        return {
          ...utterance,
          endTimestamp: nextUtterance.startTimestamp,  // Extended to match segment
        };
      }
    }
    
    // No bridging needed - use original timestamps
    segments.push({
      startTimestamp: utterance.startTimestamp,
      endTimestamp: utterance.endTimestamp,
    });
    
    return utterance;
  });
  
  // Merge consecutive segments to optimize FFmpeg operations
  const mergedSegments = mergeConsecutiveSegments(segments);
  
  if (mergedSegments.length < segments.length) {
    console.log(`✨ Optimized: merged ${segments.length} segments into ${mergedSegments.length} continuous range(s)`);
  }
  
  return { segments: mergedSegments, adjustedUtterances };
}

export const generateHighlight: Task<
  GenerateHighlightRequest,
  GenerateHighlightResult
> = async (request, onProgress) => {
  const { media, parts, render } = request;

  const results: GenerateHighlightResult["parts"] = [];

  // Determine input video resolution once for the entire request
  let inputVideoWidth: number | undefined;
  let inputVideoHeight: number | undefined;
  if (media.type === 'video') {
    try {
      const localPath = await downloadFile(media.videoUrl);
      const res = await getVideoResolution(localPath);
      inputVideoWidth = res.width;
      inputVideoHeight = res.height;
    } catch (err) {
      console.warn(`⚠️ Failed to detect input video resolution, falling back to defaults: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const partProgress = (current: number) => {
      onProgress(
        `processing highlight ${i + 1}/${parts.length}`,
        5 + (i / parts.length) * 90 + current / parts.length * 0.9
      );
    };

    // Convert utterances to segments for media splitting, bridging small gaps
    // to avoid jarring cuts while keeping captions/overlays in sync
    const { segments, adjustedUtterances } = bridgeUtteranceGaps(part.utterances);
    
    console.log(`🎞️  Processing ${part.utterances.length} utterances → ${segments.length} video segments`);

    let result;

    // Generate video filters based on render options
    // Filter chain: social_transform → captions+speaker chip (single ASS burn)
    let videoFilters: string | undefined;
    const aspectRatio = render.aspectRatio || 'default';
    const isSocial = aspectRatio === 'social-9x16';

    if (isSocial) {
      console.log(`⏱️  Starting social media transformation...`);
      partProgress(10);
    }

    // Step 1: Social transformation (if needed)
    let baseFilter = '';
    if (isSocial) {
      const social = render.socialOptions || {};
      const socialOptions: Required<NonNullable<GenerateHighlightRequest['render']['socialOptions']>> = {
        marginType: social.marginType || 'blur',
        backgroundColor: social.backgroundColor || '#000000',
        zoomFactor: Math.max(0.6, Math.min(1.0, social.zoomFactor || 1.0))
      };
      baseFilter = generateSocialFilter(socialOptions, inputVideoWidth || 1280, inputVideoHeight || 720);
      partProgress(15);
    }

    // Steps 2-3: word-timed captions + speaker chip, burned via one ASS file.
    // Pipeline: clip audio → forced alignment (fallback: interpolation) →
    // caption timeline → .ass → subtitles filter appended after the social transform.
    let captionFilter = '';
    let assPath: string | undefined;
    // Recorded on the result so a rendered video can always be traced back to
    // the styling that produced it, even after the config file changes.
    let captionStyle: string | undefined;
    let captionPresetHash: string | undefined;
    if (render.includeCaptions || render.includeSpeakerOverlay) {
      const localVideoPath = await downloadFile(media.videoUrl);
      partProgress(isSocial ? 16 : 8);

      const normalized = normalizeUtteranceTimestamps(adjustedUtterances);
      const utterancesForCaptions: UtteranceForCaptions[] = normalized.map((n, i) => ({
        utteranceId: adjustedUtterances[i].utteranceId,
        startMs: Math.round(n.normalizedStart * 1000),
        endMs: Math.round(n.normalizedEnd * 1000),
        text: n.text,
        speaker: adjustedUtterances[i].speaker,
      }));

      let words: WordTiming[][];
      if (render.includeCaptions) {
        // Only extract clip audio and pay for forced alignment when captions are
        // actually rendered — a chip-only render never displays word timings.
        const clipAudioPath = await getFileParts(localVideoPath, segments, 'audio');
        partProgress(isSocial ? 18 : 12);

        try {
          let aligned: AlignedWord[] | null = null;
          try {
            aligned = await forcedAlign(clipAudioPath, utterancesForCaptions.map(u => u.text).join(' '));
            console.log(`🎯 Forced alignment returned ${aligned.length} words`);
          } catch (err) {
            console.warn(`⚠️ Forced alignment unavailable, interpolating word timings: ${err instanceof Error ? err.message : String(err)}`);
          }
          const resolved = resolveWordTimings(utterancesForCaptions, aligned);
          words = resolved.words;
          if (resolved.interpolatedUtterances > 0) {
            console.warn(`⚠️ Interpolated timings for ${resolved.interpolatedUtterances}/${utterancesForCaptions.length} utterances`);
          }
        } finally {
          try { fs.unlinkSync(clipAudioPath); } catch { /* best effort */ }
        }
      } else {
        words = utterancesForCaptions.map(() => []);
      }

      // Presets come from the config layer, so a styling change on the data
      // volume takes effect on the next render without a rebuild.
      const { id: presetId, preset: basePreset } = selectPreset(getCaptionConfig(), render.captionStyle);
      const frame = isSocial
        ? getPresetConfig(`${inputVideoWidth || 1280}x${inputVideoHeight || 720}`, 'social-9x16').dimensions
        : { width: inputVideoWidth || 1280, height: inputVideoHeight || 720 };
      // Flatten the landscape override group for this output frame; downstream
      // consumers (paging + renderer) never branch on aspect themselves.
      const preset = resolveForOrientation(basePreset, frame);
      captionStyle = presetId;
      captionPresetHash = presetFingerprint(preset);

      const timeline = buildCaptionTimeline(utterancesForCaptions, words, preset.layout);
      // Populates the fonts directory and reports which family the chip can
      // actually name, so libass is never left to substitute.
      const chipFont = await ensureFonts();
      const ass = renderAss(timeline, preset, frame, {
        includeCaptions: !!render.includeCaptions,
        includeSpeakerOverlay: !!render.includeSpeakerOverlay,
        chipFont,
      });

      // Random name (never caller-supplied): the path lands inside a quoted ffmpeg filter value
      const assRandomId = Math.random().toString(36).substring(2, 15);
      assPath = path.join(dataDir, `captions-${assRandomId}.ass`);
      await fs.promises.writeFile(assPath, ass, 'utf-8');
      console.log(`📝 Captions: preset '${presetId}', ${timeline.pages.length} pages, ${timeline.speakerSpans.length} speaker spans → ${assPath}`);

      captionFilter = `subtitles=filename='${assPath}':fontsdir='${getFontsDir()}'`;
      partProgress(isSocial ? 20 : 15);
    }

    // Combine all filters in the correct order (captions burn AFTER the social transform)
    const filterParts = [baseFilter, captionFilter].filter(f => f.length > 0);
    if (filterParts.length > 0) {
      videoFilters = filterParts.join(',');
      console.log(`🎬 Combined filter chain: ${filterParts.length} filter(s)`);
    }

    // Apply combined filters to media processing pipeline
    const progressStart = isSocial ? 20 : 15;
    const progressRange = 100 - progressStart - 5; // Leave 5% for final steps
    
    result = await splitAndUploadMedia(
      media.videoUrl,
      media.type,
      segments,
      `highlights`,
      (_stage, progress) => partProgress(progressStart + progress * (progressRange / 100)),
      videoFilters
    );

    // Rendered successfully — the burned-in .ass is no longer needed.
    // On failure the file is deliberately left in dataDir for debugging.
    if (assPath) {
      try { fs.unlinkSync(assPath); } catch { /* best effort */ }
    }

    const highlightResult: GenerateHighlightResult["parts"][0] = {
      id: part.id,
      url: result.url,
      duration: result.duration,
      startTimestamp: result.startTimestamp,
      endTimestamp: result.endTimestamp,
      ...(captionStyle ? { captionStyle, captionPresetHash } : {}),
    };

    // Generate Mux playback ID for video highlights
    if (media.type === "video") {
      const muxResult = await createMuxAsset(result.url);
      highlightResult.muxPlaybackId = muxResult.playbackId;
      highlightResult.muxAssetId = muxResult.assetId;
      partProgress(95);
    }

    results.push(highlightResult);
  }

  onProgress(`processing complete`, 100);

  return { parts: results };
}; 