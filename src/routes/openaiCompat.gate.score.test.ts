/**
 * The gate scorer's own tests, on mutated inputs.
 *
 * A scorer that only ever sees a clean run is a scorer nobody has checked. Each
 * case here is a way a gate run can be wrong while looking right: a window
 * submitted twice and another dropped, a row for a window nobody asked for, a
 * text that is not what the measured engine produces, a text that is right for
 * the chunked config and differs from the frozen unchunked fixture.
 *
 * Synthetic throughout, so this runs without the fixture bundle. The 391-window
 * agreement between this scorer and the Python one is a separate check.
 */
import { describe, it, expect } from "vitest";
import { scoreRouteGate, toksSha, DELTA_GATE, type GateSources } from "./openaiCompat.gate.score.js";

/** Three windows, each two tokens, with a reference the hypotheses can miss. */
function sources(): GateSources {
    const ids = ["w1", "w2", "w3"];
    const inputs: GateSources["inputs"] = {};
    const expected: GateSources["expected"] = {};
    const oracle: GateSources["oracle"] = {};
    for (const id of ids) {
        inputs[id] = { id, ref: ["αλφα", "βητα"], hyps: [["αλφα", "βητα"], ["αλφα", "βητα"], ["αλφα", "βητα"]] };
        expected[id] = { id, tokens: ["αλφα", "βητα"], sidn: [0, 0, 0, 2] };
        oracle[id] = ["αλφα", "βητα"];
    }
    return {
        inputs,
        expected,
        oracle,
        manifest: { n_windows: 3, totals: { rules_on: [0, 0, 0, 6] } },
    };
}

const clean = () => [
    { id: "w1", text: "αλφα βητα" },
    { id: "w2", text: "αλφα βητα" },
    { id: "w3", text: "αλφα βητα" },
];

describe("the route gate scorer", () => {
    it("passes a run that is actually clean", () => {
        const r = scoreRouteGate(clean(), sources());
        expect(r.ok).toBe(true);
        expect(r.n_hard_mismatches).toBe(0);
        expect(r.n_chunking_divergences).toBe(0);
        expect(r.sidn).toEqual([0, 0, 0, 6]);
        expect(r.delta_wer).toBe(0);
        expect(r.delta_gate).toBe(DELTA_GATE);
    });

    it("fails a run that submitted one window twice and dropped another", () => {
        // The totals still come out right, which is exactly why counting rows
        // is not enough and coverage is checked as a set.
        const rows = [
            { id: "w1", text: "αλφα βητα" },
            { id: "w1", text: "αλφα βητα" },
            { id: "w2", text: "αλφα βητα" },
        ];
        const r = scoreRouteGate(rows, sources());
        expect(r.ok).toBe(false);
        expect(r.duplicate_ids).toEqual(["w1"]);
        expect(r.missing_ids).toEqual(["w3"]);
        expect(r.n_results).toBe(3);
    });

    it("fails a run carrying a window nobody asked for", () => {
        const rows = [...clean(), { id: "w99", text: "αλφα βητα" }];
        const r = scoreRouteGate(rows, sources());
        expect(r.ok).toBe(false);
        expect(r.unexpected_ids).toEqual(["w99"]);
    });

    it("fails a run that is short, even when every row in it is right", () => {
        const r = scoreRouteGate(clean().slice(0, 2), sources());
        expect(r.ok).toBe(false);
        expect(r.n_results).toBe(2);
        expect(r.n_expected).toBe(3);
        expect(r.missing_ids).toEqual(["w3"]);
    });

    it("fails an empty run rather than reporting nothing wrong", () => {
        const r = scoreRouteGate([], sources());
        expect(r.ok).toBe(false);
        expect(r.missing_ids).toEqual(["w1", "w2", "w3"]);
        expect(r.wer).toBeNull();
    });

    it("calls a text the measured engine did not produce a hard mismatch", () => {
        const rows = clean();
        rows[1] = { id: "w2", text: "αλφα γαμμα" };
        const r = scoreRouteGate(rows, sources());

        expect(r.ok).toBe(false);
        expect(r.n_hard_mismatches).toBe(1);
        const m = r.hard_mismatches[0];
        expect(m.id).toBe("w2");
        expect(m.got_sha).toBe(toksSha(["αλφα", "γαμμα"]));
        expect(m.want_sha).toBe(toksSha(["αλφα", "βητα"]));
        expect(m.equals_frozen).toBe(false);
    });

    it("still calls it a hard mismatch when the wrong text equals the frozen one", () => {
        // The regression this flag exists for: a path that silently fell back
        // to the unchunked fixture text would otherwise look like agreement.
        const src = sources();
        src.oracle.w2 = ["αλφα", "βητα", "γαμμα"];
        const r = scoreRouteGate(clean(), src);

        expect(r.ok).toBe(false);
        expect(r.n_hard_mismatches).toBe(1);
        expect(r.hard_mismatches[0].equals_frozen).toBe(true);
    });

    it("records a chunking divergence without calling it a mismatch", () => {
        // The engine at the production config produced this text, and the
        // frozen unchunked fixture says something else. Expected and priced.
        const src = sources();
        src.oracle.w3 = ["αλφα", "γαμμα"];
        const rows = clean();
        rows[2] = { id: "w3", text: "αλφα γαμμα" };

        const r = scoreRouteGate(rows, src);
        expect(r.n_hard_mismatches).toBe(0);
        expect(r.n_chunking_divergences).toBe(1);
        expect(r.chunking_divergences[0].id).toBe("w3");
        expect(r.chunking_divergences[0].extra_errors).toBe(1);
        expect(r.total_extra_errors).toBe(1);
        expect(r.largest_window_share_of_net_delta).toBe(1);
    });

    it("reports how concentrated the extra errors are", () => {
        const src = sources();
        src.oracle.w2 = ["αλφα", "γαμμα"];
        src.oracle.w3 = ["γαμμα", "δελτα"];
        const rows = [
            { id: "w1", text: "αλφα βητα" },
            { id: "w2", text: "αλφα γαμμα" },
            { id: "w3", text: "γαμμα δελτα" },
        ];
        const r = scoreRouteGate(rows, src);
        expect(r.n_chunking_divergences).toBe(2);
        expect(r.total_extra_errors).toBe(3);
        expect(r.largest_window_share_of_net_delta).toBeCloseTo(2 / 3, 3);
    });

    it("fails when the frozen totals do not add up to the manifest", () => {
        const src = sources();
        src.manifest.totals.rules_on = [1, 0, 0, 6];
        const r = scoreRouteGate(clean(), src);
        expect(r.ok).toBe(false);
        expect(r.frozen_sidn).toEqual([1, 0, 0, 6]);
    });

    it("fails when a window has no frozen answer to check against", () => {
        // Without the dumped oracle the gate cannot say whether a text is
        // right, and a scorer that stays quiet about that reads as a pass.
        const src = sources();
        delete src.oracle.w2;
        const r = scoreRouteGate(clean(), src);
        expect(r.ok).toBe(false);
        expect(r.oracle_gaps).toEqual(["w2"]);
        expect(r.n_hard_mismatches).toBe(1);
    });

    it("hashes token lists the way the Python did", () => {
        // `json.dumps` separates with ", ". Every sha in every gate record
        // would differ from the frozen ones for a reason unrelated to any text.
        expect(toksSha(["αλφα", "βητα"])).toBe(toksSha(["αλφα", "βητα"]));
        expect(toksSha([])).not.toBe(toksSha([""]));
    });
});
