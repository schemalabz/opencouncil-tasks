import { describe, it, expect } from 'vitest';
import { pickDiarizationTimeline } from './PyannoteDiarize.js';
import { Diarization } from '../types.js';

const overlapping: Diarization = [
    { start: 0, end: 6, speaker: 'A' },
    { start: 5, end: 10, speaker: 'B' },
];
const exclusive: Diarization = [
    { start: 0, end: 5.5, speaker: 'A' },
    { start: 5.5, end: 10, speaker: 'B' },
];

describe('pickDiarizationTimeline', () => {
    it('prefers the exclusive timeline when present', () => {
        expect(pickDiarizationTimeline({ diarization: overlapping, exclusiveDiarization: exclusive })).toBe(exclusive);
    });

    it('falls back to the overlapping timeline when exclusiveDiarization is missing', () => {
        expect(pickDiarizationTimeline({ diarization: overlapping })).toBe(overlapping);
    });

    it('falls back to the overlapping timeline when exclusiveDiarization is empty', () => {
        expect(pickDiarizationTimeline({ diarization: overlapping, exclusiveDiarization: [] })).toBe(overlapping);
    });
});
