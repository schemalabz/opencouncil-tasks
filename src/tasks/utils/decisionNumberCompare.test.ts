import { describe, it, expect } from 'vitest';
import { sameDecisionNumber } from './decisionNumberCompare.js';

describe('sameDecisionNumber', () => {
    it('matches identical forms', () => {
        expect(sameDecisionNumber('206', '206')).toBe(true);
        expect(sameDecisionNumber('123/2024', '123/2024')).toBe(true);
    });

    it('matches across formatting variants of the same number', () => {
        expect(sameDecisionNumber('123/2024', '123-2024')).toBe(true);
        expect(sameDecisionNumber('67/17-07-2026', '67')).toBe(true);
        expect(sameDecisionNumber('1487/2026', '1487')).toBe(true);
    });

    it('a year on one side only is not a disagreement', () => {
        expect(sameDecisionNumber('142', '142/2026')).toBe(true);
    });

    it('differing cores disagree', () => {
        expect(sameDecisionNumber('142', '143')).toBe(false);
        expect(sameDecisionNumber('1487/2026', '148/2026')).toBe(false);
    });

    it('differing years disagree when both sides state one', () => {
        expect(sameDecisionNumber('123/2024', '123/2025')).toBe(false);
    });

    it('a date inside the number does not masquerade as the year', () => {
        // "67/17-07-2026": core 67, year 2026
        expect(sameDecisionNumber('67/17-07-2026', '67/2026')).toBe(true);
    });

    it('valueless inputs never agree', () => {
        expect(sameDecisionNumber('—', '5')).toBe(false);
    });
});
