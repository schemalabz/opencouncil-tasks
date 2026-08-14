import { describe, it, expect } from 'vitest';
import { sameSessionDate, partitionReadDecisions, type ReadDecision } from './decisionPartition.js';

function rd(ada: string, meetingDate: string | null, readStatus = meetingDate ? 'ok' : 'no_meeting_date'): ReadDecision {
    return {
        decision: { ada } as ReadDecision['decision'],
        reading: meetingDate ? { meetingDate, decisionNumber: null } : null,
        readStatus,
        fromKnown: false,
    };
}

describe('sameSessionDate', () => {
    it('is exact equality for now (tolerance is an adjudication-pending policy)', () => {
        expect(sameSessionDate('2026-06-02', '2026-06-02')).toBe(true);
        expect(sameSessionDate('2026-06-03', '2026-06-02')).toBe(false);
    });
});

describe('partitionReadDecisions', () => {
    it('splits into inMeeting / elsewhere / fallback', () => {
        const reads = [
            rd('A', '2026-06-02'),
            rd('B', '2026-06-09'),
            rd('C', null),
            rd('D', null, 'unreadable'),
        ];
        const p = partitionReadDecisions(reads, '2026-06-02');
        expect(p.inMeeting.map(r => r.decision.ada)).toEqual(['A']);
        expect(p.elsewhere.map(r => r.decision.ada)).toEqual(['B']);
        expect(p.fallback.map(r => r.decision.ada)).toEqual(['C', 'D']);
    });

    it('a known decision that names another meeting never enters the pool', () => {
        const reads = [{ ...rd('E', '2026-06-09'), fromKnown: true }];
        const p = partitionReadDecisions(reads, '2026-06-02');
        expect(p.inMeeting).toEqual([]);
        expect(p.elsewhere.map(r => r.decision.ada)).toEqual(['E']);
    });
});
