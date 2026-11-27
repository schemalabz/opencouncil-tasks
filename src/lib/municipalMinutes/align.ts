import { diff } from "fast-myers-diff";

/**
 * Word alignment of two token streams: our transcript (side A) and the
 * minutes (side B). Deterministic, in two steps that repeat inside every gap:
 *
 * 1. Anchors. Every 4-gram that occurs exactly once on each side is a
 *    candidate; the longest chain that increases on both sides is kept, so
 *    the minutes can never match our transcript out of order.
 * 2. Gaps. Between two anchors the two spans are aligned word against word
 *    with a Myers diff. A gap too long for a diff is anchored again on the
 *    4-grams that are unique inside it; what is still too long or too
 *    lopsided and holds no anchor stays unaligned, which is what a pasted
 *    decision or an agenda page deserves.
 *
 * Output: for every token of each side the matching token of the other side,
 * or -1, plus every difference region a diff produced.
 */

export const ANCHOR_NGRAM = 4;
/** The longest gap a Myers diff aligns; a longer gap is anchored again, and left alone when that finds nothing. */
export const MAX_DIFF_TOKENS = 2_000;
/** A single anchor inside a gap this long or longer is not trusted: a common 4-gram unique only by chance. */
const MIN_CHAIN_FOR_LONG_GAP = 2;
const LONG_GAP_TOKENS = 200;
/**
 * A long gap whose sides differ in length by more than this factor is text one
 * side does not have (a pasted decision, a passage the recording missed). A
 * diff of it pairs scattered common words, and every pair is a false anchor
 * for a correction; the gap stays unaligned instead.
 */
const MAX_GAP_RATIO = 3;

/** A region where the sides differ: A[aStart, aEnd) against B[bStart, bEnd). One side can be empty. */
export type Edit = { aStart: number; aEnd: number; bStart: number; bEnd: number };

export type Alignment = {
    /** For each A token, the index of its equal B token, or -1. */
    aToB: Int32Array;
    /** For each B token, the index of its equal A token, or -1. */
    bToA: Int32Array;
    /** Difference regions inside aligned gaps, in order of position. */
    edits: Edit[];
    /** Gaps left unaligned: too long for a diff and without an anchor. */
    unaligned: Edit[];
};

type Anchor = [number, number];

/** Unique n-gram anchors of A[a0,a1) against B[b0,b1), as pairs of start indices. */
export function uniqueAnchors(a: string[], a0: number, a1: number, b: string[], b0: number, b1: number, n = ANCHOR_NGRAM): Anchor[] {
    const key = (s: string[], i: number) => s.slice(i, i + n).join("\u0001");
    const positions = (s: string[], from: number, to: number) => {
        const map = new Map<string, number>();
        for (let i = from; i + n <= to; i++) {
            const k = key(s, i);
            map.set(k, map.has(k) ? -1 : i);
        }
        return map;
    };
    const inA = positions(a, a0, a1);
    const inB = positions(b, b0, b1);
    const anchors: Anchor[] = [];
    for (const [k, i] of inA) {
        const j = inB.get(k);
        if (i >= 0 && j !== undefined && j >= 0) anchors.push([i, j]);
    }
    return anchors.sort((x, y) => x[0] - y[0]);
}

/** The longest chain of anchors that increases strictly on both sides (anchors sorted by the A side). */
export function longestChain(anchors: Anchor[]): Anchor[] {
    if (anchors.length === 0) return [];
    // Patience sorting on the B side; ties on the A side cannot occur (A positions are unique).
    const tails: number[] = [];
    const tailIndex: number[] = [];
    const prev: number[] = new Array(anchors.length).fill(-1);
    for (let k = 0; k < anchors.length; k++) {
        const j = anchors[k][1];
        let lo = 0, hi = tails.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (tails[mid] < j) lo = mid + 1; else hi = mid;
        }
        tails[lo] = j;
        tailIndex[lo] = k;
        prev[k] = lo > 0 ? tailIndex[lo - 1] : -1;
    }
    const chain: Anchor[] = [];
    for (let k = tailIndex[tails.length - 1]; k >= 0; k = prev[k]) chain.push(anchors[k]);
    return chain.reverse();
}

export function alignStreams(a: string[], b: string[]): Alignment {
    const aToB = new Int32Array(a.length).fill(-1);
    const bToA = new Int32Array(b.length).fill(-1);
    const edits: Edit[] = [];
    const unaligned: Edit[] = [];

    const pair = (i: number, j: number) => {
        aToB[i] = j;
        bToA[j] = i;
    };

    const diffGap = (a0: number, a1: number, b0: number, b1: number) => {
        let ai = a0, bj = b0;
        for (const [xs, xe, ys, ye] of diff(a.slice(a0, a1), b.slice(b0, b1))) {
            // Equal run up to the difference.
            while (ai < a0 + xs) pair(ai++, bj++);
            edits.push({ aStart: a0 + xs, aEnd: a0 + xe, bStart: b0 + ys, bEnd: b0 + ye });
            ai = a0 + xe;
            bj = b0 + ye;
        }
        while (ai < a1 && bj < b1) pair(ai++, bj++);
    };

    const alignRange = (a0: number, a1: number, b0: number, b1: number) => {
        const lenA = a1 - a0, lenB = b1 - b0;
        if (lenA === 0 && lenB === 0) return;
        if (lenA === 0 || lenB === 0) {
            edits.push({ aStart: a0, aEnd: a1, bStart: b0, bEnd: b1 });
            return;
        }
        let chain = longestChain(uniqueAnchors(a, a0, a1, b, b0, b1));
        if (chain.length < MIN_CHAIN_FOR_LONG_GAP && Math.max(lenA, lenB) >= LONG_GAP_TOKENS) chain = [];
        if (chain.length === 0) {
            const longest = Math.max(lenA, lenB);
            const lopsided = longest >= LONG_GAP_TOKENS && longest > MAX_GAP_RATIO * Math.min(lenA, lenB);
            if (longest <= MAX_DIFF_TOKENS && !lopsided) diffGap(a0, a1, b0, b1);
            else unaligned.push({ aStart: a0, aEnd: a1, bStart: b0, bEnd: b1 });
            return;
        }
        let cursorA = a0, cursorB = b0;
        for (const [i, j] of chain) {
            for (let k = 0; k < ANCHOR_NGRAM; k++) {
                const ai = i + k, bj = j + k;
                if (ai < cursorA || bj < cursorB) continue;
                if (ai > cursorA || bj > cursorB) alignRange(cursorA, ai, cursorB, bj);
                pair(ai, bj);
                cursorA = ai + 1;
                cursorB = bj + 1;
            }
        }
        alignRange(cursorA, a1, cursorB, b1);
    };

    alignRange(0, a.length, 0, b.length);
    edits.sort((x, y) => x.aStart - y.aStart || x.bStart - y.bStart);
    return { aToB, bToA, edits, unaligned };
}
