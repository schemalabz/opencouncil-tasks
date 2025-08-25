import { getMuxPlaybackId } from "../lib/mux.js";
import { GenerateHighlightRequest, GenerateHighlightResult } from "../types.js";
import { Task } from "./pipeline.js";
import { splitAndUploadMedia } from "./utils/mediaOperations.js";

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
        (i / parts.length) * 100 + current / parts.length
      );
    };

    // Convert utterances to segments for media splitting
    const segments = part.utterances.map(utterance => ({
      startTimestamp: utterance.startTimestamp,
      endTimestamp: utterance.endTimestamp,
    }));

    // TODO: Phase 2 - Implement caption rendering with FFmpeg filters
    // For now, just split the media without visual enhancements
    const result = await splitAndUploadMedia(
      media.videoUrl,
      media.type,
      segments,
      `highlights`,
      partProgress
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
    }

    results.push(highlightResult);
  }

  onProgress(`processing complete`, 100);

  return { parts: results };
}; 