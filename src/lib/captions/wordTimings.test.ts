import { describe, it, expect } from 'vitest';
import { tokenizeWords, interpolateWords, resolveWordTimings } from './wordTimings.js';
import type { UtteranceForCaptions } from './types.js';

const utt = (id: string, startMs: number, endMs: number, text: string): UtteranceForCaptions =>
    ({ utteranceId: id, startMs, endMs, text });

describe('tokenizeWords', () => {
    it('splits on whitespace and drops empties', () => {
        expect(tokenizeWords('  Ξεκινάμε την  ανάπλαση ')).toEqual(['Ξεκινάμε', 'την', 'ανάπλαση']);
    });
});

describe('interpolateWords', () => {
    it('distributes duration proportionally to word length', () => {
        const words = interpolateWords(utt('u1', 0, 1000, 'αα ββββββ'));
        // "αα" = 2 chars, "ββββββ" = 6 chars → 25% / 75% of 1000ms
        expect(words).toEqual([
            { text: 'αα', startMs: 0, endMs: 250 },
            { text: 'ββββββ', startMs: 250, endMs: 1000 },
        ]);
    });

    it('covers the full utterance window', () => {
        const words = interpolateWords(utt('u1', 500, 2500, 'ένα δύο τρία'));
        expect(words[0].startMs).toBe(500);
        expect(words[words.length - 1].endMs).toBe(2500);
    });
});

describe('resolveWordTimings', () => {
    const utterances = [
        utt('u1', 0, 1000, 'Ξεκινάμε την'),
        utt('u2', 1000, 2000, 'ανάπλαση'),
    ];
    const aligned = [
        { text: 'Ξεκινάμε', start: 0.05, end: 0.5, loss: 0.1 },
        { text: 'την', start: 0.55, end: 0.9, loss: 0.1 },
        { text: 'ανάπλαση', start: 1.1, end: 1.9, loss: 0.2 },
    ];

    it('uses aligned timings when token counts and texts match', () => {
        const { words, interpolatedUtterances } = resolveWordTimings(utterances, aligned);
        expect(interpolatedUtterances).toBe(0);
        expect(words[0]).toEqual([
            { text: 'Ξεκινάμε', startMs: 50, endMs: 500 },
            { text: 'την', startMs: 550, endMs: 900 },
        ]);
        expect(words[1]).toEqual([{ text: 'ανάπλαση', startMs: 1100, endMs: 1900 }]);
    });

    it('interpolates everything when aligned is null', () => {
        const { words, interpolatedUtterances } = resolveWordTimings(utterances, null);
        expect(interpolatedUtterances).toBe(2);
        expect(words[0]).toHaveLength(2);
        expect(words[1]).toHaveLength(1);
    });

    it('interpolates everything on global token-count mismatch', () => {
        const { interpolatedUtterances } = resolveWordTimings(utterances, aligned.slice(0, 2));
        expect(interpolatedUtterances).toBe(2);
    });

    it('interpolates only the utterance whose text diverges', () => {
        const edited = [utterances[0], utt('u2', 1000, 2000, 'ανακατασκευή')];
        const { words, interpolatedUtterances } = resolveWordTimings(edited, aligned);
        expect(interpolatedUtterances).toBe(1);
        expect(words[0][0].text).toBe('Ξεκινάμε'); // aligned survives for u1
        expect(words[1][0]).toEqual({ text: 'ανακατασκευή', startMs: 1000, endMs: 2000 });
    });

    it('interpolates an utterance whose mean loss is too high', () => {
        const noisy = [
            { ...aligned[0], loss: 9 },
            { ...aligned[1], loss: 9 },
            aligned[2],
        ];
        const { interpolatedUtterances, words } = resolveWordTimings(utterances, noisy);
        expect(interpolatedUtterances).toBe(1);
        expect(words[1][0].startMs).toBe(1100); // u2 still aligned
    });
});
