import { TaskUpdate, TranscribeRequest, TranscribeResult } from "../types";
import { downloadYTV } from "./downloadYTV";
import { splitAudio } from "./splitAudio";
import { transcribe } from "./transcribe";
import { uploadToSpaces } from "./uploadToSpaces";
import _ from 'underscore';

export type Task<Args, Ret> = (args: Args, onProgress: (stage: string, progressPercent: number) => void) => Promise<Ret>;

export const pipeline: Task<TranscribeRequest, TranscribeResult> = async (request: TranscribeRequest, onProgress: (stage: string, perc: number) => void) => {
    const createProgressHandler = (stage: string) => {
        return _.throttle((subStage: string, perc: number) => onProgress(`${stage}:${subStage}`, perc), 10000, { leading: true, trailing: false });
    };

    const { audioOnly, combined } = await downloadYTV(request.youtubeUrl, createProgressHandler("downloading-video"));

    const combinedVideoUploadPromise = uploadToSpaces({
        files: [combined],
        spacesPath: "council-meeting-videos"
    }, () => { });

    const audioSegments = await splitAudio({ file: audioOnly, maxDuration: 60 * 60 }, createProgressHandler("segmenting-video"));

    const audioUrls = await uploadToSpaces({
        files: audioSegments.map((segment) => segment.path),
        spacesPath: "audio"
    }, createProgressHandler("uploading-audio"));

    const segments = audioSegments.map((segment, index) => ({
        url: audioUrls[index],
        start: segment.startTime
    }));

    const transcript = await transcribe({
        segments,
        customVocabulary: request.customVocabulary,
        customPrompt: request.customPrompt
    }, createProgressHandler("transcribing"));

    const combinedVideoUrls = await combinedVideoUploadPromise;
    if (combinedVideoUrls.length !== 1) {
        throw new Error("Expected a single video URL");
    }

    let videoUrl = combinedVideoUrls[0];
    if (!videoUrl.startsWith("http")) {
        videoUrl = `https://${process.env.DO_SPACES_ENDPOINT}/${videoUrl}`;
    }

    onProgress("finished", 100);
    return {
        videoUrl,
        transcript
    };
};