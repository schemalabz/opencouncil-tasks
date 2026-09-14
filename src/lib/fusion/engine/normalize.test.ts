/**
 * The normalizer on the cases a corpus does not contain.
 *
 * Real council speech exercises the normalizer on words people said; what it
 * cannot cover is the input nobody said. These vectors come from asking a
 * reviewer what would break the normalizer, and their expected values were
 * recorded when the behaviour was frozen, not guessed by the reviewer.
 *
 * All synthetic — invented words, no transcript text — so this file lives in
 * git.
 *
 * The pair worth knowing about: `ΟΣ-Α` normalizes to `ος-α` and `ΟΣ'Α` to
 * `οσ'α`. A hyphen ends the word so the sigma is final, an apostrophe does not.
 * A port that split into words before lowercasing gets `ος` in both and looks
 * right on every example anyone would think to try by hand.
 */
import { describe, it, expect } from "vitest";
import vectors from "./normalize.vectors.json";
import { norm, wtoks, tokenizeWords } from "./normalize.js";

describe("normalize on the edges", () => {
    it("has vectors", () => {
        expect(vectors.cases.length).toBeGreaterThan(50);
    });

    it.each(vectors.cases.map((c, n) => [n, c] as const))(
        "case %i normalizes as the Python does",
        (_n, c) => {
            expect(norm(c.input)).toBe(c.norm);
            expect(wtoks(c.input)).toEqual(c.wtoks);
        },
    );

    it.each(vectors.tokenize.map((c, n) => [n, c] as const))(
        "tokenize case %i keeps the same owner map",
        (_n, c) => {
            const { tokens, owner } = tokenizeWords(c.raws);
            expect(tokens).toEqual(c.tokens);
            expect(owner).toEqual(c.owner);
        },
    );
});
