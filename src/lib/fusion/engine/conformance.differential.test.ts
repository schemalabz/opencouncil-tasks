/**
 * The frozen contract totals, reproduced by the TypeScript engine.
 *
 * Ported from `tests/fusion/test_conformance.py`. This is the end of the chain:
 * every published number about this fusion is a function of these four
 * integers per arm, summed over all 391 benchmark windows. If the port changed
 * anything that reaches the transcript, they move.
 *
 * They are counts, not a WER with a tolerance. There is no budget here: the
 * substitutions, deletions, insertions and reference length must come out at
 * exactly the values in `fusion/CONTRACT.md`.
 *
 * Needs the fixture bundle, so it skips without one. Regenerate nothing to
 * make it pass; the numbers are the specification.
 */
import { describe, it, expect, beforeAll } from "vitest";
import path from "path";
import { fuse } from "./fuse.js";
import { loadPolicy } from "./policy.js";
import { sdi, wtoks } from "./normalize.js";
import { CORPUS_WINDOWS, INPUTS_FILE, type FixtureWindow, gateFor, loadInputs } from "./fixtures.js";

const ENGINE_DIR = path.resolve(__dirname, "../../../../fusion");

const ARMS = ["W", "rules_off", "rules_on"] as const;
type Arm = (typeof ARMS)[number];

const ARM_CONFIG: Record<Arm, { arm: string; guard: boolean }> = {
    W: { arm: "W", guard: false },
    rules_off: { arm: "rules", guard: false },
    rules_on: { arm: "rules", guard: true },
};
const SINGLE_CHUNK = { max_tokens: 100000, anchor_n: 3, search_radius: 200 };
const SYSTEM_IDS = ["scribe", "soniox", "ours"] as const;

/** From `fusion/CONTRACT.md`: [S, D, I, N_ref]. */
const CONTRACT_TOTALS: Record<Arm, [number, number, number, number]> = {
    W: [5396, 1332, 6577, 110694],
    rules_off: [5030, 1865, 5452, 110694],
    rules_on: [5036, 1848, 5519, 110694],
};

function payloadFor(hyps: readonly (readonly string[])[], arm: Arm) {
    return {
        schema: "oc-fusion-in/1",
        audio_sha256: "0".repeat(64),
        systems: [0, 1, 2].map((k) => ({
            id: SYSTEM_IDS[k],
            params_sha: `sha-${SYSTEM_IDS[k]}`,
            words: hyps[k].map((t, i) => ({ raw: t, start: i * 0.5, end: i * 0.5 + 0.4, conf: 0.9 })),
        })),
        config: { ...ARM_CONFIG[arm], llm: null, chunking: { ...SINGLE_CHUNK } },
    };
}

const gate = gateFor([INPUTS_FILE]);
const suite = gate.ready ? describe : describe.skip;

suite("the frozen contract totals", () => {
    // Loaded in a hook, not here: `describe.skip` still runs this callback, so a
    // read at suite scope crashed collection instead of skipping.
    let windows: FixtureWindow[];
    let policy: ReturnType<typeof loadPolicy>;

    beforeAll(() => {
        windows = loadInputs();
        policy = loadPolicy(ENGINE_DIR);
    });

    it("has all 391 windows", () => {
        expect(windows.length).toBe(CORPUS_WINDOWS);
    });

    it("holds fixture tokens that are already atomic", () => {
        // Every fixture token must normalize to itself, or the reference and
        // the hypotheses are not being counted in the same units.
        for (const w of windows) {
            for (const h of w.hyps) {
                for (const t of h) {
                    expect(wtoks(t), `${w.id}: ${JSON.stringify(t)}`).toEqual([t]);
                }
            }
        }
    }, 5 * 60 * 1000);

    it.each(ARMS)("reproduces the %s totals exactly", async (arm) => {
        const total = [0, 0, 0, 0];
        for (const w of windows) {
            const out = fuse(payloadFor(w.hyps, arm), policy);
            const hyp = out.tokens.map((t) => t.norm as string).join(" ");
            const ref = Array.isArray(w.ref) ? w.ref.join(" ") : w.ref;
            const { s, d, i, nRef } = sdi(ref, hyp);
            total[0] += s;
            total[1] += d;
            total[2] += i;
            total[3] += nRef;
            // The worker answers the reporter on this event loop; a sweep that
            // never yields reports an RPC timeout instead of a result.
            await new Promise<void>((resolve) => setImmediate(resolve));
        }

        const wer = (total[0] + total[1] + total[2]) / total[3];
        // eslint-disable-next-line no-console
        console.log(`  ${arm}: S=${total[0]} D=${total[1]} I=${total[2]} N=${total[3]} WER=${wer.toFixed(5)}`);

        expect(total).toEqual(CONTRACT_TOTALS[arm]);
    }, 30 * 60 * 1000);
});
