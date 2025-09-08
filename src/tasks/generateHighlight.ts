import { getMuxPlaybackId } from "../lib/mux.js";
import { GenerateHighlightRequest, GenerateHighlightResult } from "../types.js";
import { Task } from "./pipeline.js";
import { splitAndUploadMedia, generateSocialFilter, generateCaptionFilters, generateSocialWithCaptionsFilter } from "./utils/mediaOperations.js";

export const generateHighlight: Task<
  GenerateHighlightRequest,
  GenerateHighlightResult
> = async (request, onProgress) => {
  const { media, parts, render } = request;

  const results: GenerateHighlightResult["parts"] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const partProgress = (current: number) => {
      onProgress(
        `processing highlight ${i + 1}/${parts.length}`,
        5 + (i / parts.length) * 90 + current / parts.length * 0.9
      );
    };

    // Convert utterances to segments for media splitting
    const segments = part.utterances.map(utterance => ({
      startTimestamp: utterance.startTimestamp,
      endTimestamp: utterance.endTimestamp,
    }));

    let result;

    // Generate video filters based on render options
    let videoFilters: string | undefined;

    // Check if social media transformation is needed
    if (render.aspectRatio === 'social-9x16') {
      // Inline social media transformation logic
      const overallStartTime = Date.now();
      console.log(`⏱️  Starting social media transformation...`);
      
      partProgress(10);
      
      // Parse social options with sensible defaults
      const social = render.socialOptions || {};
      const socialOptions: Required<NonNullable<GenerateHighlightRequest['render']['socialOptions']>> = {
        marginType: social.marginType || 'blur',
        backgroundColor: social.backgroundColor || '#000000',
        zoomFactor: Math.max(0.6, Math.min(1.0, social.zoomFactor || 1.0)) // Clamp to valid range
      };
      
      // Generate filter with or without captions
      if (render.includeCaptions) {
        console.log(`📝 Generating social filter with captions for ${part.utterances.length} utterances`);
        videoFilters = await generateSocialWithCaptionsFilter(socialOptions, part.utterances);
      } else {
        videoFilters = generateSocialFilter(socialOptions);
      }
      
      partProgress(20);
      
      // Apply social transformation to media processing pipeline
      result = await splitAndUploadMedia(
        media.videoUrl,
        media.type,
        segments,
        `highlights`,
        (progress) => partProgress(20 + progress * 0.8), // Map to 20-100% range
        videoFilters // Pass the combined filter to FFmpeg
      );
      
      const overallEndTime = Date.now();
      const overallDuration = overallEndTime - overallStartTime;
      console.log(`⏱️  Social media transformation completed in ${overallDuration}ms (${(overallDuration/1000).toFixed(2)}s)`);
    } else {
      // Default aspect ratio processing
      if (render.includeCaptions) {
        console.log(`📝 Generating captions for ${part.utterances.length} utterances in default format`);
        videoFilters = await generateCaptionFilters(part.utterances, 'default');
      }

      // Use standard media operations with optional caption filters
      result = await splitAndUploadMedia(
        media.videoUrl,
        media.type,
        segments,
        `highlights`,
        partProgress,
        videoFilters
      );
    }

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