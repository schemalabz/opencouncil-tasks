import type { AlignedWord } from '../ElevenLabsAlign.js';
import type { UtteranceForCaptions, WordTiming } from './types.js';

/**
 * Mean per-utterance alignment loss above which we distrust the alignment and
 * interpolate instead. Tune against real values observed via `cli align`
 * (Task 2 probe) — err generous: false rejects only cost timing precision.
 *
 * Observed (live probe + E2E, 2026-08-24): clean Greek words 0.002–0.8,
 * fillers ("εεε") 5–7, cut-off words ~5.7, clean-utterance means ≈0.77.
 */
export const MAX_MEAN_LOSS = 2.5;

export function tokenizeWords(text: string): string[] {
    return text.split(/\s+/).filter(Boolean);
}

export function interpolateWords(u: UtteranceForCaptions): WordTiming[] {
    const tokens = tokenizeWords(u.text);
    if (tokens.length === 0) return [];
    const totalChars = tokens.reduce((sum, t) => sum + t.length, 0);
    const duration = u.endMs - u.startMs;
    const words: WordTiming[] = [];
    let cursor = u.startMs;
    for (const token of tokens) {
        const share = Math.round((token.length / totalChars) * duration);
        words.push({ text: token, startMs: cursor, endMs: Math.min(cursor + share, u.endMs) });
        cursor += share;
    }
    words[words.length - 1].endMs = u.endMs; // absorb rounding drift
    return words;
}

const normalize = (s: string) => s.normalize('NFC').toLowerCase();

export interface TimingReasons {
    /** Utterances with a token the aligner did not return in sequence. */
    unmatched: number;
    /** Utterances whose mean alignment loss exceeded MAX_MEAN_LOSS. */
    highLoss: number;
    /** No alignment at all (API failure), so every utterance is interpolated. */
    unavailable?: boolean;
}

/**
 * Longest common subsequence of transcript tokens and aligner words on
 * normalized text: for each token, the aligner word it pairs with, or -1.
 * The aligner sees the concatenated clip, so a word it adds or drops anywhere
 * shifts every position after it — a positional slice would misattribute the
 * whole tail, which is how one stray word used to cost a whole clip.
 */
function pairTokens(tokens: string[], aligned: AlignedWord[]): Int32Array {
    const n = tokens.length, m = aligned.length;
    const t = tokens.map(normalize), a = aligned.map(w => normalize(w.text));
    // lcs[i][j] = LCS length of tokens[i..] and aligned[j..]
    const lcs = new Uint16Array((n + 1) * (m + 1));
    const at = (i: number, j: number) => i * (m + 1) + j;
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            lcs[at(i, j)] = t[i] === a[j]
                ? lcs[at(i + 1, j + 1)] + 1
                : Math.max(lcs[at(i + 1, j)], lcs[at(i, j + 1)]);
        }
    }
    const pair = new Int32Array(n).fill(-1);
    for (let i = 0, j = 0; i < n && j < m;) {
        if (t[i] === a[j]) { pair[i] = j; i++; j++; }
        else if (lcs[at(i + 1, j)] >= lcs[at(i, j + 1)]) i++;
        else j++;
    }
    return pair;
}

export function resolveWordTimings(
    utterances: UtteranceForCaptions[],
    aligned: AlignedWord[] | null,
): { words: WordTiming[][]; interpolatedUtterances: number; reasons: TimingReasons } {
    const reasons: TimingReasons = { unmatched: 0, highLoss: 0 };
    if (!aligned) {
        reasons.unavailable = true;
        return { words: utterances.map(interpolateWords), interpolatedUtterances: utterances.length, reasons };
    }

    const perUtterance = utterances.map(u => tokenizeWords(u.text));
    const pair = pairTokens(perUtterance.flat(), aligned);

    let offset = 0;
    let interpolatedUtterances = 0;
    const words = utterances.map((u, i) => {
        const tokens = perUtterance[i];
        const pairs = Array.from(pair.subarray(offset, offset + tokens.length));
        offset += tokens.length;

        const complete = pairs.every(j => j >= 0);
        const slice = complete ? pairs.map(j => aligned[j]) : [];
        const meanLoss = slice.length === 0 ? 0 : slice.reduce((s, w) => s + w.loss, 0) / slice.length;
        if (!complete || meanLoss > MAX_MEAN_LOSS) {
            if (!complete) reasons.unmatched++; else reasons.highLoss++;
            interpolatedUtterances++;
            return interpolateWords(u);
        }
        // Transcript text, aligner timing: the aligner's echo can differ in case
        // or normalization. Timings are clamped to the utterance so a word
        // straddling a cut cannot overlap the neighbouring utterance's page.
        const clamp = (ms: number) => Math.min(Math.max(ms, u.startMs), u.endMs);
        return tokens.map((text, k) => {
            const startMs = clamp(Math.round(slice[k].start * 1000));
            return { text, startMs, endMs: Math.max(startMs, clamp(Math.round(slice[k].end * 1000))) };
        });
    });

    return { words, interpolatedUtterances, reasons };
}
