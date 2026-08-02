import { describe, it, expect } from 'vitest';
import { compareDiarizationModes } from './diarizationModeComparison.js';
import { DiarizeResult, Transcript, Utterance } from '../types.js';

const utterance = (start: number, end: number, text: string): Utterance => ({
    text,
    language: 'el',
    start,
    end,
    confidence: 1,
    channel: 0,
    speaker: 0,
    drift: 0,
    words: [{ word: text, start, end, confidence: 1 }],
});

const transcript: Transcript = {
    metadata: { audio_duration: 30, number_of_distinct_channels: 1, billing_time: 30, transcription_time: 1 },
    transcription: {
        languages: ['el'],
        full_transcript: 'a b c',
        // u1: single-segment fast path in both variants; u2: sits inside the A/B
        // overlap of the regular timeline (ambiguous, tie-broken by order) but
        // cleanly inside B in the exclusive one; u3: outside any speech
        utterances: [utterance(1, 4, 'a'), utterance(9.2, 9.8, 'b'), utterance(20, 21, 'c')],
    },
};

const diarizeResult: DiarizeResult = {
    diarization: [
        { start: 0, end: 10, speaker: 'SEG1:SPEAKER_00' },
        { start: 8, end: 12, speaker: 'SEG1:SPEAKER_01' },
    ],
    exclusiveDiarization: [
        { start: 0, end: 9, speaker: 'SEG1:SPEAKER_00' },
        { start: 9, end: 12, speaker: 'SEG1:SPEAKER_01' },
    ],
    speakers: [
        { speaker: 'SEG1:SPEAKER_00', match: null, confidence: {} },
        { speaker: 'SEG1:SPEAKER_01', match: null, confidence: {} },
    ],
};

describe('compareDiarizationModes', () => {
    it('computes per-variant metrics and per-utterance diff', () => {
        const report = compareDiarizationModes(transcript, diarizeResult);

        expect(report.regular.utterances).toEqual({ total: 3, assigned: 2, skipped: 1, skippedPercent: 33.33 });
        expect(report.regular.ambiguous).toBe(1); // u2 overlaps both segments
        expect(report.regular.timeline).toEqual({ segments: 2, speechSeconds: 12, overlapSeconds: 2 }); // overlap 8..10
        // Both segments fully contain u2's word, so drift ties at 0 and the tie
        // breaks to whichever speaker appears first in the timeline: speaker 1
        expect(report.regular.speakers).toEqual({ count: 1, utterancesPerSpeaker: { 1: 2 } });

        expect(report.exclusive.utterances).toEqual({ total: 3, assigned: 2, skipped: 1, skippedPercent: 33.33 });
        expect(report.exclusive.ambiguous).toBe(0);
        expect(report.exclusive.timeline).toEqual({ segments: 2, speechSeconds: 12, overlapSeconds: 0 });
        expect(report.exclusive.speakers).toEqual({ count: 2, utterancesPerSpeaker: { 1: 1, 2: 1 } });

        expect(report.regular.drift).toEqual({ total: 0, mean: 0, nonZero: 0 });
        expect(report.exclusive.drift).toEqual({ total: 0, mean: 0, nonZero: 0 });

        expect(report.diff.speakerChanged).toEqual([
            { start: 9.2, end: 9.8, text: 'b', regular: 1, exclusive: 2 },
        ]);
        expect(report.diff.rescuedByExclusive).toBe(0);
        expect(report.diff.lostByExclusive).toBe(0);
    });

    it('throws when exclusiveDiarization is missing', () => {
        expect(() => compareDiarizationModes(transcript, { ...diarizeResult, exclusiveDiarization: undefined }))
            .toThrow(/exclusiveDiarization/);
    });
});
