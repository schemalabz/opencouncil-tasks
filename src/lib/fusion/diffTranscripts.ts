import type { Transcript, Word } from "../../types.js";

/**
 * Diff two transcripts of the same audio.
 *
 * This is the staging tool: one council meeting transcribed by the fusion on
 * staging, the same meeting transcribed Scribe-only on production, and a
 * question — what did the fusion change, and where?
 *
 * What the numbers are: **agreement with what production published**. What they
 * are not: a fidelity claim. Neither side is a human reference, so a large diff
 * is not evidence that either side is worse. Fidelity was measured once, on the
 * frozen 391-window benchmark, on one machine with one decoder; this tool
 * exists to see product-visible change, not to re-open that question.
 *
 * Two deliberate design choices:
 *
 *  - **Token-level alignment, not utterance-level.** Aligning utterances by
 *    time overlap turns one utterance split into two into a pile of false
 *    insertions and deletions, and the fusion changes utterance boundaries by
 *    construction. The word sequence is the thing both sides agree to compare.
 *  - **The normalization policy is fixed in code**, not a parameter. A tool
 *    whose answer depends on a flag produces two numbers for one question.
 */

export type DiffKind = "substitution" | "insertion" | "deletion";

export interface TranscriptChange {
    kind: DiffKind;
    /** Present for substitution and insertion — the word only the left side has. */
    left?: string;
    /** Present for substitution and deletion — the word only the right side has. */
    right?: string;
    /** Start time in seconds of whichever side has a word here. */
    at: number;
}

export interface TranscriptDiff {
    leftWords: number;
    rightWords: number;
    matched: number;
    substitutions: number;
    deletions: number;
    insertions: number;
    /**
     * matched / (matched + substitutions + insertions + deletions), or null
     * when neither side had a word — no words is not disagreement, and
     * dividing by zero is not a rate.
     */
    agreementRate: number | null;
    changes: TranscriptChange[];
    changesTruncated: boolean;
}

export interface DiffOptions {
    /** Cap on reported changes. The counts are never capped. */
    maxChanges?: number;
}

const DEFAULT_MAX_CHANGES = 200;

/**
 * Casefold, strip punctuation and marks, normalize to NFC. Case and
 * punctuation differ between the two systems for reasons that are not a
 * transcription difference, and counting them would bury the real ones.
 */
export function normalizeForDiff(raw: string): string {
    return raw
        .normalize("NFC")
        .toLocaleLowerCase("el")
        .replace(/[^\p{L}\p{N}]+/gu, "")
        .trim();
}

interface DiffWord {
    raw: string;
    norm: string;
    at: number;
}

function flatten(transcript: Transcript): DiffWord[] {
    const out: DiffWord[] = [];
    for (const utterance of transcript.transcription.utterances ?? []) {
        for (const word of utterance.words ?? []) {
            const norm = normalizeForDiff(word.word);
            // A word that normalizes to nothing (bare punctuation) is not a
            // token either side claims to have heard.
            if (norm.length === 0) continue;
            out.push({ raw: word.word, norm, at: timeOf(word, utterance.start) });
        }
    }
    return out;
}

function timeOf(word: Word, utteranceStart: number): number {
    return Number.isFinite(word.start) ? word.start : utteranceStart;
}

export function diffTranscripts(
    left: Transcript,
    right: Transcript,
    options: DiffOptions = {},
): TranscriptDiff {
    const a = flatten(left);
    const b = flatten(right);
    const maxChanges = options.maxChanges ?? DEFAULT_MAX_CHANGES;

    const { matched, changes } = align(a, b);

    const counts = { substitution: 0, insertion: 0, deletion: 0 };
    for (const change of changes) counts[change.kind]++;

    const total = matched + counts.substitution + counts.insertion + counts.deletion;

    return {
        leftWords: a.length,
        rightWords: b.length,
        matched,
        substitutions: counts.substitution,
        deletions: counts.deletion,
        insertions: counts.insertion,
        agreementRate: total === 0 ? null : matched / total,
        changes: changes.slice(0, maxChanges),
        changesTruncated: changes.length > maxChanges,
    };
}

/**
 * Alignment. Two transcripts of the same meeting agree on the great majority of
 * their words, and a full meeting is ~25k words per side — one Levenshtein cost
 * table for that is ~2.5 billion cells, which does not fit in memory and would
 * not finish if it did. So: anchor on the words both sides agree about, then run
 * the exact alignment only inside the gaps between anchors.
 *
 * The anchors are patience-diff anchors — words that occur exactly once on each
 * side, with the same normalized form, taken in their longest increasing
 * subsequence so the anchor set is monotone. A word that repeats cannot anchor,
 * because "the third ναι" on one side is not necessarily "the third ναι" on the
 * other.
 */

/** Cells above this get split further rather than allocated. 4M ≈ 16 MB. */
const MAX_BLOCK_CELLS = 4_000_000;
/** Below this, anchoring costs more than just running the exact alignment. */
const MIN_BLOCK_TO_ANCHOR = 400;

function align(a: DiffWord[], b: DiffWord[]): { matched: number; changes: TranscriptChange[] } {
    const acc = { matched: 0, changes: [] as TranscriptChange[] };
    alignBlock(a, 0, a.length, b, 0, b.length, acc, 0);
    return acc;
}

interface Acc { matched: number; changes: TranscriptChange[] }

function alignBlock(
    a: DiffWord[], aFrom: number, aTo: number,
    b: DiffWord[], bFrom: number, bTo: number,
    acc: Acc, depth: number,
): void {
    // Common prefix and suffix first: it is what makes the recursion terminate
    // cheaply once an anchor pair has pinned a region.
    while (aFrom < aTo && bFrom < bTo && a[aFrom].norm === b[bFrom].norm) { acc.matched++; aFrom++; bFrom++; }
    while (aTo > aFrom && bTo > bFrom && a[aTo - 1].norm === b[bTo - 1].norm) { acc.matched++; aTo--; bTo--; }

    const n = aTo - aFrom;
    const m = bTo - bFrom;
    if (n === 0 && m === 0) return;
    if (n === 0) {
        for (let j = bFrom; j < bTo; j++) acc.changes.push({ kind: "deletion", right: b[j].raw, at: b[j].at });
        return;
    }
    if (m === 0) {
        for (let i = aFrom; i < aTo; i++) acc.changes.push({ kind: "insertion", left: a[i].raw, at: a[i].at });
        return;
    }

    const cells = (n + 1) * (m + 1);
    if (cells <= MAX_BLOCK_CELLS && (n < MIN_BLOCK_TO_ANCHOR || m < MIN_BLOCK_TO_ANCHOR)) {
        exactAlign(a, aFrom, aTo, b, bFrom, bTo, acc);
        return;
    }

    const anchors = depth < 24 ? patienceAnchors(a, aFrom, aTo, b, bFrom, bTo) : [];
    if (anchors.length > 0) {
        let ai = aFrom;
        let bi = bFrom;
        for (const [anchorA, anchorB] of anchors) {
            alignBlock(a, ai, anchorA, b, bi, anchorB, acc, depth + 1);
            acc.matched++;                      // the anchor word itself
            ai = anchorA + 1;
            bi = anchorB + 1;
        }
        alignBlock(a, ai, aTo, b, bi, bTo, acc, depth + 1);
        return;
    }

    if (cells <= MAX_BLOCK_CELLS) {
        exactAlign(a, aFrom, aTo, b, bFrom, bTo, acc);
        return;
    }

    // No anchor and too big for one table: split both sides proportionally at
    // the midpoint. Deterministic, and it can only over-report changes near the
    // cut — it never invents a change in the wrong direction.
    // A one-word side cannot be halved: `n >> 1` is 0, so `aMid` lands back on
    // `aFrom` and the second call repeats this exact block for ever. Reaching it
    // takes a block of one word against two million, which no transcript
    // produces, but the recursion has no other floor and the table for a
    // one-word side is two rows wide.
    if (n === 1 || m === 1) {
        exactAlign(a, aFrom, aTo, b, bFrom, bTo, acc);
        return;
    }
    const aMid = aFrom + (n >> 1);
    const bMid = bFrom + Math.round((m * (aMid - aFrom)) / n);
    alignBlock(a, aFrom, aMid, b, bFrom, bMid, acc, depth + 1);
    alignBlock(a, aMid, aTo, b, bMid, bTo, acc, depth + 1);
}

/**
 * Exact Levenshtein over one block, with a fixed tie order (substitute, then
 * left-only, then right-only) so the same pair of blocks always produces the
 * same change list rather than an equally-cheap different one.
 */
function exactAlign(
    a: DiffWord[], aFrom: number, aTo: number,
    b: DiffWord[], bFrom: number, bTo: number,
    acc: Acc,
): void {
    const n = aTo - aFrom;
    const m = bTo - bFrom;
    const cost = new Int32Array((n + 1) * (m + 1));
    const at = (i: number, j: number) => i * (m + 1) + j;

    for (let i = 1; i <= n; i++) cost[at(i, 0)] = i;
    for (let j = 1; j <= m; j++) cost[at(0, j)] = j;

    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            const same = a[aFrom + i - 1].norm === b[bFrom + j - 1].norm;
            const sub = cost[at(i - 1, j - 1)] + (same ? 0 : 1);
            const del = cost[at(i - 1, j)] + 1;
            const ins = cost[at(i, j - 1)] + 1;
            cost[at(i, j)] = Math.min(sub, del, ins);
        }
    }

    const reversed: TranscriptChange[] = [];
    let i = n;
    let j = m;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0) {
            const same = a[aFrom + i - 1].norm === b[bFrom + j - 1].norm;
            if (cost[at(i, j)] === cost[at(i - 1, j - 1)] + (same ? 0 : 1)) {
                if (same) acc.matched++;
                else reversed.push({ kind: "substitution", left: a[aFrom + i - 1].raw, right: b[bFrom + j - 1].raw, at: a[aFrom + i - 1].at });
                i--; j--;
                continue;
            }
        }
        if (i > 0 && cost[at(i, j)] === cost[at(i - 1, j)] + 1) {
            reversed.push({ kind: "insertion", left: a[aFrom + i - 1].raw, at: a[aFrom + i - 1].at });
            i--;
            continue;
        }
        reversed.push({ kind: "deletion", right: b[bFrom + j - 1].raw, at: b[bFrom + j - 1].at });
        j--;
    }

    reversed.reverse();
    for (const change of reversed) acc.changes.push(change);
}

/**
 * Words occurring exactly once in each block, matched by normalized form, taken
 * in their longest increasing subsequence of right-hand positions.
 */
function patienceAnchors(
    a: DiffWord[], aFrom: number, aTo: number,
    b: DiffWord[], bFrom: number, bTo: number,
): Array<[number, number]> {
    const inA = new Map<string, number>();
    for (let i = aFrom; i < aTo; i++) {
        const norm = a[i].norm;
        inA.set(norm, inA.has(norm) ? -1 : i);
    }
    const inB = new Map<string, number>();
    for (let j = bFrom; j < bTo; j++) {
        const norm = b[j].norm;
        inB.set(norm, inB.has(norm) ? -1 : j);
    }

    const pairs: Array<[number, number]> = [];
    for (const [norm, i] of inA) {
        if (i < 0) continue;
        const j = inB.get(norm);
        if (j === undefined || j < 0) continue;
        pairs.push([i, j]);
    }
    if (pairs.length === 0) return [];
    pairs.sort((x, y) => x[0] - y[0]);

    // Longest strictly increasing subsequence of the right-hand positions.
    const tailIndex: number[] = [];
    const previous = new Int32Array(pairs.length).fill(-1);
    for (let k = 0; k < pairs.length; k++) {
        const value = pairs[k][1];
        let lo = 0;
        let hi = tailIndex.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (pairs[tailIndex[mid]][1] < value) lo = mid + 1;
            else hi = mid;
        }
        if (lo > 0) previous[k] = tailIndex[lo - 1];
        tailIndex[lo] = k;
    }

    const chain: Array<[number, number]> = [];
    for (let k = tailIndex[tailIndex.length - 1]; k >= 0; k = previous[k]) chain.push(pairs[k]);
    chain.reverse();
    return chain;
}

/** Human-readable summary. Says "agreement" because that is what it measures. */
export function formatTranscriptDiff(diff: TranscriptDiff): string {
    const rate = diff.agreementRate === null ? "n/a (no words on either side)" : `${(diff.agreementRate * 100).toFixed(2)}%`;
    const lines = [
        `words: left ${diff.leftWords}, right ${diff.rightWords}`,
        `agreement: ${rate}  (matched ${diff.matched})`,
        `changed: ${diff.substitutions} substitutions, ${diff.insertions} only-on-left, ${diff.deletions} only-on-right`,
        "",
        "This is agreement between two transcripts of the same audio. Neither side is",
        "a human reference, so it records what changed and where — it does not say",
        "which side is right.",
    ];
    if (diff.changes.length > 0) {
        lines.push("", "changes:");
        for (const change of diff.changes) {
            const stamp = `${Math.floor(change.at / 60)}:${String(Math.floor(change.at % 60)).padStart(2, "0")}`;
            if (change.kind === "substitution") lines.push(`  ${stamp}  ${change.left} → ${change.right}`);
            else if (change.kind === "insertion") lines.push(`  ${stamp}  + ${change.left}  (left only)`);
            else lines.push(`  ${stamp}  - ${change.right}  (right only)`);
        }
        if (diff.changesTruncated) lines.push(`  … ${diff.substitutions + diff.insertions + diff.deletions - diff.changes.length} more`);
    }
    return lines.join("\n");
}
