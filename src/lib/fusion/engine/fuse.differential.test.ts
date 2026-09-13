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
import { describe, it, expect, beforeAll } from "vitest";
import path from "path";
import { fuse } from "./fuse.js";
import { loadPolicy } from "./policy.js";
import {
    CORPUS_WINDOWS, INPUTS_FILE, ORACLES, type FixtureWindow,
    gateFor, loadInputs, read, readIndex, verifyAgainstIndex,
} from "./fixtures.js";

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

interface OracleIndex {
    arm: string;
    chunking?: string;
    windows: number;
    engine_revision: string;
    per_window_sha256: Record<string, string>;
}

interface OracleDump {
    arm: string;
    chunking?: string;
    engine_revision: string;
    outputs: Record<string, unknown>;
}

/**
 * Every oracle the migration was accepted against, named rather than globbed.
 * The chunking config is the point: the conformance totals were measured at one
 * chunk per window, and production sends `max_tokens=120`, which is a different
 * path through the chunker. Globbing the bundle meant a bundle holding only the
 * single-chunk dump still passed — it just stopped checking the path that runs.
 */
const gate = gateFor([INPUTS_FILE, ...ORACLES.map((o) => o.file)]);
const suite = gate.ready ? describe : describe.skip;

suite.each([...ORACLES])("$label: the engine reproduces the Python output", ({ file, index }) => {
    // The window list comes from the committed index, not from the dump. Read
    // off the dump, a short dump tested only the windows it happened to carry
    // and still reported success. The index is in git and cannot drift without
    // someone editing it in a diff.
    const idx = readIndex<OracleIndex>(index);
    const ALL_IDS = Object.keys(idx.per_window_sha256);
    const arm = idx.arm;
    const chunking = idx.chunking ?? "single";

    let dump: OracleDump;
    let byId: Map<string, FixtureWindow>;
    let policy: ReturnType<typeof loadPolicy>;

    beforeAll(() => {
        verifyAgainstIndex(file, index);
        dump = read<OracleDump>(file);
        byId = new Map(loadInputs().map((w) => [w.id, w]));
        policy = loadPolicy(ENGINE_DIR);
    });

    it("covers the corpus its index pins, at the configuration it names", () => {
        expect(idx.windows).toBe(CORPUS_WINDOWS);
        expect(new Set(ALL_IDS).size).toBe(CORPUS_WINDOWS);
        // The dump has to agree with the index about what it is. Otherwise the
        // comparison below runs the engine in one configuration and checks it
        // against output frozen in another.
        expect(dump.arm).toBe(arm);
        expect(dump.chunking ?? "single").toBe(chunking);
        expect(dump.engine_revision).toBe(idx.engine_revision);
        expect(Object.keys(dump.outputs).sort()).toEqual([...ALL_IDS].sort());
        expect(ALL_IDS.filter((id) => !byId.has(id))).toEqual([]);
    });

    // Split into batches for two reasons. One test that runs the whole corpus
    // holds the event loop for a minute and a half, long enough that the worker
    // stops answering the reporter and vitest reports an RPC timeout that has
    // nothing to do with the comparison. And a failure names a batch instead of
    // the whole corpus.
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
