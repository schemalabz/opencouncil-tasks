/**
 * The 391-window route gate scorer, ported from `tests/fusion/route_gate_score.py`.
 *
 * One thing had to change in the port, and it is the important one. The Python
 * scorer built its oracle by re-fusing every window itself, which was
 * independent evidence precisely because the thing under test was a different
 * implementation. In TypeScript that same design would have the scorer check
 * the engine against itself and always agree.
 *
 * So the oracle here is a frozen observation instead: the output the Python
 * produced at the production chunking config, dumped once by
 * `tests/fusion/oracle_dump.py --chunking production` and compared by hash. The
 * gate keeps its meaning -- did the HTTP path produce what the measured engine
 * produces -- and stops depending on the engine being able to answer for itself.
 *
 * Nothing else moved: the same checks in the same order, the same output keys,
 * the same `DELTA_GATE`, the same truncation to ten.
 */
import { sdi, wtoks } from "../lib/fusion/engine/normalize.js";
import { pyJsonDumps } from "../lib/fusion/engine/pyjson.js";
import crypto from "crypto";

/**
 * Declared in the spec before the chunked system was measured. Do not widen it
 * to make a run pass: the number is the finding.
 */
export const DELTA_GATE = 0.002;

export interface GateRow { id: string; text: string }
export interface GateWindow { id: string; ref: string[]; hyps: string[][] }
export interface GateExpected { id: string; tokens: string[]; sidn: [number, number, number, number] }

export interface GateSources {
    /** `fixture_inputs_391.json` windows, by id. */
    inputs: Record<string, GateWindow>;
    /** `fixture_rules_on_391.json` windows, by id: the frozen unchunked text. */
    expected: Record<string, GateExpected>;
    /** `MANIFEST.json`: frozen totals and window count. */
    manifest: { n_windows: number; totals: Record<string, [number, number, number, number]> };
    /** Token list the Python produced at the production chunking, by id. */
    oracle: Record<string, string[]>;
}

/**
 * `toks_sha` hashed `json.dumps(list, ensure_ascii=False)`, whose separators
 * carry a space. `JSON.stringify` does not, and every sha in every gate record
 * would differ for a reason that has nothing to do with the transcript.
 */
export function toksSha(tokens: readonly string[]): string {
    return crypto.createHash("sha256").update(pyJsonDumps(tokens, false), "utf8").digest("hex").slice(0, 16);
}

export interface GateReport {
    ok: boolean;
    n_results: number;
    n_expected: number;
    sidn: [number, number, number, number];
    wer: number | null;
    frozen_sidn: [number, number, number, number];
    frozen_wer: number | null;
    delta_wer: number | null;
    delta_gate: number;
    n_hard_mismatches: number;
    hard_mismatches: Record<string, unknown>[];
    n_chunking_divergences: number;
    chunking_divergences: Record<string, unknown>[];
    total_extra_errors: number;
    largest_window_share_of_net_delta: number | null;
    missing_ids: string[];
    unexpected_ids: string[];
    duplicate_ids: string[];
    /** Absent from the Python, which re-fused instead of reading a dump. */
    oracle_gaps?: string[];
}

const round5 = (x: number) => Math.round(x * 1e5) / 1e5;
const round3 = (x: number) => Math.round(x * 1e3) / 1e3;

export function scoreRouteGate(results: readonly GateRow[], src: GateSources): GateReport {
    const { inputs, expected, manifest, oracle } = src;

    const hardMismatches: Record<string, unknown>[] = [];
    const chunkingDivergences: Record<string, unknown>[] = [];
    let total: [number, number, number, number] = [0, 0, 0, 0];
    let frozenTotal: [number, number, number, number] = [0, 0, 0, 0];

    // Coverage is a set question, not a count. 391 rows summing to the frozen
    // totals can still be one window submitted twice and another dropped, when
    // the two happen to carry the same [S,D,I,N].
    const submitted = results.map((r) => r.id);
    const seen = new Map<string, number>();
    for (const id of submitted) seen.set(id, (seen.get(id) ?? 0) + 1);
    const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id).sort();

    const scored = results.filter((r) => r.id in expected && r.id in inputs);
    const unexpected = [...new Set(submitted.filter((id) => !(id in expected) || !(id in inputs)))].sort();
    const missing = Object.keys(expected).filter((id) => !seen.has(id)).sort();
    const oracleGaps = scored.filter((r) => !(r.id in oracle)).map((r) => r.id).sort();

    for (const row of scored) {
        const wid = row.id;
        const want = expected[wid].tokens;
        const got = wtoks(row.text);
        const produced = oracle[wid];

        if (produced === undefined) {
            // No frozen answer for this window: the gate cannot say whether the
            // text is right, and silence would read as a pass.
            hardMismatches.push({ id: wid, want_sha: null, got_sha: toksSha(got), want_n: null, got_n: got.length, equals_frozen: row.text === want.join(" ") });
        } else if (row.text !== produced.join(" ")) {
            // The measured engine at the production config did not produce this
            // text. The path under test invented it, whatever it happens to equal.
            hardMismatches.push({
                id: wid,
                want_sha: toksSha(produced),
                got_sha: toksSha(got),
                want_n: produced.length,
                got_n: got.length,
                equals_frozen: row.text === want.join(" "),
            });
        } else if (produced.join(" ") !== want.join(" ")) {
            const { s: cs, d: cd, i: ci } = sdi(inputs[wid].ref.join(" "), produced.join(" "));
            const [fs_, fd_, fi_] = expected[wid].sidn;
            chunkingDivergences.push({
                id: wid,
                frozen_n: want.length,
                produced_n: produced.length,
                frozen_sha: toksSha(want),
                produced_sha: toksSha(produced),
                extra_errors: (cs + cd + ci) - (fs_ + fd_ + fi_),
            });
        }

        const { s, d, i, nRef } = sdi(inputs[wid].ref.join(" "), got.join(" "));
        total = [total[0] + s, total[1] + d, total[2] + i, total[3] + nRef];
        const [fs, fd, fi, fn] = expected[wid].sidn;
        frozenTotal = [frozenTotal[0] + fs, frozenTotal[1] + fd, frozenTotal[2] + fi, frozenTotal[3] + fn];
    }

    const frozen = manifest.totals.rules_on;
    const nWindows = manifest.n_windows;
    const wer = (t: readonly number[]) => (t[3] ? (t[0] + t[1] + t[2]) / t[3] : null);

    const delta = total[3] && frozenTotal[3] ? (wer(total) as number) - (wer(frozenTotal) as number) : null;

    // One window supplying the whole delta is a different finding from the same
    // delta spread over 391, and this project has been burned by not looking.
    const extra = chunkingDivergences.map((d) => d.extra_errors as number);
    const totalExtra = extra.reduce((a, b) => a + b, 0);
    const dominance = totalExtra ? round3(Math.max(...extra) / totalExtra) : null;

    const ok = hardMismatches.length === 0
        && missing.length === 0
        && unexpected.length === 0
        && duplicates.length === 0
        && oracleGaps.length === 0
        && results.length === nWindows
        && JSON.stringify(frozenTotal) === JSON.stringify(frozen)
        && delta !== null && Math.abs(delta) <= DELTA_GATE;

    return {
        ok,
        n_results: results.length,
        n_expected: nWindows,
        sidn: total,
        wer: total[3] ? round5(wer(total) as number) : null,
        frozen_sidn: frozen,
        frozen_wer: frozenTotal[3] ? round5(wer(frozenTotal) as number) : null,
        delta_wer: delta !== null ? round5(delta) : null,
        delta_gate: DELTA_GATE,
        n_hard_mismatches: hardMismatches.length,
        hard_mismatches: hardMismatches.slice(0, 10),
        // Windows where the engine at max_tokens=120 reproduced the HTTP text
        // exactly but the frozen unchunked fixture did not. Expected, priced,
        // and listed by id so the count can never quietly grow.
        n_chunking_divergences: chunkingDivergences.length,
        chunking_divergences: chunkingDivergences.slice(0, 10),
        total_extra_errors: totalExtra,
        // Can exceed 1.0: one window can supply more than the NET delta when
        // another offsets it. That is the point of reporting it.
        largest_window_share_of_net_delta: dominance,
        missing_ids: missing.slice(0, 10),
        unexpected_ids: unexpected.slice(0, 10),
        duplicate_ids: duplicates.slice(0, 10),
        ...(oracleGaps.length ? { oracle_gaps: oracleGaps.slice(0, 10) } : {}),
    };
}
