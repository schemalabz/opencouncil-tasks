import { describe, it, expect } from 'vitest';
import { normalizeReading } from './readDecisionDocument.js';

describe('normalizeReading', () => {
    it('passes a well-formed reading through', () => {
        expect(normalizeReading({ meetingDate: '2026-06-02', decisionNumber: '425/2026', body: 'ΔΗΜΟΤΙΚΗ ΕΠΙΤΡΟΠΗ' })).toEqual({
            meetingDate: '2026-06-02',
            decisionNumber: '425/2026',
            body: 'ΔΗΜΟΤΙΚΗ ΕΠΙΤΡΟΠΗ',
            notADecision: false,
        });
    });

    it('trims whitespace and turns blanks into nulls', () => {
        expect(normalizeReading({ meetingDate: '  2026-06-02 ', decisionNumber: '', body: ' ' })).toEqual({
            meetingDate: '2026-06-02',
            decisionNumber: null,
            body: null,
            notADecision: false,
        });
    });

    it('rejects a date that is not YYYY-MM-DD', () => {
        expect(normalizeReading({ meetingDate: '02/06/2026' }).meetingDate).toBeNull();
        expect(normalizeReading({ meetingDate: '2026-6-2' }).meetingDate).toBeNull();
        expect(normalizeReading({ meetingDate: '2 Ιουνίου 2026' }).meetingDate).toBeNull();
    });

    it('rejects an impossible calendar date', () => {
        expect(normalizeReading({ meetingDate: '2026-02-30' }).meetingDate).toBeNull();
        expect(normalizeReading({ meetingDate: '2026-13-01' }).meetingDate).toBeNull();
    });

    it('rejects an implausible year', () => {
        expect(normalizeReading({ meetingDate: '1926-06-02' }).meetingDate).toBeNull();
        expect(normalizeReading({ meetingDate: '3026-06-02' }).meetingDate).toBeNull();
    });

    it('tolerates missing keys entirely', () => {
        expect(normalizeReading({})).toEqual({ meetingDate: null, decisionNumber: null, body: null, notADecision: false });
    });

    it('a not-a-decision classification nulls every field', () => {
        expect(normalizeReading({ meetingDate: '2026-06-02', decisionNumber: '5', body: 'X', notADecision: true })).toEqual({
            meetingDate: null, decisionNumber: null, body: null, notADecision: true,
        });
    });
});
