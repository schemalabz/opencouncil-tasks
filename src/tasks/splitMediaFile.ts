import { SplitMediaFileRequest, SplitMediaFileResult } from "../types.js";
import path from "path";
import { Task } from "./pipeline.js";
import { uploadToSpaces } from "./uploadToSpaces.js";
import { downloadFile, getFileParts } from "./utils/mediaOperations.js";

export const splitMediaFile: Task<SplitMediaFileRequest, SplitMediaFileResult> = async (request, onProgress) => {
    const { url, type, parts } = request;

    // Validate file extension
    const fileExt = path.extname(url).toLowerCase();
    if (type === 'audio' && fileExt !== '.mp3') {
        throw new Error('Audio files must be MP3 format');
    }
    if (type === 'video' && fileExt !== '.mp4') {
        throw new Error('Video files must be MP4 format');
    }

    const results: SplitMediaFileResult['parts'] = [];
    const inputFile = await downloadFile(url);

    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        onProgress(`processing`, (i / parts.length) * 100);

        const outputFilePath = await getFileParts(inputFile, part.segments, type);
        const uploadedUrls = await uploadToSpaces({
            files: [outputFilePath],
            spacesPath: `${type}-parts`
        }, onProgress);

        if (uploadedUrls.length !== 1) {
            throw new Error(`Expected 1 uploaded URL, got ${uploadedUrls.length}!`);
        }

        const uploadedUrl = uploadedUrls[0];

        const duration = part.segments.reduce((total, segment) => {
            return total + (segment.endTimestamp - segment.startTimestamp);
        }, 0);

        results.push({
            id: part.id,
            url: uploadedUrl,
            type,
            duration,
            startTimestamp: part.segments[0].startTimestamp,
            endTimestamp: part.segments[part.segments.length - 1].endTimestamp
        });
    }

    onProgress(`processing`, 100);

    return { parts: results };
};
