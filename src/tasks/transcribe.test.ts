import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Transcript } from "../types.js";

vi.mock("../lib/ScribeTranscribe.js", () => ({
    scribeTranscriber: { transcribe: vi.fn() },
    MAX_TRANSCRIPTION_SEGMENT_DURATION_SECONDS: 900,
}));

import { transcribe } from "./transcribe.js";
import { scribeTranscriber } from "../lib/ScribeTranscribe.js";

const mockTranscribe = vi.mocked(scribeTranscriber.transcribe);

function fakeTranscript(text: string): Transcript {
    return {
        metadata: { audio_duration: 10, number_of_distinct_channels: 1, billing_time: 10, transcription_time: 1 },
        transcription: { languages: ["el"], full_transcript: text, utterances: [] },
    };
}

const segments = [
    { url: "https://cdn.example.com/one.mp3", start: 0 },
    { url: "https://cdn.example.com/two.mp3", start: 900 },
];

describe("transcribe", () => {
    beforeEach(() => {
        mockTranscribe.mockReset();
        vi.spyOn(console, "log").mockImplementation(() => { });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("gives failed segments a second pass instead of failing the pipeline", async () => {
        mockTranscribe
            .mockResolvedValueOnce(fakeTranscript("ένα"))
            .mockRejectedValueOnce(new Error("Scribe API returned 429"))
            .mockResolvedValueOnce(fakeTranscript("δύο"));

        const result = await transcribe({ segments }, () => { });

        expect(mockTranscribe).toHaveBeenCalledTimes(3);
        expect(result.transcription.full_transcript).toContain("ένα");
        expect(result.transcription.full_transcript).toContain("δύο");
    });

    it("rejects audio longer than the segment cap (stale upload guard)", async () => {
        const staleHourLong = fakeTranscript("παλιό περιεχόμενο");
        staleHourLong.metadata.audio_duration = 3600;
        mockTranscribe.mockResolvedValue(staleHourLong);

        await expect(transcribe({ segments: [segments[0]] }, () => { }))
            .rejects.toThrow("does not match this run's segmentation");
    });

    it("fails when a segment still fails on the second pass", async () => {
        mockTranscribe
            .mockResolvedValueOnce(fakeTranscript("ένα"))
            .mockRejectedValueOnce(new Error("Scribe API returned 429"))
            .mockRejectedValueOnce(new Error("Scribe API returned 429"));

        await expect(transcribe({ segments }, () => { })).rejects.toThrow("429");
        expect(mockTranscribe).toHaveBeenCalledTimes(3);
    });
});
