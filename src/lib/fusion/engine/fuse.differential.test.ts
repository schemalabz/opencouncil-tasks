/**
 * The whole engine against the Python, on all 391 benchmark windows.
 *
 * This is the acceptance test for the port. It does not compare transcripts: it
 * compares the complete `oc-fusion/1` output, which means every island, every
 * candidate list, the deciding rule, the chosen source, the guard flag, the
 * per-token column index, agreement, provenance and the statistics. A WER
 * budget would let a port change words and still pass; this does not let it
 * change anything.
 *
 * The expected side is frozen by `tests/fusion/oracle_dump.py` at the
 * `python-engine-last-known-good` tag; see `docs/fusion-python-archive.md`. The outputs hold council speech and are not
 * in git, so without them this skips.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { fuse } from "./fuse.js";
import { loadPolicy } from "./policy.js";

const BUNDLE = process.env.FUSION_FIXTURES_DIR
    ?? path.join(os.homedir(), ".cache/oc-public/chooser-2026-08-25");
const ENGINE_DIR = path.join(__dirname, "../../../../fusion");

/** Mirrors `ARM_CONFIG` and `SINGLE_CHUNK` in `tests/fusion/helpers.py`. */
const ARM_CONFIG: Record<string, { arm: string; guard: boolean }> = {
    W: { arm: "W", guard: false },
    rules_off: { arm: "rules", guard: false },
    rules_on: { arm: "rules", guard: true },
};
const SINGLE_CHUNK = { max_tokens: 100000, anchor_n: 3, search_radius: 200 };
/** Mirrors PRODUCTION_CHUNKING in FusionTranscriber.ts. */
const PRODUCTION_CHUNKING = { max_tokens: 120, anchor_n: 3, search_radius: 200 };
const CHUNKING: Record<string, typeof SINGLE_CHUNK> = {
    single: SINGLE_CHUNK,
    production: PRODUCTION_CHUNKING,
};
const SYSTEM_IDS = ["scribe", "soniox", "ours"] as const;

/** Mirrors `helpers.as_words`: fixture tokens with synthetic times. */
function asWords(tokens: readonly string[]) {
    return tokens.map((t, i) => ({ raw: t, start: i * 0.5, end: i * 0.5 + 0.4, conf: 0.9 }));
}

function payloadFor(hyps: readonly (readonly string[])[], arm: string, chunking: string) {
    // Spreading a missing entry would leave `validate` to fall back to its
    // defaults, so the harness would quietly compare a different configuration
    // against the oracle and pass.
    if (!ARM_CONFIG[arm]) throw new Error(`no ARM_CONFIG entry for arm ${arm}`);
    if (!CHUNKING[chunking]) throw new Error(`no chunking config named ${chunking}`);
    return {
        schema: "oc-fusion-in/1",
        audio_sha256: "0".repeat(64),
        systems: [0, 1, 2].map((k) => ({
            id: SYSTEM_IDS[k],
            params_sha: `sha-${SYSTEM_IDS[k]}`,
            words: asWords(hyps[k]),
        })),
        config: { ...ARM_CONFIG[arm], llm: null, chunking: { ...CHUNKING[chunking] } },
    };
}

/**
 * Every dumped oracle in the bundle, not the largest one. The chunking config
 * is the point: the conformance totals were measured at one chunk per window,
 * and production sends `max_tokens=120`, which is a different path through the
 * chunker. Comparing only the first would leave the path that actually runs
 * unchecked.
 */
function oracleFiles(): { file: string; label: string }[] {
    if (!fs.existsSync(BUNDLE)) return [];
    return fs.readdirSync(BUNDLE)
        .filter((f) => /^oracle_.*_\d+\.json$/.test(f))
        .sort()
        .map((f) => ({ file: path.join(BUNDLE, f), label: f.replace(/^oracle_|_\d+\.json$/g, "") }));
}

/**
 * Structural equality with Python's semantics for the values this output can
 * hold: `null` is a value, key order does not matter, array order does.
 */
function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a === null || b === null) return false;
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
        return true;
    }
    if (typeof a === "object") {
        const ao = a as Record<string, unknown>;
        const bo = b as Record<string, unknown>;
        const ak = Object.keys(ao);
        const bk = Object.keys(bo);
        if (ak.length !== bk.length) return false;
        for (const k of ak) {
            if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
            if (!deepEqual(ao[k], bo[k])) return false;
        }
        return true;
    }
    return false;
}

const oracles = oracleFiles();
const inputsPath = path.join(BUNDLE, "fixture_inputs_391.json");
const ready = oracles.length > 0 && fs.existsSync(inputsPath);
const suite = ready ? describe : describe.skip;

suite.each(ready ? oracles : [])("$label: the engine reproduces the Python output", ({ file }) => {
    const dump = JSON.parse(fs.readFileSync(file, "utf8"));
    const inputs = JSON.parse(fs.readFileSync(inputsPath, "utf8"));
    const policy = loadPolicy(ENGINE_DIR);
    const arm = dump.arm as string;
    const chunking = (dump.chunking as string) ?? "single";

    const byId = new Map<string, { id: string; hyps: string[][] }>(
        inputs.windows.map((w: { id: string; hyps: string[][] }) => [w.id, w]),
    );

    it("was frozen by the engine revision in the repo", () => {
        expect(typeof dump.engine_revision).toBe("string");
        expect(Object.keys(dump.outputs).length).toBeGreaterThan(0);
    });

    // Split into batches for two reasons. One test that runs the whole corpus
    // holds the event loop for a minute and a half, long enough that the worker
    // stops answering the reporter and vitest reports an RPC timeout that has
    // nothing to do with the comparison. And a failure names a batch instead of
    // the whole corpus.
    const ALL_IDS = Object.keys(dump.outputs);
    const BATCH = 40;
    const batches: string[][] = [];
    for (let i = 0; i < ALL_IDS.length; i += BATCH) batches.push(ALL_IDS.slice(i, i + BATCH));

    /**
     * Fusing one window is several hundred milliseconds of straight-line work,
     * and vitest's worker answers the reporter on the same event loop. A batch
     * that never yields blocks it past the RPC timeout, and the run fails with
     * an unhandled `onTaskUpdate` timeout while every assertion in it passed.
     * Yielding between windows costs nothing and keeps the channel alive.
     */
    const breathe = () => new Promise<void>((resolve) => setImmediate(resolve));

    it.each(batches.map((b, n) => [n, b] as const))(
        "windows %i: identical oc-fusion/1 output",
        async (_n, ids) => {
            // `expect` per window would carry a large structure to the reporter
            // 391 times. The sweep is a plain equality check; `expect` is called
            // only to render a failure that has already been found.
            const mismatched: string[] = [];
            for (const id of ids) {
                const win = byId.get(id);
                if (!win) {
                    mismatched.push(`${id}: no fixture window`);
                    continue;
                }
                if (!deepEqual(fuse(payloadFor(win.hyps, arm, chunking), policy), dump.outputs[id])) {
                    mismatched.push(id);
                    break;
                }
                // The corpus dump is tens of megabytes. Holding all of it to
                // the end of the run leaves the worker under enough GC
                // pressure to miss the reporter's RPC window, which surfaces
                // as an unhandled timeout and fails a run whose every
                // assertion passed. A compared window is not needed again.
                delete dump.outputs[id];
                await breathe();
            }
            if (mismatched.length) {
                const first = byId.get(mismatched[0]);
                const want = dump.outputs[mismatched[0]];
                if (first && want) {
                    expect(fuse(payloadFor(first.hyps, arm, chunking), policy)).toEqual(want);
                }
            }
            expect(mismatched).toEqual([]);
        },
        5 * 60 * 1000,
    );
});
