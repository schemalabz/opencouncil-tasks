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

    it("emits one word for a raw word that normalized into several tokens", () => {
        // fuse.py's contract: consecutive tokens sharing (src, src_word) carry
        // the SAME raw text and differ only in `norm`. Emitting one word per
        // token would put "κ.λπ" in the transcript twice.
        const result = assignTimings({
            tokens: [
                token({ text: "αλφα", src: "scribe", src_word: 0 }),
                token({ text: "κ.λπ", norm: "κ", src: "scribe", src_word: 1 }),
                token({ text: "κ.λπ", norm: "λπ", src: "scribe", src_word: 1, agreement: 0.67 }),
                token({ text: "γαμμα", src: "scribe", src_word: 2 }),
            ],
            words: words({ scribe: scribeWords(["αλφα", 0, 0.4], ["κ.λπ", 0.5, 1.2], ["γαμμα", 1.3, 1.8]) }),
        });
        expect(result.words.map((w) => w.word)).toEqual(["αλφα", "κ.λπ", "γαμμα"]);
        // The collapsed word keeps the whole span of its Scribe word...
        expect(result.words[1]).toMatchObject({ start: 0.5, end: 1.2, timingSource: "scribe-native" });
        // ...and the most cautious agreement of the tokens it covers.
        expect(result.words[1].fusionAgreement).toBe(0.67);
    });

    it("does not merge two different words that share one Scribe column", () => {
        // Same anchor index, different src_word: two real words, not one raw
        // word split in two. They must stay separate.
        const result = assignTimings({
            tokens: [
                token({ text: "της", src: "ours", src_word: 0, scribe_word: 0 }),
                token({ text: "επιτροπής", src: "ours", src_word: 1, scribe_word: 0 }),
            ],
            words: words({
                scribe: scribeWords(["επιτροπή", 2.0, 2.8]),
                ours: [{ raw: "της", start: 2.0, end: 2.3, conf: 0.8 },
                       { raw: "επιτροπής", start: 2.3, end: 2.8, conf: 0.8 }],
            }),
        });
        expect(result.words.map((w) => w.word)).toEqual(["της", "επιτροπής"]);
        expect(result.words[0].start).toBe(2.0);
        expect(result.words[1].end).toBe(2.8);
    });

    it("returns nothing for no tokens, and utterance building survives it", () => {
        const result = assignTimings({ tokens: [], words: words({}) });
        expect(result.words).toEqual([]);
        expect(timedWordsToUtterances(result.words, "el")).toEqual([]);
    });
});

    it("keeps one Scribe word's span whole when an unanchored token splits it", () => {
        // The shape that broke three of 250 benchmark windows on 2026-09-08.
        // Two tokens anchor to the SAME Scribe word with an unanchored token
        // between them. Grouping only consecutive tokens handed that word's span
        // out twice, so the second copy started before the first one ended and
        // the timeline jumped backwards by the width of the word.
        const result = assignTimings({
            tokens: [
                token({ text: "συνεδρίαση", src: "scribe", src_word: 1 }),
                token({ text: "ε", src: "ours", src_word: 0, agreement: 0.34 }),
                token({ text: "συνεδρίαση", src: "scribe", src_word: 1 }),
                token({ text: "λήγει", src: "scribe", src_word: 2 }),
            ],
            words: words({
                scribe: scribeWords(["πρώτη", 20.0, 25.979], ["συνεδρίαση", 25.979, 28.099], ["λήγει", 28.899, 29.079]),
                ours: [{ raw: "ε", start: 27.0, end: 27.1, conf: 0.3 }],
            }),
        });

        const starts = result.words.map((w) => w.start);
        const ends = result.words.map((w) => w.end);
        for (let i = 1; i < starts.length; i++) {
            expect(starts[i], `word ${i} starts before word ${i - 1} ends`).toBeGreaterThanOrEqual(ends[i - 1] - 1e-9);
        }
        // All three sit inside the one Scribe word they share.
        expect(starts[0]).toBeCloseTo(25.979, 3);
        expect(ends[2]).toBeCloseTo(28.099, 3);
        expect(result.words[3]).toMatchObject({ start: 28.899, timingSource: "scribe-native" });
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
