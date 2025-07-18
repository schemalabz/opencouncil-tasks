import { getMuxPlaybackId } from "../lib/mux.js";
import { SplitMediaFileRequest, SplitMediaFileResult } from "../types.js";
import { Task } from "./pipeline.js";
import { splitAndUploadMedia } from "./utils/mediaOperations.js";

export const splitMediaFile: Task<
  SplitMediaFileRequest,
  SplitMediaFileResult
> = async (request, onProgress) => {
  const { url, type, parts } = request;

  const results: SplitMediaFileResult["parts"] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const partProgress = (current) => {
      onProgress(
        `processing part ${i + 1}/${parts.length}`,
        (i / parts.length) * 100 + current / parts.length
      );
    };

    const result = await splitAndUploadMedia(
      url,
      type,
      part.segments,
      `${type}-parts`,
      partProgress
    );

    const partResult: SplitMediaFileResult["parts"][0] = {
      id: part.id,
      url: result.url,
      type,
      duration: result.duration,
      startTimestamp: result.startTimestamp,
      endTimestamp: result.endTimestamp,
    };

    // Only generate muxPlaybackId for video parts
    if (type === "video") {
      partResult.muxPlaybackId = await getMuxPlaybackId(result.url);
    }

    results.push(partResult);
  }

  onProgress(`processing complete`, 100);

  return { parts: results };
};
