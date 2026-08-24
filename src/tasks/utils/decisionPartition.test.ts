import { describe, it, expect } from 'vitest';
import { sameSessionDate, sameBody, partitionReadDecisions, type ReadDecision } from './decisionPartition.js';

function rd(ada: string, meetingDate: string | null, opts: { readStatus?: string; body?: string | null } = {}): ReadDecision {
    return {
        decision: { ada } as ReadDecision['decision'],
        reading: meetingDate || opts.body
            ? { meetingDate, decisionNumber: null, body: opts.body ?? null, notADecision: false }
            : null,
        readStatus: opts.readStatus ?? (meetingDate ? 'ok' : 'no_meeting_date'),
        fromKnown: false,
    };
}

describe('sameSessionDate', () => {
    it('is exact equality (adjudication confirmed all off-by-ones were label-side)', () => {
        expect(sameSessionDate('2026-06-02', '2026-06-02')).toBe(true);
        expect(sameSessionDate('2026-06-03', '2026-06-02')).toBe(false);
    });
});

describe('sameBody', () => {
    it('matches across case, accents and a municipality suffix', () => {
        expect(sameBody('ΔΗΜΟΤΙΚΟ ΣΥΜΒΟΥΛΙΟ ΔΗΜΟΥ ΧΑΝΙΩΝ', 'Δημοτικό Συμβούλιο')).toBe(true);
        expect(sameBody('ΔΗΜΟΤΙΚΗ ΕΠΙΤΡΟΠΗ', 'Δημοτική Επιτροπή')).toBe(true);
    });

    it('distinguishes different bodies', () => {
        expect(sameBody('ΔΗΜΟΤΙΚΗ ΕΠΙΤΡΟΠΗ', 'Δημοτικό Συμβούλιο')).toBe(false);
        expect(sameBody('5η Δημοτική Κοινότητα', 'Δημοτικό Συμβούλιο')).toBe(false);
    });
});

describe('partitionReadDecisions', () => {
    it('splits into inMeeting / elsewhere / fallback / nonDecisions', () => {
        const reads = [
            rd('A', '2026-06-02'),
            rd('B', '2026-06-09'),
            rd('C', null),
            rd('D', null, { readStatus: 'unreadable' }),
            rd('E', null, { readStatus: 'not_a_decision' }),
        ];
        const p = partitionReadDecisions(reads, '2026-06-02');
        expect(p.inMeeting.map(r => r.decision.ada)).toEqual(['A']);
        expect(p.elsewhere.map(r => r.decision.ada)).toEqual(['B']);
        expect(p.fallback.map(r => r.decision.ada)).toEqual(['C', 'D']);
        expect(p.nonDecisions.map(r => r.decision.ada)).toEqual(['E']);
    });

    it('a body mismatch overrides a date match (shared-unit municipalities)', () => {
        const reads = [
            rd('DS', '2026-06-02', { body: 'ΔΗΜΟΤΙΚΟ ΣΥΜΒΟΥΛΙΟ ΔΗΜΟΥ ΣΠΑΡΤΗΣ' }),
            rd('DE', '2026-06-02', { body: 'ΔΗΜΟΤΙΚΗ ΕΠΙΤΡΟΠΗ' }),
        ];
        const p = partitionReadDecisions(reads, '2026-06-02', 'Δημοτικό Συμβούλιο');
        expect(p.inMeeting.map(r => r.decision.ada)).toEqual(['DS']);
        expect(p.elsewhere.map(r => r.decision.ada)).toEqual(['DE']);
    });

    it('an unknown body on either side falls back to date-only', () => {
        const reads = [rd('A', '2026-06-02', { body: null })];
        expect(partitionReadDecisions(reads, '2026-06-02', 'Δημοτικό Συμβούλιο').inMeeting).toHaveLength(1);
        const reads2 = [rd('B', '2026-06-02', { body: 'ΔΗΜΟΤΙΚΗ ΕΠΙΤΡΟΠΗ' })];
        expect(partitionReadDecisions(reads2, '2026-06-02', null).inMeeting).toHaveLength(1);
    });

    it('a known decision that names another meeting never enters the pool', () => {
        const reads = [{ ...rd('E', '2026-06-09'), fromKnown: true }];
        const p = partitionReadDecisions(reads, '2026-06-02');
        expect(p.inMeeting).toEqual([]);
        expect(p.elsewhere.map(r => r.decision.ada)).toEqual(['E']);
    });
});
