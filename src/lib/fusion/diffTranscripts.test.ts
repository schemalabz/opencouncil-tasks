import { describe, it, expect } from "vitest";
import { diffTranscripts, normalizeForDiff, formatTranscriptDiff } from "./diffTranscripts.js";
import type { Transcript, Word } from "../../types.js";

/**
 * What this tool measures is *agreement with what production published*, not
 * fidelity to the audio. Neither side is a human reference, so the tests fix
 * the alignment policy and the counts — and the one place where a naive
 * implementation lies, which is an utterance boundary moving.
 *
 * All words synthetic.
 */

const word = (text: string, start: number): Word => ({ word: text, start, end: start + 0.4, confidence: 0.9 });

function transcript(utterances: string[][], startAt = 0): Transcript {
    let t = startAt;
    const built = utterances.map((texts, u) => {
        const words = texts.map((text) => word(text, (t += 0.5)));
        return {
            text: texts.join(" "),
            language: "el",
            start: words[0]?.start ?? 0,
            end: words[words.length - 1]?.end ?? 0,
            confidence: 0.9,
            minWordConfidence: 0.9,
            totalConfidence: 0.9,
            channel: 0,
            speaker: u % 2,
            drift: 0,
            words,
        };
    });
    return {
        metadata: { audio_duration: t + 1, number_of_distinct_channels: 1, billing_time: 0, transcription_time: 0 },
        transcription: {
            languages: ["el"],
            full_transcript: utterances.flat().join(" "),
            utterances: built,
        },
    };
}

const ALPHA = [["Ζορμπαλάς", "μιλάει", "για", "τη", "στάθμευση"]];

describe("normalizeForDiff", () => {
    it("folds case, strips punctuation, and normalizes accents to NFC", () => {
        expect(normalizeForDiff("Ζορμπαλάς,")).toBe(normalizeForDiff("ζορμπαλάς"));
        expect(normalizeForDiff("«στάθμευση»")).toBe("στάθμευση");
        expect(normalizeForDiff("  ")).toBe("");
    });
});

describe("diffTranscripts", () => {
    it("reports no change for identical transcripts", () => {
        const result = diffTranscripts(transcript(ALPHA), transcript(ALPHA));
        expect(result.substitutions).toBe(0);
        expect(result.insertions).toBe(0);
        expect(result.deletions).toBe(0);
        expect(result.matched).toBe(5);
        expect(result.changes).toEqual([]);
        expect(result.agreementRate).toBe(1);
    });

    it("counts a substitution once and names both sides", () => {
        const result = diffTranscripts(
            transcript([["Ζορμπαλάς", "μιλάει", "για", "τη", "στάθμευση"]]),
            transcript([["Ζορμπαλάς", "μιλάει", "για", "τη", "στάθμιση"]]),
        );
        expect(result.substitutions).toBe(1);
        expect(result.insertions).toBe(0);
        expect(result.deletions).toBe(0);
        expect(result.changes).toHaveLength(1);
        expect(result.changes[0]).toMatchObject({ kind: "substitution", left: "στάθμευση", right: "στάθμιση" });
        expect(typeof result.changes[0].at).toBe("number");
    });

    it("counts an insertion on the left side", () => {
        const result = diffTranscripts(
            transcript([["Ζορμπαλάς", "μιλάει", "τώρα", "για", "τη", "στάθμευση"]]),
            transcript([["Ζορμπαλάς", "μιλάει", "για", "τη", "στάθμευση"]]),
        );
        expect(result.insertions).toBe(1);
        expect(result.substitutions).toBe(0);
        expect(result.deletions).toBe(0);
        expect(result.changes[0]).toMatchObject({ kind: "insertion", left: "τώρα" });
    });

    it("counts a deletion on the left side", () => {
        const result = diffTranscripts(
            transcript([["Ζορμπαλάς", "μιλάει", "για", "τη", "στάθμευση"]]),
            transcript([["Ζορμπαλάς", "μιλάει", "τώρα", "για", "τη", "στάθμευση"]]),
        );
        expect(result.deletions).toBe(1);
        expect(result.changes[0]).toMatchObject({ kind: "deletion", right: "τώρα" });
    });

    it("does not see a change when only the utterance boundary moved", () => {
        // The trap: aligning utterances by time overlap turns one split into a
        // pile of false insertions and deletions. The word sequence is the same.
        const oneUtterance = transcript([["Ζορμπαλάς", "μιλάει", "για", "τη", "στάθμευση"]]);
        const twoUtterances = transcript([["Ζορμπαλάς", "μιλάει"], ["για", "τη", "στάθμευση"]]);

        const result = diffTranscripts(oneUtterance, twoUtterances);
        expect(result.substitutions + result.insertions + result.deletions).toBe(0);
        expect(result.matched).toBe(5);
    });

    it("does not see a change when only casing or punctuation differ", () => {
        const result = diffTranscripts(
            transcript([["Ζορμπαλάς,", "Μιλάει", "για", "τη", "στάθμευση."]]),
            transcript([["ζορμπαλάς", "μιλάει", "για", "τη", "στάθμευση"]]),
        );
        expect(result.substitutions + result.insertions + result.deletions).toBe(0);
        expect(result.matched).toBe(5);
    });

    it("handles a repeated word without collapsing it", () => {
        const result = diffTranscripts(
            transcript([["ναι", "ναι", "ναι"]]),
            transcript([["ναι", "ναι"]]),
        );
        expect(result.insertions).toBe(1);
        expect(result.matched).toBe(2);
    });

    it("handles an empty side on either end", () => {
        const empty = transcript([]);
        const left = diffTranscripts(transcript(ALPHA), empty);
        expect(left.insertions).toBe(5);
        expect(left.matched).toBe(0);
        expect(left.agreementRate).toBe(0);

        const right = diffTranscripts(empty, transcript(ALPHA));
        expect(right.deletions).toBe(5);

        const both = diffTranscripts(empty, empty);
        expect(both.matched).toBe(0);
        // No words on either side is not disagreement, and dividing by zero is
        // not an agreement rate.
        expect(both.agreementRate).toBeNull();
    });

    it("is deterministic across runs", () => {
        const a = transcript([["ένα", "δύο", "τρία", "τέσσερα"]]);
        const b = transcript([["ένα", "δυο", "τρία", "πέντε"]]);
        expect(JSON.stringify(diffTranscripts(a, b))).toBe(JSON.stringify(diffTranscripts(a, b)));
    });

    it("caps the reported changes but never the counts", () => {
        const many = Array.from({ length: 40 }, (_v, i) => `λέξη${i}`);
        const other = Array.from({ length: 40 }, (_v, i) => `άλλη${i}`);
        const result = diffTranscripts(transcript([many]), transcript([other]), { maxChanges: 5 });

        expect(result.substitutions).toBe(40);
        expect(result.changes).toHaveLength(5);
        expect(result.changesTruncated).toBe(true);
    });
});

describe("diffTranscripts on meeting-sized input", () => {
    it("aligns a three-hour meeting without exhausting memory", () => {
        // The trap this guards: a full-meeting transcript is ~25k words per
        // side, and one (n+1)x(m+1) cost table for that is ~2.5 billion cells.
        // The diff has to anchor on the parts the two sides agree on.
        const n = 25_000;
        const leftWords = Array.from({ length: n }, (_v, i) => `λέξη${i}`);
        const rightWords = leftWords.slice();
        // 30 scattered substitutions, 1 insertion, 1 deletion.
        for (let i = 0; i < 30; i++) rightWords[i * 800 + 7] = `άλλη${i}`;
        rightWords.splice(12_345, 0, "παρεμβολή");
        rightWords.splice(20_000, 1);

        const started = Date.now();
        const result = diffTranscripts(transcript([leftWords]), transcript([rightWords]), { maxChanges: 100 });
        expect(Date.now() - started).toBeLessThan(30_000);

        expect(result.leftWords).toBe(n);
        expect(result.substitutions).toBe(30);
        expect(result.deletions).toBe(1);
        expect(result.insertions).toBe(1);
        expect(result.matched).toBe(n - 31);
        expect(result.agreementRate).toBeGreaterThan(0.99);
    }, 60_000);

    it("still gets the counts right when the two sides share no unique anchor", () => {
        // Every token repeats, so patience anchoring finds nothing and the
        // fallback split has to carry it.
        const left = Array.from({ length: 3_000 }, (_v, i) => (i % 2 === 0 ? "ναι" : "όχι"));
        const right = left.slice();
        right[1_500] = "ίσως";

        const result = diffTranscripts(transcript([left]), transcript([right]));
        expect(result.leftWords).toBe(3_000);
        expect(result.substitutions + result.insertions + result.deletions).toBeGreaterThanOrEqual(1);
        expect(result.matched).toBeGreaterThan(2_900);
    }, 60_000);
});

describe("formatTranscriptDiff", () => {
    it("labels the number as agreement, not as accuracy", () => {
        const text = formatTranscriptDiff(diffTranscripts(transcript(ALPHA), transcript(ALPHA)));
        expect(text).toMatch(/agreement/i);
        expect(text).not.toMatch(/\bWER\b|accuracy|better|worse/i);
    });
});
