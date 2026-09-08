import { FusionEngineError, type FusionToken, type NormalizedWord, type ProviderId, type TimedWord, type TimingSource } from "./types.js";

/**
 * Word times come from Scribe and only from Scribe (spec §4.3, decision 7).
 * Soniox and our own adapter produce times too, but mixing three clocks would
 * make the output's timing a fourth, unevaluated system.
 *
 * Four cases, in order of how much they are trusted:
 *
 *   scribe-native  the fused token *is* a Scribe word — its own start/end
 *   scribe-column  Scribe has a word in the same alignment column but lost it —
 *                  that word's start/end (an identity disagreement, not a gap)
 *   interpolated   Scribe is silent here — linear between the neighbouring
 *                  Scribe times, split by character length, gap ≤ 2.0 s
 *   unaligned      no usable gap (too long, zero, or past the ends) — glued to
 *                  the nearest neighbour in 0.05 s steps
 *
 * Every word carries which case it was and an `timingEstimated` flag, because
 * timing is a separate product from text: interpolation can be perfectly
 * monotonic and still be wrong, and downstream has to be able to see that.
 */

const MAX_INTERPOLATION_GAP_SECONDS = 2.0;
const UNALIGNED_STEP_SECONDS = 0.05;
const EPSILON = 1e-6;

export interface TimingInput {
    tokens: FusionToken[];
    /** The same word lists that went to fuse.py, indexed by system. */
    words: Record<ProviderId, NormalizedWord[]>;
    /** Upper time bound for this segment; when known, no word may exceed it. */
    segmentDurationSec?: number;
}

export interface TimingResult {
    words: TimedWord[];
    /** Share of words whose time was estimated rather than taken from Scribe. */
    timingEstimatedRate: number;
}

interface Draft {
    token: FusionToken;
    start?: number;
    end?: number;
    timingSource?: TimingSource;
}

export function assignTimings(input: TimingInput): TimingResult {
    const drafts: Draft[] = input.tokens.map((token) => ({ token }));
    if (drafts.length === 0) {
        return { words: [], timingEstimatedRate: 0 };
    }

    const scribeWords = input.words.scribe ?? [];
    const anchorOf = (token: FusionToken): { index: number; source: TimingSource } | undefined => {
        if (token.src === "scribe") {
            return usable(scribeWords[token.src_word]) ? { index: token.src_word, source: "scribe-native" } : undefined;
        }
        const column = token.scribe_word;
        if (column === undefined || column === null) return undefined;
        return usable(scribeWords[column]) ? { index: column, source: "scribe-column" } : undefined;
    };

    // Pass 1 — anchored runs. Consecutive tokens sharing one Scribe word split
    // that word's span proportionally: one raw word can normalize to several
    // tokens, and each must get part of the interval, not a copy of it.
    let i = 0;
    while (i < drafts.length) {
        const anchor = anchorOf(drafts[i].token);
        if (!anchor) {
            i++;
            continue;
        }
        let j = i;
        while (j + 1 < drafts.length) {
            // Look past tokens with no anchor of their own. If the SAME Scribe
            // word anchors again after them, they sit inside that word, not in a
            // gap between two words -- and treating them as a gap is what broke
            // three of 250 benchmark windows: the anchor's span was handed out
            // twice, once before the unanchored token and once after, so the
            // timeline jumped backwards by the width of the word (measured
            // 2026-09-08, up to 3.4 s). Absorbing them keeps one span, split
            // across everything it covers, and monotonic by construction.
            let k = j + 1;
            while (k < drafts.length && !anchorOf(drafts[k].token)) k++;
            if (k >= drafts.length) break;
            const next = anchorOf(drafts[k].token)!;
            if (next.index !== anchor.index || next.source !== anchor.source) break;
            j = k;
        }
        const word = scribeWords[anchor.index];
        distribute(drafts, i, j, word.start!, word.end!, anchor.source);
        i = j + 1;
    }

    // Pass 2 — the gaps between anchored runs.
    i = 0;
    while (i < drafts.length) {
        if (drafts[i].start !== undefined) {
            i++;
            continue;
        }
        let j = i;
        while (j + 1 < drafts.length && drafts[j + 1].start === undefined) j++;

        const prevEnd = i > 0 ? drafts[i - 1].end! : undefined;
        const nextStart = j + 1 < drafts.length ? drafts[j + 1].start! : undefined;
        fillGap(drafts, i, j, prevEnd, nextStart, input.segmentDurationSec);
        i = j + 1;
    }

    const upperBound = input.segmentDurationSec;
    const words: TimedWord[] = [];
    // One output word per raw provider word, not per token. fuse.py's contract:
    // a raw word that normalizes to several tokens ("κ.λπ" -> ["κ", "λπ"])
    // emits several consecutive tokens carrying the SAME (src, src_word, text),
    // and TS must treat that run as one word. Emitting one per token would put
    // "κ.λπ" in `full_transcript` and in `words[]` twice.
    for (let k = 0; k < drafts.length; k++) {
        const draft = drafts[k];
        const token = draft.token;
        let last = k;
        while (last + 1 < drafts.length && sameRawWord(token, drafts[last + 1].token)) last++;

        const providerWord = input.words[token.src]?.[token.src_word];
        const timingSource = draft.timingSource!;
        let agreement = token.agreement;
        for (let m = k + 1; m <= last; m++) {
            // The run is one word, so it gets the most cautious agreement of
            // the tokens it covers rather than an arbitrary one.
            agreement = Math.min(agreement, drafts[m].token.agreement);
        }
        words.push({
            word: token.text,
            start: clamp(draft.start!, upperBound),
            end: clamp(drafts[last].end!, upperBound),
            // Provider-confidence semantics, unchanged. Vote agreement is a
            // separate field on purpose: merging them would silently redefine
            // what every downstream consumer of `confidence` is reading.
            confidence: providerWord?.conf ?? 1,
            fusionAgreement: agreement,
            timingSource,
            timingEstimated: timingSource === "interpolated" || timingSource === "unaligned",
        });
        k = last;
    }

    assertTimingInvariants(words, upperBound);

    const estimated = words.filter((word) => word.timingEstimated).length;
    return { words, timingEstimatedRate: words.length === 0 ? 0 : estimated / words.length };
}

/** Two consecutive tokens that came out of the same raw provider word. */
function sameRawWord(a: FusionToken, b: FusionToken): boolean {
    return a.src === b.src && a.src_word === b.src_word && a.text === b.text;
}

function usable(word: NormalizedWord | undefined): boolean {
    return !!word && typeof word.start === "number" && typeof word.end === "number" && word.end >= word.start;
}

/** Split [start, end] over drafts[from..to] proportionally to character length. */
function distribute(drafts: Draft[], from: number, to: number, start: number, end: number, source: TimingSource): void {
    const lengths: number[] = [];
    let total = 0;
    for (let k = from; k <= to; k++) {
        const length = Math.max(1, drafts[k].token.text.length);
        lengths.push(length);
        total += length;
    }
    let cursor = start;
    for (let k = from; k <= to; k++) {
        const share = ((end - start) * lengths[k - from]) / total;
        drafts[k].start = cursor;
        drafts[k].end = k === to ? end : cursor + share;
        drafts[k].timingSource = source;
        cursor = drafts[k].end!;
    }
}

function fillGap(
    drafts: Draft[],
    from: number,
    to: number,
    prevEnd: number | undefined,
    nextStart: number | undefined,
    segmentDurationSec: number | undefined,
): void {
    const count = to - from + 1;

    if (prevEnd !== undefined && nextStart !== undefined) {
        const gap = nextStart - prevEnd;
        if (gap > EPSILON && gap <= MAX_INTERPOLATION_GAP_SECONDS) {
            distribute(drafts, from, to, prevEnd, nextStart, "interpolated");
            return;
        }
        // Too long, or nothing at all to interpolate across: glue to the left
        // neighbour in fixed steps, shrunk if the room is smaller than the steps.
        // (Left, not "whichever is closer": with a > 2 s gap neither neighbour is
        // close, and a deterministic side keeps two runs of the same audio equal.)
        const step = Math.min(UNALIGNED_STEP_SECONDS, Math.max(0, gap) / count);
        glue(drafts, from, to, prevEnd, step);
        return;
    }

    if (prevEnd === undefined && nextStart !== undefined) {
        // Before the first Scribe word: walk backwards from it, never below zero.
        const step = Math.min(UNALIGNED_STEP_SECONDS, Math.max(0, nextStart) / count);
        glue(drafts, from, to, nextStart - step * count, step);
        return;
    }

    if (prevEnd !== undefined) {
        // After the last Scribe word.
        const room = segmentDurationSec === undefined ? Infinity : Math.max(0, segmentDurationSec - prevEnd);
        const step = Math.min(UNALIGNED_STEP_SECONDS, room / count);
        glue(drafts, from, to, prevEnd, step);
        return;
    }

    // Scribe produced nothing usable at all. There is no clock to hang these on;
    // they get a zero-based sequence and are flagged estimated, and the caller
    // sees the estimated rate go to 1.0.
    const room = segmentDurationSec === undefined ? Infinity : Math.max(0, segmentDurationSec);
    glue(drafts, from, to, 0, Math.min(UNALIGNED_STEP_SECONDS, room / count));
}

function glue(drafts: Draft[], from: number, to: number, startAt: number, step: number): void {
    let cursor = Math.max(0, startAt);
    for (let k = from; k <= to; k++) {
        drafts[k].start = cursor;
        drafts[k].end = cursor + step;
        drafts[k].timingSource = "unaligned";
        cursor = drafts[k].end!;
    }
}

function clamp(value: number, upperBound: number | undefined): number {
    const lower = Math.max(0, value);
    return upperBound === undefined ? lower : Math.min(lower, upperBound);
}

/**
 * The invariant, checked on every output. A violation is a segment error, never
 * a silent repair: a repaired timeline is indistinguishable from a correct one
 * downstream, and this is the only place the difference is still visible.
 */
export function assertTimingInvariants(words: TimedWord[], segmentDurationSec?: number): void {
    let previousEnd = -Infinity;
    for (let i = 0; i < words.length; i++) {
        const word = words[i];
        if (!Number.isFinite(word.start) || !Number.isFinite(word.end)) {
            throw new FusionEngineError(`word ${i} has a non-finite time (${word.start}, ${word.end})`, "timing_invariant");
        }
        if (word.end < word.start - EPSILON) {
            throw new FusionEngineError(`word ${i} ends before it starts (${word.start} > ${word.end})`, "timing_invariant");
        }
        if (word.start < previousEnd - EPSILON) {
            // Name both timing sources. "Overlapping" alone cannot distinguish a
            // bad anchor from a bad interpolation, and this error is the only
            // thing that survives the request.
            const previous = words[i - 1];
            throw new FusionEngineError(
                `word ${i} starts at ${word.start} (${word.timingSource}), overlapping the previous `
                + `word ending at ${previousEnd} (${previous?.timingSource})`,
                "timing_invariant");
        }
        if (word.start < -EPSILON) {
            throw new FusionEngineError(`word ${i} starts before the segment (${word.start})`, "timing_invariant");
        }
        if (segmentDurationSec !== undefined && word.end > segmentDurationSec + EPSILON) {
            throw new FusionEngineError(`word ${i} ends at ${word.end}, past the segment bound ${segmentDurationSec}`, "timing_invariant");
        }
        previousEnd = word.end;
    }
}
