import { getMuxPlaybackId } from "../lib/mux.js";
import { GenerateHighlightRequest, GenerateHighlightResult } from "../types.js";
import { Task } from "./pipeline.js";
import { splitAndUploadMedia, generateSocialFilter, generateCaptionFilters, generateSpeakerOverlayFilter, getVideoResolution, downloadFile } from "./utils/mediaOperations.js";

/**
 * Merge consecutive video segments to simplify FFmpeg operations
 * When segments are continuous (end of one = start of next), merge them into single ranges
 * This reduces the number of trim+concat operations FFmpeg needs to perform
 */
function mergeConsecutiveSegments(
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
function bridgeUtteranceGaps(
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
    // Filter chain: social_transform → speaker_overlays → captions
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

    // Step 2: Speaker overlays (if enabled)
    // Use adjustedUtterances to keep overlays synced with bridged video segments
    let speakerFilter = '';
    if (render.includeSpeakerOverlay) {
      console.log(`👤 Generating speaker overlays for ${adjustedUtterances.length} utterances`);
      speakerFilter = await generateSpeakerOverlayFilter(adjustedUtterances, aspectRatio, inputVideoWidth || 1280, inputVideoHeight || 720);
      partProgress(isSocial ? 18 : 10);
    }

    // Step 3: Captions (if enabled)
    // Use adjustedUtterances to keep captions synced with bridged video segments
    let captionFilter = '';
    if (render.includeCaptions) {
      console.log(`📝 Generating captions for ${adjustedUtterances.length} utterances in ${aspectRatio} format`);
      captionFilter = await generateCaptionFilters(adjustedUtterances, aspectRatio, inputVideoWidth || 1280, inputVideoHeight || 720);
      partProgress(isSocial ? 20 : 15);
    }

    // Combine all filters in the correct order
    const filterParts = [baseFilter, speakerFilter, captionFilter].filter(f => f.length > 0);
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
      (progress) => partProgress(progressStart + progress * (progressRange / 100)),
      videoFilters
    );



    const highlightResult: GenerateHighlightResult["parts"][0] = {
      id: part.id,
      url: result.url,
      duration: result.duration,
      startTimestamp: result.startTimestamp,
      endTimestamp: result.endTimestamp,
    };

    // Generate Mux playback ID for video highlights
    if (media.type === "video") {
      highlightResult.muxPlaybackId = await getMuxPlaybackId(result.url);
      partProgress(95);
    }

    results.push(highlightResult);
  }

  onProgress(`processing complete`, 100);

  return { parts: results };
}; 