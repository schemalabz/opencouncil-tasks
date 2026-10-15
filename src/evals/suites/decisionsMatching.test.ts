import { describe, expect, it } from 'vitest';
import type { ResultRow } from '../types.js';
import { matchingCase, matchingDetail, matchingReport, scoreMatching, type MatchingInput, type MatchingLinks, type MatchingOutput } from './decisionsMatching.js';

const input: MatchingInput = {
    meeting: 'demo/m1', meetingDate: '2026-09-01', diavgeiaUid: 'org', administrativeBodyName: 'Δημοτική Επιτροπή',
    subjects: ['s1', 's2', 's3', 's4'].map((subjectId, i) => ({ subjectId, name: `Θέμα ${i + 1}`, agendaItemIndex: i + 1, nonAgendaReason: null })),
};
const who = { by: 'user', at: '2026-09-02', source: 'opencouncil:decision-link', signal: 'opencouncil:decision-link:assign:d1' };
const links: MatchingLinks = {
    human: new Map([['s1', { ada: 'A1', expected: who }]]),
    task: new Map([['s2', 'A2'], ['s1', 'A9']]),
    rejected: new Map([['R1', { subjectId: 's3', expected: { ...who, signal: 'opencouncil:decision-link:dismiss:c1' } }], ['A2', { subjectId: null, expected: who }]]),
};
const c = matchingCase(input, links, new Date('2026-10-11T00:00:00Z'));
const out = (proposals: Record<string, string>): MatchingOutput => ({ proposals, window: { fetched: 0, inMeeting: 0, fallback: 0 } });

describe('decisions.matching cases', () => {
    it('imports a person\'s link, drafts the task\'s own and the unlinked, and drops a rejection the meeting links', () => {
        expect(c.expect['link[s1]']).toMatchObject({ value: 'A1', tier: 'imported', signal: 'opencouncil:decision-link:assign:d1' });
        expect(c.expect['link[s2]']).toMatchObject({ value: 'A2', tier: 'drafted', source: 'opencouncil:task-link' });
        expect(c.expect['link[s3]']).toMatchObject({ value: null, tier: 'drafted' });
        expect(c.expect['reject[R1]']).toMatchObject({ value: { subjectId: 's3' }, tier: 'imported' });
        expect(c.expect['reject[A2]']).toBeUndefined();
        expect(c).toMatchObject({ id: 'decisions.matching/demo-m1', cluster: 'demo/Δημοτική Επιτροπή', replay: null });
    });
});

describe('decisions.matching scoring', () => {
    it('agrees everywhere with the links as the output (oracle)', () => {
        expect(new Set(Object.values(scoreMatching(out({ s1: 'A1', s2: 'A2' }), c)))).toEqual(new Set(['agree']));
    });

    it('scores an empty output as missed links, never agreement on them (null)', () => {
        expect(scoreMatching(out({}), c)).toMatchObject({ 'link[s1]': 'missing', 'link[s2]': 'missing', 'link[s3]': 'agree' });
    });

    it('names wrong, extra and a dismissed candidate proposed again', () => {
        const d = matchingDetail(out({ s1: 'A2', s3: 'R1', s4: 'X' }), c);
        expect(d).toMatchObject({ 'link[s1]': 'wrong', 'link[s3]': 'extra', 'link[s4]': 'extra', 'reject[R1]': 'rejected-proposed' });
        expect(scoreMatching(out({ s1: 'A2', s3: 'R1' }), c)['reject[R1]']).toBe('disagree');
    });

    it('reports recall and precision as the old command did, human values apart', () => {
        const row = { caseId: c.id, rep: 0, detail: matchingDetail(out({ s1: 'A1', s4: 'X' }), c) } as unknown as ResultRow;
        const report = matchingReport([row], [c]);
        expect(report).toContain('imported/adjudicated values:\n  linked subjects: 1\n  recall:    1/1  100.0%\n  precision: 1/1  100.0%');
        expect(report).toContain('all values:\n  linked subjects: 2\n  recall:    1/2  50.0%\n  precision: 1/2  50.0%');
    });
});
