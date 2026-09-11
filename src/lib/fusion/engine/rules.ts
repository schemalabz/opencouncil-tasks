/**
 * Island analysis and the deterministic arms, ported from `fusion/rules.py`.
 *
 * Every token here is carried as a `[token, system, column]` triple rather than
 * a bare string, so the driver can name the raw provider word behind each
 * output token. Strip the triples with `toks()` and the sequences are identical
 * to the research code's lists, which is what the conformance suite proves.
 *
 * Guard definition (frozen): an island is guarded iff, after removing every
 * token in {ναι, δεν}, the three candidate spans are identical, at least one
 * span contains such a token, and the arm's output contains none. The output is
 * then replaced by the span with the most critical tokens, ties going to the
 * longest, then to scribe over soniox over ours.
 */
import crypto from "crypto";
import * as C from "./categories.js";
import { columnClass, islands, splitMergeColumns } from "./islands.js";
import { voteColumn, type Column } from "./msa.js";
import { pyJsonDumps } from "./pyjson.js";

export const CRIT: readonly string[] = ["ναι", "δεν"];

/** Rule names are the frozen Greek strings used in `policy.json`. */
export const RULE_VOTE = "ψήφος";
export const RULE_R12 = "R1+R2";
export const RULE_SCRIBE = "Scribe";
export const RULE_DELETE = "σβήσε";

/** `[token, systemIndex, columnIndex]`. */
export type Triple = [string, number, number];

export function toks(triples: readonly Triple[]): string[] {
    return triples.map((t) => t[0]);
}

const key = (xs: readonly string[]) => JSON.stringify(xs);

/**
 * Port of the research `classify`. Note it does NOT append |ATOMIC or
 * |COMPOSITE to the TWO_, SOLO_ and PAIRE_ signatures, unlike the variant in
 * the category module.
 */
export function classify(
    cols: readonly Column[],
    span: readonly number[],
    sm: ReadonlySet<number>,
    ctx: ReadonlySet<string>,
): { cat: string; spans: string[][] } {
    const spans: string[][] = [];
    for (let k = 0; k < 3; k++) {
        const s: string[] = [];
        for (const i of span) {
            const e = cols[i][k];
            if (e !== null) s.push(e);
        }
        spans.push(s);
    }

    const ragged = new Set(spans.map((x) => x.length)).size > 1;
    const composite = ragged || span.some((i) => sm.has(i));

    if (new Set(spans.map((x) => key(C.normNum(x)))).size === 1) return { cat: "NUM", spans };
    if (new Set(spans.map((x) => key(C.stripFill(x)))).size === 1) return { cat: "FILL", spans };
    if (new Set(spans.map((x) => key(C.stripDup(x, ctx)))).size === 1) return { cat: "DUP", spans };
    if (new Set(spans.map((x) => key(C.stripDup(C.stripFill(x), ctx)))).size === 1) {
        return { cat: "LOW", spans };
    }

    const sig = C.signature(spans);
    if (sig.startsWith("TWO_") || sig.startsWith("SOLO_") || sig.startsWith("PAIRE_")) {
        return { cat: sig, spans };
    }
    return { cat: sig + (composite ? "|COMPOSITE" : "|ATOMIC"), spans };
}

/** Which system supplied a voted token. Frozen priority scribe > soniox > ours. */
function voteSource(col: Column, token: string | null): number | null {
    for (let k = 0; k < 3; k++) {
        if (col[k] === token) return k;
    }
    return null;
}

export interface Island {
    s: number;
    e: number;
    cat: string;
    spans: string[][];
    vote: string[];
    r12: string[];
    L: string;
    R: string;
    before: string[];
    vote_tr: Triple[];
    r12_tr: Triple[];
    span_tr: Triple[][];
    before_tr: Triple[];
}

export interface WindowParts {
    islands: Island[];
    tail_tr: Triple[];
    wsel: (string | null)[];
    wsrc: (number | null)[];
}

/** Islands, tail, and the voted selection: enough to rebuild any arm's text. */
export function windowParts(cols: readonly Column[], pivot: number): WindowParts {
    const wsel = cols.map((c) => voteColumn(c, pivot).token);
    const wsrc = cols.map((c, i) => (wsel[i] !== null ? voteSource(c, wsel[i]) : null));
    const sm = splitMergeColumns(cols);

    const out: Island[] = [];
    let prev = 0;
    for (const [s, e] of islands(cols)) {
        const span: number[] = [];
        for (let i = s; i < e; i++) span.push(i);

        const L: string[] = [];
        for (let i = Math.max(0, s - 12); i < s; i++) {
            if (columnClass(cols[i]) === "agree") L.push(cols[i][0] as string);
        }
        const R: string[] = [];
        for (let i = e; i < Math.min(cols.length, e + 12); i++) {
            if (columnClass(cols[i]) === "agree") R.push(cols[i][0] as string);
        }

        const ctx = new Set<string>([...L.slice(-3), ...R.slice(0, 3)]);
        const { cat, spans } = classify(cols, span, sm, ctx);

        const vote_tr: Triple[] = [];
        for (const i of span) {
            if (wsel[i] !== null) vote_tr.push([wsel[i] as string, wsrc[i] as number, i]);
        }

        const r12_tr: Triple[] = [];
        for (const i of span) {
            const k = columnClass(cols[i]);
            if (k === "unresolved_two") continue;
            let t: string | null;
            let src: number | null;
            if (k === "unresolved_three") {
                t = cols[i][0];
                src = 0;
            } else {
                t = wsel[i];
                src = wsrc[i];
            }
            if (t !== null) r12_tr.push([t, src as number, i]);
        }

        const span_tr: Triple[][] = [];
        for (let k = 0; k < 3; k++) {
            const row: Triple[] = [];
            for (const i of span) {
                const e2 = cols[i][k];
                if (e2 !== null) row.push([e2, k, i]);
            }
            span_tr.push(row);
        }

        const before_tr: Triple[] = [];
        for (let i = prev; i < s; i++) {
            if (columnClass(cols[i]) === "agree") before_tr.push([cols[i][0] as string, 0, i]);
        }

        out.push({
            s, e, cat, spans,
            vote: toks(vote_tr),
            r12: toks(r12_tr),
            L: L.slice(-8).join(" "),
            R: R.slice(0, 8).join(" "),
            before: toks(before_tr),
            vote_tr, r12_tr, span_tr, before_tr,
        });
        prev = e;
    }

    const tail_tr: Triple[] = [];
    for (let i = prev; i < cols.length; i++) {
        if (columnClass(cols[i]) === "agree") tail_tr.push([cols[i][0] as string, 0, i]);
    }
    return { islands: out, tail_tr, wsel, wsrc };
}

export const RULES: Record<string, (i: Island) => Triple[]> = {
    [RULE_VOTE]: (i) => i.vote_tr,
    [RULE_R12]: (i) => i.r12_tr,
    [RULE_SCRIBE]: (i) => i.span_tr[0],
    [RULE_DELETE]: () => [],
};

/**
 * Python's `max(range(3), key=...)` keeps the FIRST index on a tie and compares
 * the key tuples lexicographically, so the order of these three comparisons is
 * the tie-break: most critical tokens, then longest span, then the lower system
 * index. Written out because a JavaScript sort would neither be stable in the
 * same way nor compare tuples at all.
 */
function bestGuardSpan(nCrit: readonly number[], spans: readonly (readonly string[])[]): number {
    let best = 0;
    for (let i = 1; i < 3; i++) {
        const a: [number, number, number] = [nCrit[i], spans[i].length, -i];
        const b: [number, number, number] = [nCrit[best], spans[best].length, -best];
        if (a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])))) {
            best = i;
        }
    }
    return best;
}

function guardable(
    spans: readonly (readonly string[])[],
    outTokens: readonly string[],
): number | null {
    const core = spans.map((sp) => sp.filter((t) => !CRIT.includes(t)));
    if (key(core[0]) !== key(core[1]) || key(core[1]) !== key(core[2])) return null;
    const nCrit = spans.map((sp) => sp.reduce((n, t) => n + (CRIT.includes(t) ? 1 : 0), 0));
    if (!nCrit.some((n) => n > 0)) return null;
    if (outTokens.some((t) => CRIT.includes(t))) return null;
    return bestGuardSpan(nCrit, spans);
}

/** The guard over plain token lists. */
export function applyGuard(
    spans: readonly (readonly string[])[],
    out: readonly string[],
): { out: string[]; fired: boolean } {
    const k = guardable(spans, out);
    if (k === null) return { out: [...out], fired: false };
    return { out: [...spans[k]], fired: true };
}

/**
 * The guard on triples. The replacement span is one whole system's span, so its
 * provenance is that system's `span_tr`.
 */
export function applyGuardTr(
    isl: Island,
    outTr: readonly Triple[],
): { out: Triple[]; fired: boolean } {
    const k = guardable(isl.spans, toks(outTr));
    if (k === null) return { out: [...outTr], fired: false };
    return { out: [...isl.span_tr[k]], fired: true };
}

/** The render-row hash the policy fixtures key on. */
export function rowSha(i: Island): string {
    const row = { L: i.L, R: i.R, spans: i.spans, r12: i.r12 };
    return crypto.createHash("sha256")
        .update(pyJsonDumps(row), "utf8")
        .digest("hex")
        .slice(0, 16);
}

/** `[route, rule]` for a category under a policy dict. */
export function islandRoute(
    policy: Record<string, { mode: string; rule?: string }>,
    cat: string,
): [string, string | null] {
    const p = policy[cat];
    if (!p) return ["vote", null];
    return [p.mode, p.mode === "rule" ? (p.rule ?? null) : null];
}
