import { Router } from "express";
import { CallbackServer } from "../lib/CallbackServer.js";
import { Diarization, TaskUpdate, TranscribeRequest, TranscribeResult } from "../types.js";
import { applyDiarization } from "./applyDiarization.js";
import { diarize } from "./diarize.js";
import { downloadYTV } from "./downloadYTV.js";
import { splitAudioDiarization } from "./splitAudioDiarization.js";
import { transcribe } from "./transcribe.js";
import { uploadToSpaces } from "./uploadToSpaces.js";
import _ from 'underscore';

export type Task<Args, Ret> = (args: Args, onProgress: (stage: string, progressPercent: number) => void) => Promise<Ret>;

export const pipeline: Task<Omit<TranscribeRequest, "callbackUrl">, TranscribeResult> = async (request, onProgress) => {
    const createProgressHandler = (stage: string) => {
        return _.throttle((subStage: string, perc: number) => onProgress(`${stage}:${subStage}`, perc), 10000, { leading: true, trailing: false });
    };

    const { audioOnly, combined } = await downloadYTV(request.youtubeUrl, createProgressHandler("downloading-video"));

    const combinedVideoUploadPromise = uploadToSpaces({
        files: [combined],
        spacesPath: "council-meeting-videos"
    }, () => { });

    const { audioUrl, diarization } = await uploadToSpaces({
        files: [audioOnly],
        spacesPath: "audio"
    }, () => { }).then(async (urls) => {
        const audioUrl = urls[0];
        const diarization = await diarize(audioUrl, createProgressHandler("diarizing"));
        return { audioUrl, diarization };
    });

    console.log("Uploaded audio to spaces and diarized");

    const transcript =
        await splitAudioDiarization({ file: audioOnly, maxDuration: 60 * 60, diarization }, createProgressHandler("segmenting-video"))
            .then(async (audioSegments) => {
                const audioUrls = await uploadToSpaces({
                    files: audioSegments.map((segment) => segment.path),
                    spacesPath: "audio"
                }, createProgressHandler("uploading-audio"));

                const segments = audioSegments.map((segment, index) => ({
                    url: audioUrls[index],
                    start: segment.startTime
                }));

                return transcribe({
                    segments,
                    customVocabulary: request.customVocabulary,
                    customPrompt: request.customPrompt
                }, createProgressHandler("transcribing"));
            });

    console.log("Split audio and transcribed");

    const diarizedTranscript = await applyDiarization({ diarization, transcript }, createProgressHandler("diarizing-transcript"));

    console.log("Applied diarization");

    const combinedVideoUrls = await combinedVideoUploadPromise; // wait for 2A
    if (combinedVideoUrls.length !== 1) {
        throw new Error("Expected a single video URL");
    }
    let videoUrl = combinedVideoUrls[0];

    console.log("Uploaded combined video");
    onProgress("finished", 100); //lfgggg

    console.log("All done");
    return {
        videoUrl,
        audioUrl,
        transcript: diarizedTranscript
    };
};