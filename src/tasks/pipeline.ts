import { Router } from "express";
import { CallbackServer } from "../lib/CallbackServer.js";
import { TranscribeRequest, TranscribeResult, TranscriptWithSpeakerIdentification } from "../types.js";
import { applyDiarization } from "./applyDiarization.js";
import { diarize } from "./diarize.js";
import { downloadYTV } from "./downloadYTV.js";
import { splitAudioDiarization } from "./splitAudioDiarization.js";
import { transcribe } from "./transcribe.js";
import { uploadToSpaces } from "./uploadToSpaces.js";
import _ from 'underscore';
import dotenv from "dotenv";

dotenv.config();

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

    const { audioUrl, diarization, speakers } = await uploadToSpaces({
        files: [audioOnly],
        spacesPath: "audio"
    }, () => { }).then(async (urls) => {
        const audioUrl = urls[0];
        console.log(`Diarizing url ${audioUrl}`);
        const { diarization, speakers } = await diarize({ audioUrl, voiceprints: request.voiceprints }, createProgressHandler("diarizing"));
        return { audioUrl, diarization, speakers };
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

    const diarizedTranscript: TranscriptWithSpeakerIdentification = await applyDiarization({ diarization, speakers, transcript }, createProgressHandler("diarizing-transcript"));

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
        muxPlaybackId: await getMuxPlaybackId(videoUrl),
        transcript: diarizedTranscript
    };
};

const MUX_TOKEN_ID = process.env.MUX_TOKEN_ID;
const MUX_TOKEN_SECRET = process.env.MUX_TOKEN_SECRET;

const getMuxPlaybackId = async (videoUrl: string) => {
    if (!MUX_TOKEN_ID || !MUX_TOKEN_SECRET) {
        throw new Error("MUX_TOKEN_ID or MUX_TOKEN_SECRET is not set");
    }

    const response = await fetch("https://api.mux.com/video/v1/assets", {
        method: "POST",
        body: JSON.stringify({ input: videoUrl, playback_policy: ["public"], video_quality: "basic" }),
        headers: {
            "Content-Type": "application/json",
            Authorization: `Basic ${Buffer.from(`${process.env.MUX_TOKEN_ID}:${process.env.MUX_TOKEN_SECRET}`).toString("base64")}`,
        },
    });
    const data = await response.json();
    console.log("Got Mux asset", data);
    return data.data.playback_ids[0].id;
};