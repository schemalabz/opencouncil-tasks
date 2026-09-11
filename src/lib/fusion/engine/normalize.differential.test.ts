/**
 * The normalizer against the Python, over every word the corpus contains.
 *
 * 50,721 distinct raw words, 3,303 full texts and 3,128 reference/hypothesis
 * pairs, taken from the 391-window benchmark report and frozen by
 * `tests/fusion/normalize_vectors.py`. Hand-written examples test what someone
 * thought of; this tests what Greek council speech actually contains.
 *
 * The vectors hold transcript text and are not in git. Regenerate with
 * `python3 tests/fusion/normalize_vectors.py`; without them this skips.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { norm, wtoks, sdi } from "./normalize.js";

const BUNDLE = process.env.FUSION_FIXTURES_DIR
    ?? path.join(os.homedir(), ".cache/oc-public/chooser-2026-08-25");
const VECTORS = path.join(BUNDLE, "normalize_vectors.json");
const INDEX = path.join(__dirname, "../../../../tests/fusion/NORMALIZE_VECTORS.json");

interface Vectors {
    python: string;
    unicodedata: string;
    words: Record<string, [string, string[]]>;
    texts: [string, string[]][];
    /** `[refIndex, hypIndex, S, D, I, N]`, indices into `texts`. */
    sdi: [number, number, number, number, number, number][];
}

const present = fs.existsSync(VECTORS);
const suite = present ? describe : describe.skip;

suite("normalize matches the Python engine on the real corpus", () => {
    const vectors: Vectors = JSON.parse(fs.readFileSync(VECTORS, "utf8"));

    it("agrees with the index committed in the repo", () => {
        const index = JSON.parse(fs.readFileSync(INDEX, "utf8"));
        expect(vectors.python).toBe(index.python);
        expect(Object.keys(vectors.words).length).toBe(index.distinct_words);
        expect(vectors.texts.length).toBe(index.texts);
        expect(vectors.sdi.length).toBe(index.sdi_pairs);
    });

    it("normalizes every distinct raw word identically", () => {
        const mismatches: string[] = [];
        for (const [raw, [expectedNorm]] of Object.entries(vectors.words)) {
            const got = norm(raw);
            if (got !== expectedNorm) {
                mismatches.push(`${JSON.stringify(raw)}: python=${JSON.stringify(expectedNorm)} ts=${JSON.stringify(got)}`);
                if (mismatches.length >= 10) break;
            }
        }
        expect(mismatches).toEqual([]);
    });

    it("tokenizes every distinct raw word identically", () => {
        const mismatches: string[] = [];
        for (const [raw, [, expectedToks]] of Object.entries(vectors.words)) {
            const got = wtoks(raw);
            if (got.length !== expectedToks.length || got.some((t, i) => t !== expectedToks[i])) {
                mismatches.push(`${JSON.stringify(raw)}: python=${JSON.stringify(expectedToks)} ts=${JSON.stringify(got)}`);
                if (mismatches.length >= 10) break;
            }
        }
        expect(mismatches).toEqual([]);
    });

    it("tokenizes every full text identically", () => {
        // Word by word cannot catch a boundary that the whole text would split
        // differently, so the untouched texts run through as well.
        const mismatches: string[] = [];
        for (let n = 0; n < vectors.texts.length; n++) {
            const [text, expectedToks] = vectors.texts[n];
            const got = wtoks(text);
            if (got.length !== expectedToks.length || got.some((t, i) => t !== expectedToks[i])) {
                const at = got.findIndex((t, i) => t !== expectedToks[i]);
                mismatches.push(`text ${n} at token ${at}: python=${JSON.stringify(expectedToks[at])} ts=${JSON.stringify(got[at])}`);
                if (mismatches.length >= 10) break;
            }
        }
        expect(mismatches).toEqual([]);
    });

    it("splits edits the same way on every reference/hypothesis pair", () => {
        // The distance alone would hide a wrong tie-break: the same total with a
        // different S/D/I split. The deletion count is the number this project
        // watches most closely, so it is the one a port must not drift on.
        const mismatches: string[] = [];
        for (const [refIdx, hypIdx, s, d, i, n] of vectors.sdi) {
            const got = sdi(vectors.texts[refIdx][0], vectors.texts[hypIdx][0]);
            if (got.s !== s || got.d !== d || got.i !== i || got.nRef !== n) {
                mismatches.push(`pair ${refIdx}/${hypIdx}: python=S${s} D${d} I${i} N${n} ts=S${got.s} D${got.d} I${got.i} N${got.nRef}`);
                if (mismatches.length >= 10) break;
            }
        }
        expect(mismatches).toEqual([]);
    });
});
