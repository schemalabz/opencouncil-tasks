import { describe, it, expect } from 'vitest';
import { DiarizationManager } from './DiarizationManager.js';
import { Diarization, DiarizationSpeaker, Utterance } from '../types.js';

const speakers = (...ids: string[]): DiarizationSpeaker[] =>
    ids.map((id) => ({ speaker: id, match: null, confidence: {} }));

// Builds an utterance from word [start, end] pairs; utterance bounds follow the words
const utterance = (words: [number, number][]): Utterance => ({
    text: words.map((_, i) => `w${i}`).join(' '),
    language: 'el',
    start: words[0][0],
    end: words[words.length - 1][1],
    confidence: 1,
    channel: 0,
    speaker: 0,
    drift: 0,
    words: words.map(([start, end], i) => ({ word: `w${i}`, start, end, confidence: 1 })),
});

describe('DiarizationManager.findBestSpeakerForUtterance', () => {
    it('assigns the single overlapping segment with zero drift', () => {
        const diarization: Diarization = [{ start: 0, end: 10, speaker: 'A' }];
        const manager = new DiarizationManager(diarization, speakers('A'));

        expect(manager.findBestSpeakerForUtterance(utterance([[1, 2], [3, 4]]))).toEqual({ speaker: 1, drift: 0 });
    });

    it('picks the lowest-drift speaker when multiple segments cover the words', () => {
        const diarization: Diarization = [
            { start: 0, end: 5, speaker: 'A' },
            { start: 4.5, end: 10, speaker: 'B' },
        ];
        const manager = new DiarizationManager(diarization, speakers('A', 'B'));

        // w0 lies only in A's segment, w1 in the overlap: A covers everything (drift 0), B doesn't
        const result = manager.findBestSpeakerForUtterance(utterance([[1, 2], [4.6, 4.9]]));
        expect(result.speaker).toBe(1);
        expect(result.drift).toBe(0);
    });

    it('assigns a boundary-straddling word to the segment with the larger overlap instead of dropping it', () => {
        // Exclusive-style timeline: A and B partition time at t=5. The word
        // straddles the boundary, so neither segment fully contains it — the
        // pre-fallback behavior dropped such utterances from the transcript.
        const diarization: Diarization = [
            { start: 0, end: 5, speaker: 'A' },
            { start: 5, end: 10, speaker: 'B' },
        ];
        const manager = new DiarizationManager(diarization, speakers('A', 'B'));

        // 0.2s of the word lies in A, 0.4s in B
        const result = manager.findBestSpeakerForUtterance(utterance([[4.8, 5.4]]));
        expect(result.speaker).toBe(2);
        expect(result.drift).toBe(0);
        expect(manager.getNearestFallbackCount()).toBe(1);
    });

    it('assigns an utterance in a diarization gap to the temporally nearest segment', () => {
        const diarization: Diarization = [
            { start: 0, end: 5, speaker: 'A' },
            { start: 8, end: 10, speaker: 'B' },
        ];
        const manager = new DiarizationManager(diarization, speakers('A', 'B'));

        // 1.5s after A ends, 1.2s before B starts
        const result = manager.findBestSpeakerForUtterance(utterance([[6.5, 6.8]]));
        expect(result.speaker).toBe(2);
        expect(result.drift).toBeCloseTo(1.2);
        expect(manager.getNearestFallbackCount()).toBe(1);
    });

    it('throws on an empty diarization instead of silently losing the utterance', () => {
        const manager = new DiarizationManager([], []);

        expect(() => manager.findBestSpeakerForUtterance(utterance([[1, 2]]))).toThrow(/diarization is empty/);
    });
});
