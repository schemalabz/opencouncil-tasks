/**
 * The aligner against the Python, column by column, on real windows.
 *
 * A wrong tie-break in `align3` returns the same cost with different columns,
 * and the transcript only changes on some inputs. Comparing the text would let
 * that through, so this compares the columns themselves, the pivot, every
 * per-column vote decision and the index map.
 *
 * Regenerate with `tests/fusion/msa_vectors.py [--limit N]` at the `python-engine-last-known-good` tag; the
 * vectors hold transcript text and are not in git, so this skips without them.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { CORPUS_WINDOWS, gateFor, read, verifyAgainstIndex } from "./fixtures.js";
import {
    align3, bandFor, columnIndices, columnsCost, compose, consensusPivot,
    type Column,
} from "./msa.js";

/**
 * The vectors for the whole corpus, named rather than globbed. Taking whichever
 * `msa_vectors_*.json` happened to be largest meant a bundle carrying a subset
 * still passed, having checked fewer windows than it reported.
 */
const VECTORS = "msa_vectors_391.json";
const INDEX = "MSA_VECTORS_391.json";

interface WindowRecord {
    id: string;
    hyps: [string[], string[], string[]];
    band: number;
    pivot: number;
    cols: Column[];
    cols_cost: number;
    indices: (number | null)[][];
    tokens: string[];
    decisions: { col: number; token: string | null; reason: string }[];
}

const gate = gateFor([VECTORS]);
const suite = gate.ready ? describe : describe.skip;

/** Exact three-way DP is not cheap. Align each window once, assert many times. */
const TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Aligning a window is hundreds of milliseconds of straight-line work, and the
 * vitest worker answers the reporter on the same event loop. A loop over the
 * corpus that never yields blocks it past the RPC timeout, failing a run in
 * which every assertion passed.
 */
const breathe = () => new Promise<void>((resolve) => setImmediate(resolve));

suite("align3 matches the Python engine on real windows", () => {
    // Loaded in a hook, not here: `describe.skip` still runs this callback, so a
    // read at suite scope crashed collection instead of skipping.
    let vectors: { windows: number; records: WindowRecord[] };

    beforeAll(() => {
        verifyAgainstIndex(VECTORS, INDEX);
        vectors = read(VECTORS);
    });

    const aligned = new Map<string, Column[]>();
    const columnsOf = (r: WindowRecord): Column[] => {
        let cols = aligned.get(r.id);
        if (!cols) {
            cols = align3(r.hyps[0], r.hyps[1], r.hyps[2], r.band);
            aligned.set(r.id, cols);
        }
        return cols;
    };

    it("has the whole corpus to check against", () => {
        expect(vectors.windows).toBe(CORPUS_WINDOWS);
        expect(vectors.records.length).toBe(CORPUS_WINDOWS);
    });

    it("sizes the band identically", () => {
        for (const r of vectors.records) {
            expect(bandFor(r.hyps), r.id).toBe(r.band);
        }
    });

    it("picks the same consensus pivot", async () => {
        for (const r of vectors.records) {
            expect(consensusPivot(r.hyps), r.id).toBe(r.pivot);
            await breathe();
        }
    }, TIMEOUT_MS);

    it("produces the same columns, entry for entry", async () => {
        for (const r of vectors.records) {
            const cols = columnsOf(r);
            await breathe();
            expect(cols.length, `${r.id}: column count`).toBe(r.cols.length);
            for (let n = 0; n < cols.length; n++) {
                expect(cols[n], `${r.id}: column ${n}`).toEqual(r.cols[n]);
            }
            expect(columnsCost(cols), `${r.id}: cost`).toBe(r.cols_cost);
        }
    }, TIMEOUT_MS);

    it("maps every column back to the same stream indices", async () => {
        for (const r of vectors.records) {
            expect(columnIndices(columnsOf(r)).map((x) => [...x]), r.id).toEqual(r.indices);
            await breathe();
        }
    }, TIMEOUT_MS);

    it("votes every column the same way, for the same stated reason", async () => {
        for (const r of vectors.records) {
            const { tokens, decisions } = compose(columnsOf(r), r.pivot);
            await breathe();
            expect(tokens, `${r.id}: tokens`).toEqual(r.tokens);
            expect(decisions, `${r.id}: decisions`).toEqual(r.decisions);
        }
    }, TIMEOUT_MS);
});
