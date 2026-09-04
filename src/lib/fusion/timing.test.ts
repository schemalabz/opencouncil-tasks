import { describe, it, expect } from "vitest";
import { assignTimings, assertTimingInvariants } from "./timing.js";
import { timedWordsToUtterances } from "./utterances.js";
import { FusionEngineError, type FusionToken, type NormalizedWord, type ProviderId, type TimedWord } from "./types.js";

function token(partial: Partial<FusionToken> & { text: string; src: ProviderId; src_word: number }): FusionToken {
    return {
        i: 0,
        norm: partial.text.toLowerCase(),
        col: 0,
        island: null,
        stage: "agree",
        agreement: 1,
        ...partial,
    };
}

const scribeWords = (...spans: [string, number, number][]): NormalizedWord[] =>
    spans.map(([raw, start, end]) => ({ raw, start, end, conf: 0.9 }));

const words = (overrides: Partial<Record<ProviderId, NormalizedWord[]>>): Record<ProviderId, NormalizedWord[]> => ({
    scribe: [], soniox: [], ours: [], ...overrides,
});

describe("assignTimings", () => {
    it("gives a Scribe-sourced token Scribe's own times", () => {
        const result = assignTimings({
            tokens: [token({ text: "Επιτροπή", src: "scribe", src_word: 0 })],
            words: words({ scribe: scribeWords(["Επιτροπή", 1.0, 1.5]) }),
        });
        expect(result.words[0]).toMatchObject({ start: 1.0, end: 1.5, timingSource: "scribe-native", timingEstimated: false });
        expect(result.timingEstimatedRate).toBe(0);
    });

    it("borrows the Scribe times of the same column for an identity disagreement", () => {
        const result = assignTimings({
            tokens: [token({ text: "επιτροπής", src: "soniox", src_word: 0, scribe_word: 0, agreement: 0.67 })],
            words: words({
                scribe: scribeWords(["επιτροπή", 2.0, 2.4]),
                soniox: [{ raw: "επιτροπής", start: 2.01, end: 2.44, conf: 0.44 }],
            }),
        });
        // Measured, not estimated: it is a real Scribe span for this column,
        // just attached to the word that won the column.
        expect(result.words[0]).toMatchObject({ start: 2.0, end: 2.4, timingSource: "scribe-column", timingEstimated: false });
        // provider confidence, not agreement
        expect(result.words[0].confidence).toBe(0.44);
        expect(result.words[0].fusionAgreement).toBe(0.67);
    });

    it("interpolates a short gap proportionally to character length", () => {
        const result = assignTimings({
            tokens: [
                token({ text: "Η", src: "scribe", src_word: 0 }),
                token({ text: "αα", src: "ours", src_word: 0 }),
                token({ text: "αααααα", src: "ours", src_word: 1 }),
                token({ text: "επιτροπή", src: "scribe", src_word: 1 }),
            ],
            words: words({
                scribe: scribeWords(["Η", 0, 1], ["επιτροπή", 2, 3]),
                ours: [{ raw: "αα", start: null, end: null, conf: 0.8 }, { raw: "αααααα", start: null, end: null, conf: 0.8 }],
            }),
        });
        expect(result.words.map((w) => w.timingSource)).toEqual(["scribe-native", "interpolated", "interpolated", "scribe-native"]);
        expect(result.words[1].start).toBeCloseTo(1.0);
        expect(result.words[1].end).toBeCloseTo(1.25); // 2 of 8 characters
        expect(result.words[2].end).toBeCloseTo(2.0);
        expect(result.timingEstimatedRate).toBe(0.5);
    });

    it("glues in 0.05 s steps when the gap is longer than 2 s", () => {
        const result = assignTimings({
            tokens: [
                token({ text: "Η", src: "scribe", src_word: 0 }),
                token({ text: "παρέμβαση", src: "ours", src_word: 0 }),
                token({ text: "επιτροπή", src: "scribe", src_word: 1 }),
            ],
            words: words({
                scribe: scribeWords(["Η", 0, 1], ["επιτροπή", 10, 11]),
                ours: [{ raw: "παρέμβαση", start: null, end: null, conf: 0.7 }],
            }),
        });
        expect(result.words[1]).toMatchObject({ start: 1, timingSource: "unaligned", timingEstimated: true });
        expect(result.words[1].end).toBeCloseTo(1.05);
    });

    it("glues before the first and after the last Scribe word", () => {
        const result = assignTimings({
            tokens: [
                token({ text: "πριν", src: "ours", src_word: 0 }),
                token({ text: "Η", src: "scribe", src_word: 0 }),
                token({ text: "μετά", src: "ours", src_word: 1 }),
            ],
            words: words({
                scribe: scribeWords(["Η", 5, 6]),
                ours: [{ raw: "πριν", start: null, end: null, conf: 0.7 }, { raw: "μετά", start: null, end: null, conf: 0.7 }],
            }),
            segmentDurationSec: 10,
        });
        expect(result.words[0]).toMatchObject({ timingSource: "unaligned" });
        expect(result.words[0].end).toBeCloseTo(5);
        expect(result.words[2].start).toBeCloseTo(6);
        expect(result.words[2].end).toBeCloseTo(6.05);
    });

    it("never places a word before zero or past the segment bound", () => {
        const result = assignTimings({
            tokens: [
                token({ text: "α", src: "ours", src_word: 0 }),
                token({ text: "Η", src: "scribe", src_word: 0 }),
                token({ text: "ω", src: "ours", src_word: 1 }),
            ],
            words: words({
                scribe: scribeWords(["Η", 0, 3]),
                ours: [{ raw: "α", start: null, end: null, conf: 1 }, { raw: "ω", start: null, end: null, conf: 1 }],
            }),
            segmentDurationSec: 3,
        });
        expect(result.words[0].start).toBeGreaterThanOrEqual(0);
        expect(result.words[2].end).toBeLessThanOrEqual(3);
    });

    it("splits one raw word's span across the tokens it normalized into", () => {
        const result = assignTimings({
            tokens: [
                token({ text: "Κ.Κ.Ε", src: "scribe", src_word: 0 }),
                token({ text: "νταξει", src: "scribe", src_word: 0 }),
            ],
            words: words({ scribe: scribeWords(["Κ.Κ.Ε νταξει", 0, 1.2]) }),
        });
        expect(result.words[0].start).toBe(0);
        expect(result.words[1].end).toBe(1.2);
        expect(result.words[1].start).toBeGreaterThan(result.words[0].start);
    });

    it("returns nothing for no tokens, and utterance building survives it", () => {
        const result = assignTimings({ tokens: [], words: words({}) });
        expect(result.words).toEqual([]);
        expect(timedWordsToUtterances(result.words, "el")).toEqual([]);
    });
});

describe("assertTimingInvariants", () => {
    const word = (start: number, end: number): TimedWord => ({
        word: "λ", start, end, confidence: 1, timingSource: "scribe-native", timingEstimated: false,
    });

    it("accepts a monotonic, touching, in-bounds sequence", () => {
        expect(() => assertTimingInvariants([word(0, 1), word(1, 2)], 2)).not.toThrow();
    });

    it("rejects overlap, inversion, and out-of-bounds instead of repairing them", () => {
        expect(() => assertTimingInvariants([word(0, 2), word(1, 3)])).toThrow(FusionEngineError);
        expect(() => assertTimingInvariants([word(2, 1)])).toThrow(FusionEngineError);
        expect(() => assertTimingInvariants([word(0, 5)], 3)).toThrow(FusionEngineError);
        expect(() => assertTimingInvariants([word(-1, 0)])).toThrow(FusionEngineError);
    });

    it("reports a broken invariant as a fusion engine error, so the caller falls back", () => {
        try {
            assertTimingInvariants([word(0, 2), word(1, 3)]);
            expect.unreachable();
        } catch (error) {
            expect(error).toBeInstanceOf(FusionEngineError);
            expect((error as FusionEngineError).reason).toBe("timing_invariant");
        }
    });
});

describe("timedWordsToUtterances", () => {
    const word = (text: string, start: number, end: number): TimedWord => ({
        word: text, start, end, confidence: 0.9, fusionAgreement: 1, timingSource: "scribe-native", timingEstimated: false,
    });

    it("splits at sentence punctuation and long pauses, and carries fusion fields through", () => {
        const utterances = timedWordsToUtterances([
            word("Καλησπέρα.", 0, 1),
            word("Ξεκινάμε", 1.1, 1.5),
            word("τώρα", 5, 5.4),
        ], "el");

        expect(utterances).toHaveLength(3);
        expect(utterances[0].text).toBe("Καλησπέρα.");
        expect(utterances[2].text).toBe("τώρα");
        expect(utterances[0].words[0].fusionAgreement).toBe(1);
        expect(utterances[0].confidence).toBeCloseTo(0.9);
    });
});
