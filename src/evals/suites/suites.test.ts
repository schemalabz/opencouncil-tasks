import { describe, expect, it } from 'vitest';
import { scoreReading } from './decisionsReading.js';
import { scoreExtraction } from './decisionsExtraction.js';
import type { Case, Expected } from '../types.js';
import { loadCases } from '../cases/caseStore.js';
import { STORED_LABEL_ANCHORS, type ExtractionLabel, type StoredLabelAnchor } from '../../tasks/utils/extractionScoring.js';

const exp = (value: unknown): Expected => ({ value, tier: 'adjudicated', by: 'test', at: '2026-10-11', source: 'test' });
const readingCase = (expect: Record<string, unknown>): Case<{ ada: string; pdfUrl: string }> => ({
    id: 'decisions.reading/X', suite: 'decisions.reading', split: 'dev', input: { ada: 'X', pdfUrl: 'u' }, cluster: 'c', tags: [],
    expect: Object.fromEntries(Object.entries(expect).map(([k, v]) => [k, exp(v)])),
});

describe('decisions.reading scoring', () => {
    const decision = readingCase({ kind: 'decision', meetingDate: '2026-07-18', decisionNumber: '120/2026', body: 'Δημοτική Επιτροπή' });

    it('agrees with an output equal to the labels (oracle)', () => {
        expect(scoreReading({ meetingDate: '2026-07-18', decisionNumber: '120/2026', body: 'Δημοτική Επιτροπή', notADecision: false }, decision))
            .toEqual({ meetingDate: 'agree', decisionNumber: 'agree', body: 'agree' });
    });
    it('scores an empty reading as missing, never as agreement (null)', () => {
        expect(scoreReading({ meetingDate: null, decisionNumber: null, body: null, notADecision: true }, decision))
            .toEqual({ meetingDate: 'missing', decisionNumber: 'missing', body: 'missing' });
    });
    it('treats a date read off a non-decision as a false positive and its absence as correct', () => {
        const other = readingCase({ kind: 'other', meetingDate: null, decisionNumber: null });
        expect(scoreReading({ meetingDate: null, decisionNumber: null, body: null, notADecision: true }, other).meetingDate).toBe('agree');
        expect(scoreReading({ meetingDate: '2026-01-01', decisionNumber: null, body: null, notADecision: false }, other).meetingDate).toBe('disagree');
        expect(scoreReading({ meetingDate: null, decisionNumber: null, body: null, notADecision: true }, other).decisionNumber).toBe('unscorable');
    });
    it('compares decision numbers and bodies leniently', () => {
        const out = scoreReading({ meetingDate: '2026-07-18', decisionNumber: '120', body: 'ΔΗΜΟΤΙΚΗ ΕΠΙΤΡΟΠΗ', notADecision: false }, decision);
        expect(out.decisionNumber).toBe('agree');
        expect(out.body).toBe('agree');
    });
});

describe('decisions.extraction scoring', () => {
    // A real case, so the test follows the labels' shape rather than a guess at it.
    const c = loadCases('decisions.extraction').find(k => k.id === 'decisions.extraction/6ΥΙΡΩΨ3-9ΟΨ')!;

    it('scores an empty reading as missing wherever the label holds a value (null)', () => {
        const outcomes = scoreExtraction(null, c as never);
        expect(outcomes).toMatchObject({ rollCall: 'missing', attendanceChanges: 'missing', votes: 'missing', excerpt: 'missing' });
        // A null item number is itself a valid reading, so an empty output can agree on it;
        // the runner never scores failed calls, which is what keeps a broken variant from scoring here.
        expect(outcomes.subject).toBe('agree');
    });
    it('scores a value a review settled though the value itself still reads verified: false', () => {
        const presidedBy = (tier: Expected['tier'], verified: unknown): Case => ({ ...c, expect: { presidedBy: { ...exp({ name: 'Παπαδόπουλος Γιώργος', verified }), tier } } });
        expect(scoreExtraction(null, presidedBy('adjudicated', false) as never).presidedBy).toBe('missing');
        expect(scoreExtraction(null, presidedBy('contested', false) as never).presidedBy).toBe('unscorable');
        expect(scoreExtraction(null, presidedBy('adjudicated', 'unresolvable') as never).presidedBy).toBe('unscorable');
    });
    it('does not score a value a review left contested, though the value itself still reads verified: true', () => {
        const presidedBy = (tier: Expected['tier'], verified: unknown): Case => ({ ...c, expect: { presidedBy: { ...exp({ name: 'Παπαδόπουλος Γιώργος', verified }), tier } } });
        expect(scoreExtraction(null, presidedBy('contested', true) as never).presidedBy).toBe('unscorable');
        expect(scoreExtraction(null, presidedBy('drafted', true) as never).presidedBy).toBe('missing');
        expect(scoreExtraction(null, presidedBy('drafted', false) as never).presidedBy).toBe('unscorable');
    });
    it('only ever yields the four suite outcomes', () => {
        const outcomes = scoreExtraction(null, c as never);
        for (const o of Object.values(outcomes)) expect(['agree', 'disagree', 'missing', 'unscorable']).toContain(o);
        expect(outcomes.perVoteAbsence ?? 'unscorable').toBe('unscorable');
    });
});

// The label type disciplines the TypeScript that reads the cases, never the JSON on disk. The
// shapes it forbids are the ones that used to score a weaker comparison in silence: a label
// saying the page records no change while listing some had its list compared anyway, because
// no scorer read `stated`.
describe('decisions.extraction attendance labels', () => {
    const labels = loadCases('decisions.extraction')
        .filter(c => c.expect.attendanceChanges)
        .map(c => ({ where: c.id, ac: c.expect.attendanceChanges.value as ExtractionLabel['attendanceChanges'] }));

    it('holds the labels the measurement reports on', () => {
        expect(labels.length).toBeGreaterThan(100);
    });

    it('carries an anchor and a list exactly when it says the page states a change', () => {
        const wrong = labels.filter(({ ac }) => ac.stated
            ? !STORED_LABEL_ANCHORS.includes(ac.anchoredBy as StoredLabelAnchor) || !Array.isArray(ac.asExtracted)
            : ac.anchoredBy !== undefined || ac.asExtracted !== undefined);
        expect(wrong.map(l => l.where)).toEqual([]);
    });
});
