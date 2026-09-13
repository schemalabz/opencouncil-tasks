import { describe, it, expect } from "vitest";
import { OcAsrProvider, normalizeOcAsrWords } from "./ocasr.js";

/**
 * One provider instance serves every concurrent segment. The identity is half
 * the component cache key, so it has to describe the call being made and not
 * whichever call happened to run most recently.
 */
describe("OcAsrProvider identity", () => {
    it("depends on the transport it is given, not on a previous call", () => {
        const provider = new OcAsrProvider();

        const url = provider.identity("url");
        const bytes = provider.identity("bytes");

        expect(url.paramsSha).not.toBe(bytes.paramsSha);
        // Asking again in the other order returns the same answers: nothing
        // about the first call leaked into the second.
        expect(provider.identity("bytes").paramsSha).toBe(bytes.paramsSha);
        expect(provider.identity("url").paramsSha).toBe(url.paramsSha);
    });
});

/**
 * The endpoint has returned all three shapes. They are alternatives, not a
 * precedence chain over nullishness: `words: []` is a shape that carried
 * nothing, not an instruction to stop looking.
 */
describe("normalizeOcAsrWords picks the shape that carries words", () => {
    const utterance = { words: [{ word: "ναι", start: 1, end: 2, prob: 0.9 }] };
    const segment = { words: [{ text: "δεν", start: 3, end: 4, confidence: 0.8 }] };

    it("reads the utterances when `words` is present but empty", () => {
        const got = normalizeOcAsrWords({
            words: [],
            transcription: { utterances: [utterance] },
        });
        expect(got.map((w) => w.raw)).toEqual(["ναι"]);
    });

    it("still falls through to segments when the first two carry nothing", () => {
        const got = normalizeOcAsrWords({
            words: [],
            transcription: { utterances: [] },
            segments: [segment],
        });
        expect(got.map((w) => w.raw)).toEqual(["δεν"]);
    });

    it("prefers `words` when it actually has entries", () => {
        const got = normalizeOcAsrWords({
            words: [{ word: "πρώτο", start: 0, end: 1, prob: 0.7 }],
            transcription: { utterances: [utterance] },
            segments: [segment],
        });
        expect(got.map((w) => w.raw)).toEqual(["πρώτο"]);
    });

    it("returns nothing, rather than throwing, when no shape carries words", () => {
        expect(normalizeOcAsrWords({})).toEqual([]);
    });
});
