import { GenerateVoiceprintRequest, GenerateVoiceprintResult } from "../types.js";
import { Task } from "./pipeline.js";
import PyannoteDiarizer from "../lib/PyannoteDiarize.js";
import { splitAndUploadMedia } from "./utils/mediaOperations.js";

export const generateVoiceprint: Task<GenerateVoiceprintRequest, GenerateVoiceprintResult> = async (
    request,
    onProgress,
) => {
    const { mediaUrl, personId, segmentId, startTimestamp, endTimestamp, cityId } = request;

    // First extract the audio segment
    onProgress("extracting audio", 0);

    // Use the shared utility function to extract and upload the audio
    const audioResult = await splitAndUploadMedia(
        mediaUrl,
        "audio",
        [
            {
                startTimestamp,
                endTimestamp,
            },
        ],
        `voiceprints/${cityId}/${personId}`,
        (stage, percent) => {
            onProgress(`extracting audio: ${stage}`, percent * 0.5);
        },
    );

    const audioUrl = audioResult.url;
    const audioDuration = audioResult.duration;

    // Now generate the voiceprint embedding using the audio
    onProgress("generating voiceprint", 50);
    const diarizer = PyannoteDiarizer.getInstance();
    const voiceprint = await diarizer.generateVoiceprint(audioUrl);

    return {
        audioUrl,
        voiceprint,
        duration: audioDuration,
    };
};
