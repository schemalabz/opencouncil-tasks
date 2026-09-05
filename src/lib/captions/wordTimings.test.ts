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

    // Production, 2026-09-04: the aligner returned 129 words for 128 tokens and the
    // whole clip fell back to interpolation. A stray aligner word must cost at most
    // the utterance it lands in — and one the transcript simply lacks costs nothing.
    it('skips an aligner word absent from the transcript without degrading any utterance', () => {
        const three = [
            utt('u1', 0, 1000, 'Ξεκινάμε την'),
            utt('u2', 1000, 2000, 'ανάπλαση της'),
            utt('u3', 2000, 3000, 'πλατείας σήμερα'),
        ];
        const withExtra = [
            { text: 'Ξεκινάμε', start: 0.05, end: 0.5, loss: 0.1 },
            { text: 'την', start: 0.55, end: 0.9, loss: 0.1 },
            { text: 'ανάπλαση', start: 1.1, end: 1.4, loss: 0.2 },
            { text: 'εεε', start: 1.4, end: 1.5, loss: 6 },      // filler the aligner heard
            { text: 'της', start: 1.5, end: 1.9, loss: 0.2 },
            { text: 'πλατείας', start: 2.1, end: 2.5, loss: 0.1 },
            { text: 'σήμερα', start: 2.6, end: 2.9, loss: 0.1 },
        ];
        const { words, interpolatedUtterances, reasons } = resolveWordTimings(three, withExtra);
        expect(interpolatedUtterances).toBe(0);
        expect(words[1]).toEqual([{ text: 'ανάπλαση', startMs: 1100, endMs: 1400 }, { text: 'της', startMs: 1500, endMs: 1900 }]);
        expect(words[2][1]).toEqual({ text: 'σήμερα', startMs: 2600, endMs: 2900 });
        expect(reasons).toEqual({ unmatched: 0, highLoss: 0 });
    });

    it('keeps aligned timings for utterances after one whose word the aligner dropped', () => {
        const { words, interpolatedUtterances, reasons } = resolveWordTimings(utterances, [aligned[0], aligned[2]]);
        expect(interpolatedUtterances).toBe(1);        // u1 lost 'την'
        expect(words[0]).toEqual([{ text: 'Ξεκινάμε', startMs: 0, endMs: 727 }, { text: 'την', startMs: 727, endMs: 1000 }]);
        expect(words[1]).toEqual([{ text: 'ανάπλαση', startMs: 1100, endMs: 1900 }]);
        expect(reasons).toEqual({ unmatched: 1, highLoss: 0 });
    });

    // The guarantee, at the shape of the production clip: 14 utterances, one drift
    // anywhere. Positional slicing degraded all 14; pairing degrades at most one.
    const clip = [
        'Καλησπέρα σας', 'Ξεκινάμε τη συνεδρίαση', 'Ο κύριος Παπαδόπουλος έχει τον λόγο', 'Ευχαριστώ πρόεδρε',
        'Θα είμαι σύντομος', 'Το θέμα της ανάπλασης', 'είναι γνωστό σε όλους', 'Παρ\' όλα αυτά',
        'πρέπει να αποφασίσουμε σήμερα', 'Η πρόταση είναι απλή', 'Ψηφίζουμε τον προϋπολογισμό', 'όπως κατατέθηκε',
        'Ευχαριστώ', 'Τον λόγο έχει η κυρία Ιωάννου',
    ].map((text, i) => utt(`u${i}`, i * 1000, (i + 1) * 1000, text));
    const clean = clip.flatMap(u => tokenizeWords(u.text).map((text, k) => ({ text, start: u.startMs / 1000 + k * 0.1, end: u.startMs / 1000 + k * 0.1 + 0.08, loss: 0.1 })));
    const positions = clean.map((_, i) => i);

    it.each(positions)('an extra aligner word at %i degrades no utterance', i => {
        const withExtra = [...clean.slice(0, i), { text: 'εεε', start: clean[i].start, end: clean[i].start, loss: 5 }, ...clean.slice(i)];
        expect(resolveWordTimings(clip, withExtra).interpolatedUtterances).toBe(0);
    });

    it.each(positions)('an aligner word dropped at %i degrades only its own utterance', i => {
        const dropped = clean.filter((_, k) => k !== i);
        const { words, interpolatedUtterances } = resolveWordTimings(clip, dropped);
        expect(interpolatedUtterances).toBe(1);
        // Every other utterance still carries aligner timings (0.1 s word grid, not interpolation).
        const owner = clip.findIndex(u => u.startMs / 1000 <= clean[i].start && clean[i].start < u.endMs / 1000);
        words.forEach((w, u) => { if (u !== owner) expect(w[0].startMs).toBe(Math.round(clean.find(c => c.text === tokenizeWords(clip[u].text)[0] && c.start >= clip[u].startMs / 1000)!.start * 1000)); });
    });

    // Measured against the API (2026-09-06): a parenthesised reference glued to a
    // word — "άρθρο(5)" — is one whitespace token for us but two for the aligner.
    it('interpolates only the utterance whose token the aligner split in two', () => {
        const law = [utt('u1', 0, 1000, 'το άρθρο(5) ισχύει'), utt('u2', 1000, 2000, 'ανάπλαση')];
        const split = [
            { text: 'το', start: 0.0, end: 0.2, loss: 0.1 }, { text: 'άρθρο', start: 0.2, end: 0.5, loss: 0.1 },
            { text: '(5)', start: 0.5, end: 0.6, loss: 0.1 }, { text: 'ισχύει', start: 0.6, end: 0.9, loss: 0.1 },
            aligned[2],
        ];
        const { words, interpolatedUtterances, reasons } = resolveWordTimings(law, split);
        expect(interpolatedUtterances).toBe(1);
        expect(reasons).toEqual({ unmatched: 1, highLoss: 0 });
        expect(words[1]).toEqual([{ text: 'ανάπλαση', startMs: 1100, endMs: 1900 }]);
    });

    it('reports why when alignment was unavailable', () => {
        const { reasons } = resolveWordTimings(utterances, null);
        expect(reasons).toEqual({ unmatched: 0, highLoss: 0, unavailable: true });
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
        const { interpolatedUtterances, words, reasons } = resolveWordTimings(utterances, noisy);
        expect(interpolatedUtterances).toBe(1);
        expect(words[1][0].startMs).toBe(1100); // u2 still aligned
        expect(reasons.highLoss).toBe(1);
    });
});
