import { describe, it, expect } from "vitest";
import { foldLine, foldedWithOffsets, levenshtein, normalizeToken, phoneticKey, tokenize } from "./text.js";

describe("normalizeToken", () => {
    it("folds case, accents, final sigma and Latin homoglyphs", () => {
        expect(normalizeToken("Σιαμάvης")).toBe("σιαμανησ");
        expect(normalizeToken("ΠΡΑΚΤIΚΑ")).toBe("πρακτικα");
        expect(normalizeToken("Μεσογείων,")).toBe("μεσογειων");
    });

    it("drops punctuation and equates number words with digits", () => {
        expect(normalizeToken("«Έξυπνες")).toBe("εξυπνεσ");
        expect(normalizeToken("δύο")).toBe("2");
        expect(normalizeToken("2")).toBe("2");
        expect(normalizeToken("…")).toBe("");
    });

    it("equates the honorific with its abbreviation and the elided or movable-ν spellings", () => {
        expect(normalizeToken("κύριος")).toBe(normalizeToken("κ."));
        expect(normalizeToken("κυρία")).toBe(normalizeToken("κα"));
        expect(normalizeToken("κι")).toBe(normalizeToken("και"));
        expect(normalizeToken("τον")).toBe(normalizeToken("το"));
        expect(normalizeToken("στην")).toBe(normalizeToken("στη"));
        expect(normalizeToken("έναν")).toBe("1");
        expect(normalizeToken("ένα")).toBe("1");
    });
});

describe("tokenize", () => {
    it("keeps the position of each word in the whitespace split and skips punctuation-only pieces", () => {
        const tokens = tokenize("Ωραία – ευχαριστώ, κύριε Πρόεδρε.");
        expect(tokens.map(t => t.index)).toEqual([0, 2, 3, 4]);
        expect(tokens.map(t => t.text)).toEqual(["Ωραία", "ευχαριστώ,", "κύριε", "Πρόεδρε."]);
    });
});

describe("foldedWithOffsets", () => {
    it("maps every folded character back to the original and keeps line breaks", () => {
        const original = "  ΠΡΟΕΔΡΟΣ:   Ναι,\n\n κα  Ροή: Παρούσα.";
        const { folded, offsets } = foldedWithOffsets(original);
        expect(folded).toBe("προεδροσ: ναι,\nκα ροη: παρουσα.");
        const at = folded.indexOf("κα ροη");
        expect(folded[at - 1]).toBe("\n");
        expect(original.slice(offsets[at], offsets[at] + 2)).toBe("κα");
    });
});

describe("foldLine", () => {
    it("collapses whitespace", () => {
        expect(foldLine("  Το   Δ.Σ. αφού πήρε υπόψη ")).toBe("το δ.σ. αφου πηρε υποψη");
    });
});

describe("phoneticKey", () => {
    it("gives a misheard word and the right word the same key", () => {
        expect(phoneticKey("Μεσόγειον")).toBe(phoneticKey("Μεσογείων"));
        expect(phoneticKey("Θουκιδίδου")).toBe(phoneticKey("Θουκυδίδου"));
    });

    it("keeps different words apart", () => {
        expect(phoneticKey("Ωραία")).not.toBe(phoneticKey("Λοιπόν"));
    });

    it("folds repeated letters once and leaves digits as they are", () => {
        expect(phoneticKey("Μαυρομμάτη")).toBe(phoneticKey("Μαυρομάτη"));
        expect(phoneticKey("3.200.000")).toBe("3200000");
        expect(phoneticKey("3.200.000")).not.toBe(phoneticKey("3.200"));
    });
});

describe("levenshtein", () => {
    it("counts edits between two strings and between two word lists", () => {
        expect(levenshtein("ρημακησ", "δημακησ")).toBe(1);
        expect(levenshtein(["α", "β", "γ"], ["α", "δ", "γ"])).toBe(1);
        expect(levenshtein(["α", "β"], ["α", "β", "γ"])).toBe(1);
        expect(levenshtein([], ["α"])).toBe(1);
    });
});
