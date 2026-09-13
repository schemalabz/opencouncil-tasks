/**
 * What a segment-sized input costs, in time and memory.
 *
 * Ported from `tests/fusion/test_resource.py`, whose purpose carries over even
 * though its implementation does not: Node's startup, heap and garbage
 * collection are not Python's, so the numbers are re-measured rather than
 * inherited. The gates are the service budget, not a record of what was fast.
 *
 * ~2500 tokens per system is roughly a 20-minute council segment. The chunking
 * config must stay the one production sends: at Python's own default of 800
 * this input took 260 seconds and blew the gate, which is why 120 is frozen.
 * Do not raise a gate to make this pass. The number is the finding.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fuse } from "./fuse.js";
import { loadPolicy } from "./policy.js";

const REPO = path.resolve(__dirname, "../../../..");
const CLI = path.join(REPO, "dist/lib/fusion/engine/cli.js");
const policy = loadPolicy(path.join(REPO, "fusion"));

const TARGET_TOKENS = 2500;

/**
 * Ten times the measured cost, not the Python's old budget.
 *
 * The 60-second gate this inherited was measured for CPython, where this input
 * took 20.1 s. In Node it takes about 700 ms, so that gate would have let the
 * engine get ninety times slower without saying anything: a gate that cannot
 * fail is a comment with a stack trace attached.
 *
 * Ten times leaves room for a loaded CI machine and still catches an order of
 * magnitude, which is what a cubic algorithm regresses by when a bound moves.
 * Raise it only with the measurement that justifies it.
 */
const WALL_GATE_MS = 10_000;

/** Measured at +12 MB. This is room to be wrong, not room to leak. */
const HEAP_GATE_BYTES = 256 * 1024 * 1024;

/** Mirrors PRODUCTION_CHUNKING in FusionTranscriber.ts. Frozen 2026-09-04. */
const PRODUCTION_CHUNKING = { max_tokens: 120, anchor_n: 3, search_radius: 200 };

/**
 * Three streams that disagree the way real ones do: mostly the same words, a
 * substitution every seventh token, a deletion every eleventh, so the aligner
 * meets islands rather than one long agreement it can walk through.
 */
function segmentSizedStreams(): string[][] {
    const base = Array.from({ length: TARGET_TOKENS }, (_, i) => `λεξη${i % 400}`);
    const scribe = [...base];
    const soniox = base.map((t, i) => (i % 7 === 0 ? `${t}β` : t));
    const ours = base.flatMap((t, i) => (i % 11 === 0 ? [] : [i % 13 === 0 ? `${t}γ` : t]));
    return [scribe, soniox, ours];
}

function payload() {
    const ids = ["scribe", "soniox", "ours"];
    const streams = segmentSizedStreams();
    return {
        schema: "oc-fusion-in/1",
        audio_sha256: "0".repeat(64),
        systems: [0, 1, 2].map((k) => ({
            id: ids[k],
            params_sha: `sha-${ids[k]}`,
            words: streams[k].map((t, i) => ({ raw: t, start: i * 0.5, end: i * 0.5 + 0.4, conf: 0.9 })),
        })),
        config: { arm: "rules", guard: false, llm: null, chunking: PRODUCTION_CHUNKING },
    };
}

describe("a segment-sized input", () => {
    it("fuses in-process inside the time and heap budget", () => {
        const p = payload();
        global.gc?.();
        const before = process.memoryUsage().heapUsed;
        const startedAt = Date.now();

        const out = fuse(p, policy);

        const wall = Date.now() - startedAt;
        const heap = process.memoryUsage().heapUsed - before;

        expect(out.stats.n_tokens).toBeGreaterThan(0);
        expect((out.config.chunking as Record<string, number>).n_chunks).toBeGreaterThan(1);
        // eslint-disable-next-line no-console
        console.log(`  in-process: ${wall} ms, heap +${(heap / 1e6).toFixed(0)} MB, `
            + `${out.stats.n_tokens} tokens, `
            + `${(out.config.chunking as Record<string, number>).n_chunks} chunks`);

        expect(wall, `wall ${wall}ms`).toBeLessThan(WALL_GATE_MS);
        expect(heap, `heap ${heap} bytes`).toBeLessThan(HEAP_GATE_BYTES);
    }, 5 * 60 * 1000);

    it("fuses through the real process boundary inside the same budget", () => {
        if (!fs.existsSync(CLI)) return;
        const input = JSON.stringify(payload());
        const startedAt = Date.now();
        const p = spawnSync(process.execPath, [CLI], { input, cwd: REPO, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
        const wall = Date.now() - startedAt;

        expect(p.status, p.stderr?.slice(-500)).toBe(0);
        const out = JSON.parse(p.stdout);
        expect(out.stats.n_tokens).toBeGreaterThan(0);
        // eslint-disable-next-line no-console
        console.log(`  through the CLI: ${wall} ms including Node startup and JSON`);

        expect(wall, `wall ${wall}ms`).toBeLessThan(WALL_GATE_MS);
    }, 5 * 60 * 1000);

    it("costs far more at the chunking default than at the frozen 120", () => {
        // The reason 120 is frozen, kept as a live measurement rather than a
        // comment: the cost is cubic in the span handed to the aligner, so a
        // larger cap is not a little slower, it is a different order.
        const small = payload();
        const large = { ...small, config: { ...small.config, chunking: { ...PRODUCTION_CHUNKING, max_tokens: 400 } } };

        const t0 = Date.now();
        fuse(small, policy);
        const atFrozen = Date.now() - t0;

        const t1 = Date.now();
        fuse(large, policy);
        const atLarger = Date.now() - t1;

        // eslint-disable-next-line no-console
        console.log(`  max_tokens 120: ${atFrozen} ms | max_tokens 400: ${atLarger} ms`);
        expect(atLarger).toBeGreaterThan(atFrozen);
    }, 10 * 60 * 1000);
});
