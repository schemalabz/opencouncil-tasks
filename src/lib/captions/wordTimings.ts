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

export function resolveWordTimings(
    utterances: UtteranceForCaptions[],
    aligned: AlignedWord[] | null,
): { words: WordTiming[][]; interpolatedUtterances: number } {
    const tokenCounts = utterances.map(u => tokenizeWords(u.text).length);
    const totalTokens = tokenCounts.reduce((a, b) => a + b, 0);

    if (!aligned || aligned.length !== totalTokens) {
        if (aligned) {
            console.warn(`⚠️ alignment token count ${aligned.length} != transcript token count ${totalTokens}; interpolating all utterances`);
        }
        return { words: utterances.map(interpolateWords), interpolatedUtterances: utterances.length };
    }

    let offset = 0;
    let interpolatedUtterances = 0;
    const words = utterances.map((u, i) => {
        const slice = aligned.slice(offset, offset + tokenCounts[i]);
        offset += tokenCounts[i];

        const textMatches = normalize(slice.map(w => w.text).join(' ')) === normalize(tokenizeWords(u.text).join(' '));
        const meanLoss = slice.length === 0 ? 0 : slice.reduce((s, w) => s + w.loss, 0) / slice.length;

        if (!textMatches || meanLoss > MAX_MEAN_LOSS) {
            interpolatedUtterances++;
            return interpolateWords(u);
        }
        return slice.map(w => ({
            text: w.text,
            startMs: Math.round(w.start * 1000),
            endMs: Math.round(w.end * 1000),
        }));
    });

    return { words, interpolatedUtterances };
}
