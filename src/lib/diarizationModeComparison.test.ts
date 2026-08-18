import { describe, it, expect } from 'vitest';
import { compareDiarizationModes, EvalDiarizeResult } from './diarizationModeComparison.js';
import { Transcript, Utterance } from '../types.js';

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
        // cleanly inside B in the exclusive one; u3: outside any speech, so it
        // exercises the nearest-segment fallback (segment B, 8s gap, in both)
        utterances: [utterance(1, 4, 'a'), utterance(9.2, 9.8, 'b'), utterance(20, 21, 'c')],
    },
};

const diarizeResult: EvalDiarizeResult = {
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

        // The never-drop fallback assigns u3 to the nearest segment (B, 8s away)
        expect(report.regular.utterances).toEqual({ total: 3, assigned: 3, skipped: 0, skippedPercent: 0 });
        expect(report.regular.ambiguous).toBe(1); // u2 overlaps both segments
        expect(report.regular.fallbackAssigned).toBe(1); // u3
        expect(report.regular.timeline).toEqual({ segments: 2, speechSeconds: 12, overlapSeconds: 2 }); // overlap 8..10
        // Both segments fully contain u2's word, so drift ties at 0 and the tie
        // breaks to whichever speaker appears first in the timeline: speaker 1
        expect(report.regular.speakers).toEqual({ count: 2, utterancesPerSpeaker: { 1: 2, 2: 1 } });

        expect(report.exclusive.utterances).toEqual({ total: 3, assigned: 3, skipped: 0, skippedPercent: 0 });
        expect(report.exclusive.ambiguous).toBe(0);
        expect(report.exclusive.fallbackAssigned).toBe(1); // u3
        expect(report.exclusive.timeline).toEqual({ segments: 2, speechSeconds: 12, overlapSeconds: 0 });
        expect(report.exclusive.speakers).toEqual({ count: 2, utterancesPerSpeaker: { 1: 1, 2: 2 } });

        // u3's fallback gap (20 - 12 = 8s) is the only drift in either variant
        expect(report.regular.drift).toEqual({ total: 8, mean: 2.67, nonZero: 1 });
        expect(report.exclusive.drift).toEqual({ total: 8, mean: 2.67, nonZero: 1 });

        expect(report.diff.speakerChanged).toEqual([
            { start: 9.2, end: 9.8, text: 'b', regular: 1, exclusive: 2 },
        ]);
        expect(report.diff.rescuedByExclusive).toBe(0);
        expect(report.diff.lostByExclusive).toBe(0);
    });

    it('adjudicates variants against human speaker turns', () => {
        // Human ground truth matches the exclusive segmentation: A speaks until 9, B after
        const humanTurns = [
            { start: 0, end: 9, tag: 'tagA', label: 'Alice' },
            { start: 9, end: 12, tag: 'tagB', label: 'Bob' },
        ];
        const report = compareDiarizationModes(transcript, diarizeResult, { humanTurns, meeting: 'test/meeting' });

        expect(report.meta?.meeting).toBe('test/meeting');
        const adj = report.adjudication!;
        // regular: u1->spk1 (tagA ok), u2->spk1 (human says tagB) => 1/2
        // exclusive: u1->spk1 (tagA), u2->spk2 (tagB) => 2/2; u3 has no human turn
        expect(adj.scored).toEqual({ regular: 2, exclusive: 2 });
        expect(adj.agreementPercent).toEqual({ regular: 50, exclusive: 100 });
        expect(adj.disagreements).toEqual({
            onlyRegularRight: 0,
            onlyExclusiveRight: 1,
            bothRight: 0,
            neitherRight: 0,
            noHumanSegment: 0,
        });
        // Exclusive's voices map cleanly here: speaker 1 → Alice, speaker 2 → Bob
        expect(adj.clustering.voices).toBe(2);
        expect(adj.clustering.impureUtterances).toBe(0);
        expect(adj.clustering.mixedVoices).toEqual([]);
        expect(adj.clustering.peopleSplitAcrossVoices).toBe(0);

        // regular's speaker 1 majority-maps to Alice; exclusive's speaker 2 maps to Bob
        expect(adj.details).toEqual([
            { start: 9.2, end: 9.8, text: 'b', regularSays: 'Alice', exclusiveSays: 'Bob', humanSays: 'Bob', verdict: 'fixed' },
        ]);
    });

    it('throws when exclusiveDiarization is missing', () => {
        expect(() => compareDiarizationModes(transcript, { ...diarizeResult, exclusiveDiarization: undefined }))
            .toThrow(/exclusiveDiarization/);
    });
});
