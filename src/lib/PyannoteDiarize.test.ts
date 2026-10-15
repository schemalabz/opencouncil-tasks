import { describe, it, expect } from 'vitest';
import { isValidMatch, PLACEHOLDER_VOICEPRINT_LABEL, pickDiarizationTimeline } from './PyannoteDiarize.js';
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

describe('isValidMatch', () => {
    it('accepts a match on a real voiceprint at or above the threshold', () => {
        expect(isValidMatch({ match: 'anna', confidence: { anna: 50, babis: 10 } }, 50)).toBe(true);
    });

    it('rejects a match below the threshold, and no match at all', () => {
        expect(isValidMatch({ match: 'anna', confidence: { anna: 49 } }, 50)).toBe(false);
        expect(isValidMatch({ match: null, confidence: {} }, 50)).toBe(false);
        expect(isValidMatch(undefined, 50)).toBe(false);
    });

    it('rejects a match on the placeholder voiceprint of a request without voiceprints', () => {
        expect(isValidMatch({ match: PLACEHOLDER_VOICEPRINT_LABEL, confidence: { [PLACEHOLDER_VOICEPRINT_LABEL]: 99 } }, 50)).toBe(false);
    });
});
