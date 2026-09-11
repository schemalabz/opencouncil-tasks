/**
 * The aligner against the Python, column by column, on real windows.
 *
 * A wrong tie-break in `align3` returns the same cost with different columns,
 * and the transcript only changes on some inputs. Comparing the text would let
 * that through, so this compares the columns themselves, the pivot, every
 * per-column vote decision and the index map.
 *
 * Regenerate with `python3 tests/fusion/msa_vectors.py [--limit N]`; the
 * vectors hold transcript text and are not in git, so this skips without them.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
    align3, bandFor, columnIndices, columnsCost, compose, consensusPivot,
    type Column,
} from "./msa.js";

const BUNDLE = process.env.FUSION_FIXTURES_DIR
    ?? path.join(os.homedir(), ".cache/oc-public/chooser-2026-08-25");

/** Prefer the largest bundle present, so a full run supersedes a subset. */
function vectorsPath(): string | null {
    if (!fs.existsSync(BUNDLE)) return null;
    const files = fs.readdirSync(BUNDLE)
        .filter((f) => /^msa_vectors_\d+\.json$/.test(f))
        .sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]));
    return files.length ? path.join(BUNDLE, files[0]) : null;
}

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

const file = vectorsPath();
const suite = file ? describe : describe.skip;

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
    const vectors: { windows: number; records: WindowRecord[] } =
        JSON.parse(fs.readFileSync(file!, "utf8"));

    const aligned = new Map<string, Column[]>();
    const columnsOf = (r: WindowRecord): Column[] => {
        let cols = aligned.get(r.id);
        if (!cols) {
            cols = align3(r.hyps[0], r.hyps[1], r.hyps[2], r.band);
            aligned.set(r.id, cols);
        }
        return cols;
    };

    it("has vectors to check against", () => {
        expect(vectors.records.length).toBeGreaterThan(0);
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
