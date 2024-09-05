import { Router } from "express";
import { CallbackServer } from "../lib/CallbackServer";
import { Diarization, TaskUpdate, TranscribeRequest, TranscribeResult } from "../types";
import { applyDiarization } from "./applyDiarization";
import { diarize } from "./diarize";
import { downloadYTV } from "./downloadYTV";
import { splitAudioDiarization } from "./splitAudioDiarization";
import { transcribe } from "./transcribe";
import { uploadToSpaces } from "./uploadToSpaces";
import _ from 'underscore';

export type Task<Args, Ret> = (args: Args, onProgress: (stage: string, progressPercent: number) => void) => Promise<Ret>;

export const pipeline: Task<TranscribeRequest, TranscribeResult> = async (request, onProgress) => {
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

    const transcriptPromise =
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

    const transcript = await transcriptPromise;

    const diarizedTranscript = await applyDiarization({ diarization, transcript }, createProgressHandler("diarizing-transcript"));

    const combinedVideoUrls = await combinedVideoUploadPromise; // wait for 2A
    if (combinedVideoUrls.length !== 1) {
        throw new Error("Expected a single video URL");
    }
    let videoUrl = combinedVideoUrls[0];


    onProgress("finished", 100); //lfgggg
    return {
        videoUrl,
        audioUrl,
        transcript: diarizedTranscript
    };
};