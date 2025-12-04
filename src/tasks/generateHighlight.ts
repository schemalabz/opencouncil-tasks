import { getMuxPlaybackId } from "../lib/mux.js";
import { GenerateHighlightRequest, GenerateHighlightResult } from "../types.js";
import { Task } from "./pipeline.js";
import { splitAndUploadMedia, generateSocialFilter, generateCaptionFilters, generateSpeakerOverlayFilter, getVideoResolution, downloadFile, mergeContinuousUtterances } from "./utils/mediaOperations.js";

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

    // Convert utterances to segments for media splitting
    // Merge continuous utterances to avoid unnatural cuts when utterances are close together (within 2 seconds)
    const mergedSegments = mergeContinuousUtterances(part.utterances, 2.0);
    const segments = mergedSegments.map(segment => ({
      startTimestamp: segment.startTimestamp,
      endTimestamp: segment.endTimestamp,
    }));

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
    let speakerFilter = '';
    if (render.includeSpeakerOverlay) {
      console.log(`👤 Generating speaker overlays for ${part.utterances.length} utterances`);
      speakerFilter = await generateSpeakerOverlayFilter(part.utterances, aspectRatio, inputVideoWidth || 1280, inputVideoHeight || 720);
      partProgress(isSocial ? 18 : 10);
    }

    // Step 3: Captions (if enabled)
    let captionFilter = '';
    if (render.includeCaptions) {
      console.log(`📝 Generating captions for ${part.utterances.length} utterances in ${aspectRatio} format`);
      captionFilter = await generateCaptionFilters(part.utterances, aspectRatio, inputVideoWidth || 1280, inputVideoHeight || 720);
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