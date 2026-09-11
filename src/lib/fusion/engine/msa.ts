/**
 * Three-way alignment and per-column voting, ported from `fusion/msa.py`.
 *
 * ALIGNMENT is exact sum-of-pairs dynamic programming over three streams,
 * banded. The band is an optimisation with a guard, not an approximation:
 * whenever the recovered path presses against the band edge the band doubles
 * and the whole thing runs again.
 *
 * VOTING is hierarchical: occupancy first (token against epsilon), then
 * identity inside the winning class. A flat vote where epsilon is just another
 * candidate deletes speech that two of the three systems heard.
 *
 * Every frozen number in `fusion/CONTRACT.md` is a function of these exact
 * tie-breaks, so nothing here may be tidied.
 *
 * One difference the languages force: Python dicts iterate in insertion order
 * for every key, JavaScript objects hoist integer-like keys to the front. A
 * token such as "2024" would therefore win a tie it should have lost, so the
 * vote counts live in a `Map`.
 */

import { sdi } from "./normalize.js";

/**
 * Transition order, frozen. Bitmask A=1, B=2, C=4. Ties in cost AND column
 * count are broken by the first entry, so the order is part of the design.
 */
export const ORDER = [7, 3, 5, 6, 1, 2, 4] as const;

const INF = Infinity;
const COLS_BITS = 12; // score = cost << COLS_BITS | n_columns

/** A column entry: a token, or `null` for epsilon. */
export type Entry = string | null;
export type Column = [Entry, Entry, Entry];

/**
 * `_band` from the research substrate: floor the band at the largest pairwise
 * length difference plus slack, never below 40.
 */
export function bandFor(toks: readonly (readonly unknown[])[]): number {
    let lo = Infinity;
    let hi = -Infinity;
    for (const t of toks) {
        if (t.length < lo) lo = t.length;
        if (t.length > hi) hi = t.length;
    }
    return Math.max(40, hi - lo + 20);
}

/** Unit cost of one pair of column entries (null is epsilon). */
function pairCost(x: Entry, y: Entry): number {
    if (x === null && y === null) return 0;
    if (x === null || y === null) return 1;
    return x === y ? 0 : 1;
}

function colCost(ea: Entry, eb: Entry, ec: Entry): number {
    return pairCost(ea, eb) + pairCost(ea, ec) + pairCost(eb, ec);
}

export function columnsCost(cols: readonly Column[]): number {
    let total = 0;
    for (const c of cols) total += colCost(c[0], c[1], c[2]);
    return total;
}

/** Exact sum-of-pairs three-way alignment. */
export function align3(
    a: readonly string[],
    b: readonly string[],
    c: readonly string[],
    band = 40,
): Column[] {
    const na = a.length;
    const nb = b.length;
    const nc = c.length;
    if (na === 0 && nb === 0 && nc === 0) return [];
    const lim = Math.max(na, nb, nc) + 1;
    let width = band;
    for (;;) {
        const { cols, touched } = align3Banded(a, b, c, width);
        if (!touched || width >= lim) return cols;
        width = Math.min(width * 2, lim);
    }
}

function align3Banded(
    a: readonly string[],
    b: readonly string[],
    c: readonly string[],
    band: number,
): { cols: Column[]; touched: boolean } {
    const na = a.length;
    const nb = b.length;
    const nc = c.length;
    const stride = nc + 1;
    const size = (nb + 1) * stride;

    let prev = new Array<number>(size).fill(INF);
    let cur = new Array<number>(size).fill(INF);
    const ops: Uint8Array[] = [];

    for (let i = 0; i <= na; i++) {
        const layer = new Uint8Array(size);
        if (i) {
            prev = cur;
            cur = new Array<number>(size).fill(INF);
        }
        const ai: Entry = i ? a[i - 1] : null;
        const jlo = Math.max(0, i - band);
        const jhi = Math.min(nb, i + band);
        const klo = Math.max(0, i - band);
        const khi = Math.min(nc, i + band);
        for (let j = jlo; j <= jhi; j++) {
            const bj: Entry = j ? b[j - 1] : null;
            const base = j * stride;
            for (let k = klo; k <= khi; k++) {
                if (i === 0 && j === 0 && k === 0) {
                    cur[0] = 0;
                    continue;
                }
                if (Math.abs(j - k) > band) continue;
                const ck: Entry = k ? c[k - 1] : null;
                let best = INF;
                let bestop = 0;
                for (const m of ORDER) {
                    const pi = m & 1 ? i - 1 : i;
                    const pj = m & 2 ? j - 1 : j;
                    const pk = m & 4 ? k - 1 : k;
                    if (pi < 0 || pj < 0 || pk < 0) continue;
                    const src = m & 1 ? prev : cur;
                    const v = src[pj * stride + pk];
                    if (v === INF) continue;
                    const ea: Entry = m & 1 ? ai : null;
                    const eb: Entry = m & 2 ? bj : null;
                    const ec: Entry = m & 4 ? ck : null;
                    const cand = v + (colCost(ea, eb, ec) << COLS_BITS) + 1;
                    if (cand < best) {
                        best = cand;
                        bestop = m;
                    }
                }
                cur[base + k] = best;
                layer[base + k] = bestop;
            }
        }
        ops.push(layer);
    }

    if (cur[nb * stride + nc] === INF) return { cols: [], touched: true };

    const cols: Column[] = [];
    let i = na;
    let j = nb;
    let k = nc;
    let touched = false;
    while (i || j || k) {
        if (Math.abs(i - j) >= band || Math.abs(i - k) >= band || Math.abs(j - k) >= band) {
            touched = true;
        }
        const m = ops[i][j * stride + k];
        if (!m) return { cols: [], touched: true };
        const ea: Entry = m & 1 ? a[i - 1] : null;
        const eb: Entry = m & 2 ? b[j - 1] : null;
        const ec: Entry = m & 4 ? c[k - 1] : null;
        cols.push([ea, eb, ec]);
        if (m & 1) i -= 1;
        if (m & 2) j -= 1;
        if (m & 4) k -= 1;
    }
    cols.reverse();
    return { cols, touched };
}

export type VoteReason =
    | "epsilon"
    | "unanimous"
    | "majority"
    | "tie_pivot"
    | "tie_priority";

/** Hierarchical vote on one column. */
export function voteColumn(
    col: Column,
    pivot: number,
    priority: readonly number[] = [0, 1, 2],
): { token: Entry; reason: VoteReason } {
    const toks = col.filter((e): e is string => e !== null);
    if (toks.length < 2) return { token: null, reason: "epsilon" };

    const counts = new Map<string, number>();
    for (const t of toks) counts.set(t, (counts.get(t) ?? 0) + 1);
    let top = -Infinity;
    for (const n of counts.values()) if (n > top) top = n;
    const winners: string[] = [];
    for (const [t, n] of counts) if (n === top) winners.push(t);

    if (winners.length === 1) {
        return { token: winners[0], reason: top === 3 ? "unanimous" : "majority" };
    }
    const atPivot = col[pivot];
    if (atPivot !== null && winners.includes(atPivot)) {
        return { token: atPivot, reason: "tie_pivot" };
    }
    for (const p of priority) {
        const e = col[p];
        if (e !== null && winners.includes(e)) {
            return { token: e, reason: "tie_priority" };
        }
    }
    return { token: winners[0], reason: "tie_priority" };
}

export interface ColumnDecision {
    col: number;
    token: Entry;
    reason: VoteReason;
}

/** Vote every column. */
export function compose(
    cols: readonly Column[],
    pivot: number,
    priority: readonly number[] = [0, 1, 2],
): { tokens: string[]; decisions: ColumnDecision[] } {
    const tokens: string[] = [];
    const decisions: ColumnDecision[] = [];
    for (let n = 0; n < cols.length; n++) {
        const { token, reason } = voteColumn(cols[n], pivot, priority);
        decisions.push({ col: n, token, reason });
        if (token !== null) tokens.push(token);
    }
    return { tokens, decisions };
}

/**
 * Per-column token index into each system's stream, or null for epsilon.
 *
 * `align3` consumes the three streams strictly left to right, so a column
 * entry's index is just how many entries that system has contributed so far.
 * This is what maps a chosen token back to the raw word it came from.
 */
export function columnIndices(
    cols: readonly Column[],
): [number | null, number | null, number | null][] {
    const cnt = [0, 0, 0];
    const out: [number | null, number | null, number | null][] = [];
    for (const col of cols) {
        const row: [number | null, number | null, number | null] = [null, null, null];
        for (let k = 0; k < 3; k++) {
            if (col[k] !== null) {
                row[k] = cnt[k];
                cnt[k] += 1;
            }
        }
        out.push(row);
    }
    return out;
}

/**
 * The hypothesis closest to the other two by summed WER. Never sees the
 * reference.
 */
export function consensusPivot(streams: readonly (readonly string[])[]): number {
    const texts = streams.map((s) => s.join(" "));
    let best = 0;
    let bestScore: number | null = null;
    for (let pi = 0; pi < 3; pi++) {
        let score = 0;
        for (let qi = 0; qi < 3; qi++) {
            if (qi === pi) continue;
            const { s, d, i, nRef } = sdi(texts[qi], texts[pi]);
            score += (s + d + i) / Math.max(1, nRef);
        }
        if (bestScore === null || score < bestScore) {
            best = pi;
            bestScore = score;
        }
    }
    return best;
}
