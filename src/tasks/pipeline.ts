import { TranscribeRequest, TranscribeResult, TranscriptWithSpeakerIdentification, DiarizeRequest, DiarizeResult, Diarization, DiarizationSpeaker, Transcript } from "../types.js";
import { applyDiarization } from "./applyDiarization.js";
import { diarize } from "./diarize.js";
import { downloadYTV } from "./downloadYTV.js";
import { splitAudioDiarization } from "./splitAudioDiarization.js";
import { type SplitAudioArgs, type AudioSegment } from "./splitAudioDiarization.js";
import { transcribe } from "./transcribe.js";
import { type TranscribeArgs } from "./transcribe.js";
import { uploadToSpaces } from "./uploadToSpaces.js";
import { type UploadFilesArgs } from "./uploadToSpaces.js";
import { createMuxAsset, deleteMuxAsset, type MuxResult } from "../lib/mux.js";
import _ from 'underscore';
import dotenv from "dotenv";

dotenv.config();

export type Task<Args, Ret> = (args: Args, onProgress: (stage: string, progressPercent: number) => void) => Promise<Ret>;

export type PipelineDeps = {
    downloadYTV: Task<string, { audioOnly: string; combined: string; sourceType: string }>;
    uploadToSpaces: Task<UploadFilesArgs, string[]>;
    diarize: Task<Omit<DiarizeRequest, "callbackUrl">, DiarizeResult>;
    splitAudioDiarization: Task<SplitAudioArgs, AudioSegment[]>;
    transcribe: Task<TranscribeArgs, Transcript>;
    applyDiarization: Task<{ diarization: Diarization; speakers: DiarizationSpeaker[]; transcript: Transcript }, TranscriptWithSpeakerIdentification>;
    createMuxAsset: (videoUrl: string) => Promise<MuxResult>;
    deleteMuxAsset: (assetId: string) => Promise<void>;
};

export function createPipeline(deps: PipelineDeps): Task<Omit<TranscribeRequest, "callbackUrl">, TranscribeResult> {
    return async (request, onProgress) => {
        const createProgressHandler = (stage: string) => {
            return _.throttle((subStage: string, perc: number) => onProgress(`${stage}:${subStage}`, perc), 10000, { leading: true, trailing: false });
        };

        const { audioOnly, combined, sourceType } = await deps.downloadYTV(request.youtubeUrl, createProgressHandler("downloading-video"));

        // Only upload video if it's not already from our CDN
        const isCdnUrl = sourceType === 'CDN';
        const combinedVideoUploadPromise = isCdnUrl
            ? Promise.resolve([request.youtubeUrl]) // Use the original CDN URL
            : deps.uploadToSpaces({
                files: [combined],
                spacesPath: "council-meeting-videos"
            }, () => { });

        // Start Mux asset creation early so it runs in parallel with diarization/transcription.
        // The playback ID is available immediately — Mux processes the video asynchronously.
        // Suppress unhandled rejection since we handle errors when we await later.
        const muxPromise = combinedVideoUploadPromise.then(async (urls) => {
            if (urls.length !== 1) throw new Error("Expected a single video URL");
            return deps.createMuxAsset(urls[0]);
        });
        muxPromise.catch(() => {});

        try {
            const { audioUrl, diarization, speakers } = await deps.uploadToSpaces({
                files: [audioOnly],
                spacesPath: "audio"
            }, () => { }).then(async (urls) => {
                const audioUrl = urls[0];
                console.log(`Diarizing url ${audioUrl}`);
                const { diarization, speakers } = await deps.diarize({ audioUrl, voiceprints: request.voiceprints }, createProgressHandler("diarizing"));
                return { audioUrl, diarization, speakers };
            });

            console.log("Uploaded audio to spaces and diarized");

            const transcript =
                await deps.splitAudioDiarization({ file: audioOnly, maxDuration: 60 * 60, diarization }, createProgressHandler("segmenting-video"))
                    .then(async (audioSegments) => {
                        const audioUrls = await deps.uploadToSpaces({
                            files: audioSegments.map((segment) => segment.path),
                            spacesPath: "audio"
                        }, createProgressHandler("uploading-audio"));

                        const segments = audioSegments.map((segment, index) => ({
                            url: audioUrls[index],
                            start: segment.startTime
                        }));

                        return deps.transcribe({
                            segments,
                            customVocabulary: request.customVocabulary,
                            customPrompt: request.customPrompt
                        }, createProgressHandler("transcribing"));
                    });

            console.log("Split audio and transcribed");

            const diarizedTranscript: TranscriptWithSpeakerIdentification = await deps.applyDiarization({ diarization, speakers, transcript }, createProgressHandler("diarizing-transcript"));

            console.log("Applied diarization");

            const combinedVideoUrls = await combinedVideoUploadPromise; // wait for video upload or get CDN URL
            if (combinedVideoUrls.length !== 1) {
                throw new Error("Expected a single video URL");
            }
            let videoUrl = combinedVideoUrls[0];

            console.log(isCdnUrl ? "Using existing CDN video URL" : "Uploaded combined video");
            onProgress("finished", 100); //lfgggg

            console.log("All done");

            const muxResult = await muxPromise;

            return {
                videoUrl,
                audioUrl,
                muxPlaybackId: muxResult.playbackId,
                muxAssetId: muxResult.assetId,
                transcript: diarizedTranscript
            };
        } catch (error) {
            // Clean up the Mux asset if the pipeline fails — don't leave orphaned assets
            try {
                const muxResult = await muxPromise;
                console.warn(`Pipeline failed, deleting Mux asset ${muxResult.assetId}`);
                await deps.deleteMuxAsset(muxResult.assetId);
            } catch {
                // Mux creation itself may have failed, or deletion failed — nothing to clean up
            }
            throw error;
        }
    };
}

// Default pipeline with real implementations (preserves all existing call sites)
export const pipeline = createPipeline({
    downloadYTV,
    uploadToSpaces,
    diarize,
    splitAudioDiarization,
    transcribe,
    applyDiarization,
    createMuxAsset,
    deleteMuxAsset,
});
