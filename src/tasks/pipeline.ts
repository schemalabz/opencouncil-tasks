import { Stage, TranscribeRequest, TranscribeResponse, TranscribeUpdate, Transcript } from "../types";
import { downloadYTV } from "./downloadYTV";
import { splitAudio } from "./splitAudio";
import { transcribe } from "./transcribe";
import { uploadToSpaces } from "./uploadToSpaces";
import _ from 'underscore';

export type Task<Args, Ret> = (args: Args, onProgress: (perc: number) => void) => Promise<Ret>;


export const pipeline: Task<TranscribeRequest, TranscribeResponse> = async (request: TranscribeRequest, onProgress) => {
    return pipelineWithStatus(request, (status) => onProgress(status.progressPercent));
}

export const pipelineWithStatus = async (request: TranscribeRequest, onProgress: (status: { stage: Stage, progressPercent: number }) => void) => {
    let currentStatus: Stage = "downloading-video";
    const throttledOnProgress = _.throttle((perc: number) => onProgress({ stage: currentStatus, progressPercent: perc }), 10000, { leading: false, trailing: true });

    const { audioOnly, combined } = await downloadYTV(request.youtubeUrl, throttledOnProgress);

    const combinedVideoUploadPromise = uploadToSpaces({
        files: [combined],
        spacesPath: "council-meeting-videos"
    }, () => { });

    currentStatus = "segmenting-video";
    const audioSegments = await splitAudio({ file: audioOnly, maxDuration: 60 * 60 }, throttledOnProgress);

    const audioUrls = await uploadToSpaces({
        files: audioSegments.map((segment) => segment.path),
        spacesPath: "audio"
    }, throttledOnProgress);

    const segments = audioSegments.map((segment, index) => ({
        url: audioUrls[index],
        start: segment.startTime
    }));

    currentStatus = "transcribing";
    const transcript = await transcribe({
        segments,
        customVocabulary: request.customVocabulary,
        customPrompt: request.customPrompt
    }, throttledOnProgress);

    currentStatus = "uploading-video";
    const combinedVideoUrls = await combinedVideoUploadPromise;
    if (combinedVideoUrls.length !== 1) {
        throw new Error("Expected a single video URL");
    }

    currentStatus = "finished";
    return {
        videoUrl: combinedVideoUrls[0],
        transcript
    };
};