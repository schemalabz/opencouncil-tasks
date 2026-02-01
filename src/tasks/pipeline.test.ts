import { describe, it, expect, vi } from "vitest";
import { createPipeline, type PipelineDeps } from "./pipeline.js";
import type { Transcript, TranscriptWithSpeakerIdentification, DiarizationSpeaker } from "../types.js";

const fakeDiarization = [{ start: 0, end: 10, speaker: "SPEAKER_00" }];
const fakeSpeakers: DiarizationSpeaker[] = [{ speaker: "SPEAKER_00", match: null, confidence: {} }];
const fakeTranscript: Transcript = {
    metadata: { audio_duration: 100, number_of_distinct_channels: 1, billing_time: 100, transcription_time: 10 },
    transcription: { languages: ["en"], full_transcript: "hello world", utterances: [] },
};
const fakeDiarizedTranscript: TranscriptWithSpeakerIdentification = {
    ...fakeTranscript,
    transcription: {
        ...fakeTranscript.transcription,
        speakers: [],
        utterances: [],
    },
};

function createStubDeps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
    return {
        downloadYTV: vi.fn(async () => ({
            audioOnly: "/tmp/audio.wav",
            combined: "/tmp/combined.mp4",
            sourceType: "YouTube",
        })),
        uploadToSpaces: vi.fn(async ({ files, spacesPath }) => {
            if (spacesPath === "audio") return (files as string[]).map((_f: string, i: number) => `https://cdn.example.com/audio-${i}.wav`);
            if (spacesPath === "council-meeting-videos") return ["https://cdn.example.com/video.mp4"];
            return (files as string[]).map((_f: string, i: number) => `https://cdn.example.com/file-${i}`);
        }),
        diarize: vi.fn(async () => ({
            diarization: fakeDiarization,
            speakers: fakeSpeakers,
        })),
        splitAudioDiarization: vi.fn(async () => [
            { path: "/tmp/seg0.wav", startTime: 0 },
            { path: "/tmp/seg1.wav", startTime: 3600 },
        ]),
        transcribe: vi.fn(async () => fakeTranscript),
        applyDiarization: vi.fn(async () => fakeDiarizedTranscript),
        getMuxPlaybackId: vi.fn(async () => "mux-playback-id-123"),
        ...overrides,
    };
}

const baseRequest = {
    youtubeUrl: "https://youtube.com/watch?v=abc",
};

describe("createPipeline", () => {
    it("happy path — returns correct shape and calls tasks in order", async () => {
        const deps = createStubDeps();
        const pipeline = createPipeline(deps);
        const onProgress = vi.fn();

        const result = await pipeline(baseRequest, onProgress);

        expect(result).toEqual({
            videoUrl: "https://cdn.example.com/video.mp4",
            audioUrl: "https://cdn.example.com/audio-0.wav",
            muxPlaybackId: "mux-playback-id-123",
            transcript: fakeDiarizedTranscript,
        });

        // All deps called
        expect(deps.downloadYTV).toHaveBeenCalledOnce();
        expect(deps.diarize).toHaveBeenCalledOnce();
        expect(deps.splitAudioDiarization).toHaveBeenCalledOnce();
        expect(deps.transcribe).toHaveBeenCalledOnce();
        expect(deps.applyDiarization).toHaveBeenCalledOnce();
        expect(deps.getMuxPlaybackId).toHaveBeenCalledOnce();
        // uploadToSpaces called 3 times: audio, video, audio segments
        expect(deps.uploadToSpaces).toHaveBeenCalledTimes(3);
    });

    it("CDN URL skip — uploadToSpaces is NOT called for video", async () => {
        const deps = createStubDeps({
            downloadYTV: vi.fn(async () => ({
                audioOnly: "/tmp/audio.wav",
                combined: "/tmp/combined.mp4",
                sourceType: "CDN",
            })),
        });
        const pipeline = createPipeline(deps);
        const onProgress = vi.fn();

        const result = await pipeline(baseRequest, onProgress);

        // Video URL should be the original request URL
        expect(result.videoUrl).toBe(baseRequest.youtubeUrl);

        // uploadToSpaces called only 2 times (audio upload + audio segments), NOT for video
        expect(deps.uploadToSpaces).toHaveBeenCalledTimes(2);
        const calls = vi.mocked(deps.uploadToSpaces).mock.calls;
        const spacePaths = calls.map((c) => c[0].spacesPath);
        expect(spacePaths).not.toContain("council-meeting-videos");
    });

    it("progress stages — onProgress called with expected stage names", async () => {
        const deps = createStubDeps();
        const pipeline = createPipeline(deps);
        const onProgress = vi.fn();

        await pipeline(baseRequest, onProgress);

        // The final "finished" stage is called directly
        expect(onProgress).toHaveBeenCalledWith("finished", 100);
    });

    it("error propagation — when a task throws, the pipeline rejects", async () => {
        const error = new Error("diarization failed");
        const deps = createStubDeps({
            diarize: vi.fn(async () => { throw error; }),
        });
        const pipeline = createPipeline(deps);

        await expect(pipeline(baseRequest, vi.fn())).rejects.toThrow("diarization failed");
    });

    it("data flow — audioUrl from upload flows into diarize", async () => {
        const deps = createStubDeps();
        const pipeline = createPipeline(deps);

        await pipeline(baseRequest, vi.fn());

        // diarize should receive the audioUrl returned by uploadToSpaces
        expect(deps.diarize).toHaveBeenCalledWith(
            expect.objectContaining({ audioUrl: "https://cdn.example.com/audio-0.wav" }),
            expect.any(Function),
        );
    });

    it("data flow — split audio segments are uploaded and passed to transcribe", async () => {
        const deps = createStubDeps();
        const pipeline = createPipeline(deps);

        await pipeline(baseRequest, vi.fn());

        // splitAudioDiarization receives the audioOnly file path and diarization
        expect(deps.splitAudioDiarization).toHaveBeenCalledWith(
            expect.objectContaining({ file: "/tmp/audio.wav", diarization: fakeDiarization }),
            expect.any(Function),
        );

        // transcribe receives segments with URLs from uploadToSpaces — one per segment
        const transcribeArgs = vi.mocked(deps.transcribe).mock.calls[0][0];
        expect(transcribeArgs.segments).toHaveLength(2);
        expect(transcribeArgs.segments).toEqual([
            { url: "https://cdn.example.com/audio-0.wav", start: 0 },
            { url: "https://cdn.example.com/audio-1.wav", start: 3600 },
        ]);
    });
});
