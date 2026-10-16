import { describe, expect, it } from 'vitest';
import type { CallRecord } from '../../lib/llm/callRecord.js';
import type { ArchivedRun } from '../../lib/telemetry/archiveSink.js';
import { normalizeExtraction, type RawExtractedDecision } from '../../tasks/utils/decisionPdfExtraction.js';
import type { Case } from '../types.js';
import { decisionsExtraction, extractionLabelValue, scoreExtraction } from './decisionsExtraction.js';
import { decisionsReading } from './decisionsReading.js';
import { documentOfCall } from './pollDecisionsRun.js';

const call = (label: string, out: unknown, callId = 'c1'): CallRecord => ({
    v: 1, callId, label, cacheKey: 'k', startedAt: '', finishedAt: '', request: { model: 'm', max_tokens: 1, messages: [] },
    response: { servedModel: 'm', stopReason: 'end_turn', text: JSON.stringify(out), usage: {}, latencyMs: 1, batchMode: false },
});

const decision = (ada: string, decisionNumber: string | null, meetingDate: string | null, fromKnown = false) => ({
    ada, title: null, pdfUrl: `https://diavgeia.gov.gr/doc/${ada}`, protocolNumber: null, publishDate: null, meetingDate, decisionNumber,
    body: 'Δημοτική Επιτροπή Βριλησσίων', readStatus: 'ok', fromKnown, subjectId: null, confidence: null, reasoning: null,
});

const run = (calls: CallRecord[], result: object, taskType = 'pollDecisions'): ArchivedRun => ({
    run: { traceId: 't', taskType, taskVersion: 4, taskId: 'x', env: 'production', startedAt: '2026-10-10T17:42:41Z', meeting: 'vrilissia/sep23_2026', input: { administrativeBodyName: 'Δημοτική Επιτροπή' } },
    outcome: { status: 'success', endedAt: '' }, phases: [], calls, result, key: 'k',
});

const result = {
    decisions: [decision('A1', '266/2026', '2026-09-23'), decision('A2', '267/2026', '2026-09-23'), decision('K1', '266/2026', '2025-01-01', true)],
    matches: [{ subjectId: 's1', ada: 'A1', pdfUrl: 'https://diavgeia.gov.gr/doc/A1' }],
};

describe('documentOfCall', () => {
    it('finds the document by decision number and date, ignoring echoed known decisions', () => {
        const reading = call('decision-reading', { meetingDate: '2026-09-23', decisionNumber: '266', body: 'x', notADecision: false });
        expect(documentOfCall(reading, run([reading], result))).toEqual({ ada: 'A1', pdfUrl: 'https://diavgeia.gov.gr/doc/A1', city: 'vrilissia', body: 'Δημοτική Επιτροπή' });
    });

    it('names no document when two match, or the call states no number among several', () => {
        const twice = { decisions: [decision('A1', '266/2026', null), decision('A3', '266/2026', null)], matches: [] };
        const reading = call('decision-reading', { meetingDate: null, decisionNumber: '266/2026' });
        expect(documentOfCall(reading, run([reading], twice))).toBeUndefined();
        const blank = call('decision-reading', { meetingDate: null, decisionNumber: null, notADecision: true });
        expect(documentOfCall(blank, run([blank], result))).toBeUndefined();
        expect(documentOfCall(reading, run([reading], result, 'summarize'))).toBeUndefined();
    });

    it("clusters a document under the body it states: a poll's window holds other bodies' decisions too", () => {
        const council = { ...decision('C1', '12/2026', '2026-09-20'), body: 'ΔΗΜΟΤΙΚΟ ΣΥΜΒΟΥΛΙΟ ΒΡΙΛΗΣΣΙΩΝ' };
        const notOne = { ...decision('N1', '5', null), body: null, readStatus: 'not_a_decision' };
        const reading = call('decision-reading', { meetingDate: '2026-09-20', decisionNumber: '12/2026' });
        expect(documentOfCall(reading, run([reading], { decisions: [council, notOne], matches: [] }))?.body).toBe('Δημοτικό Συμβούλιο');
        const other = call('decision-reading', { decisionNumber: '5', meetingDate: null });
        expect(documentOfCall(other, run([other], { decisions: [council, notOne], matches: [] }))?.body).toBe('other');
    });

    it('finds an extracted decision known from an earlier poll through its extraction result and match', () => {
        const known = { decisions: [decision('A1', null, null, true), decision('A2', null, null, true)], matches: [{ subjectId: 's2', ada: 'A2', pdfUrl: 'https://diavgeia.gov.gr/doc/A2' }, { subjectId: 's1', ada: 'A1', pdfUrl: 'https://diavgeia.gov.gr/doc/A1' }], extractions: { decisions: [{ subjectId: 's1', decisionNumber: '8/2026', subjectHeading: 'Θέμα 1' }, { subjectId: 's2', decisionNumber: '9/2026', subjectHeading: 'Θέμα 2' }], warnings: [] } };
        const a = call('decision-extraction', { decisionNumber: '9/2026', subjectHeading: 'Θέμα 2' });
        const b = call('decision-extraction', { decisionNumber: null, subjectHeading: 'Θέμα 1' }, 'c2');
        expect(documentOfCall(a, run([a, b], known))?.ada).toBe('A2');
        expect(documentOfCall(b, run([a, b], known))?.ada).toBe('A1');
    });

    it("falls back to the run's only document for a number-less call", () => {
        const extraction = call('decision-extraction', { decisionNumber: null });
        expect(documentOfCall(extraction, run([extraction], result))?.ada).toBe('A1');
        const other = call('decision-extraction', { decisionNumber: null }, 'c2');
        expect(documentOfCall(extraction, run([extraction, other], result))).toBeUndefined();
    });
});

describe('cases from production calls', () => {
    it("decisions.reading: the document's case, clustered by city and body, the reading as proposals", () => {
        const reading = call('decision-reading', { meetingDate: '2026-09-23', decisionNumber: '266/2026', body: 'Δημοτική Επιτροπή Βριλησσίων', notADecision: false });
        expect(decisionsReading.caseFromCall!(reading, run([reading], result))).toEqual({
            caseId: 'decisions.reading/A1',
            newCase: { input: { ada: 'A1', pdfUrl: 'https://diavgeia.gov.gr/doc/A1' }, cluster: 'vrilissia/Δημοτική Επιτροπή', tags: ['vrilissia', 'production-call'] },
            proposed: { meetingDate: '2026-09-23', decisionNumber: '266/2026', body: 'Δημοτική Επιτροπή Βριλησσίων' },
        });
    });

    const raw = {
        attendanceFormat: 'explicit_present_absent', compositionMembers: null, presentMembers: ['Α Β'], absentMembers: [], mayorPresent: { present: true, rawText: 'ο Δήμαρχος' },
        decisionExcerpt: 'ΑΠΟΦΑΣΙΖΕΙ', decisionNumber: '266/2026', references: '', voteResult: 'Ομόφωνα', voteDetails: [], attendanceChanges: [], discussionOrder: null,
        subjectInfo: { agendaItemIndex: 1, nonAgendaReason: 'outOfAgenda' }, incomplete: false, presidedBy: { name: '', rawText: '' }, actingSecretary: null,
        subjectHeading: '1ο θέμα εκτός ημερήσιας διάταξης', decisionAttendance: null, voteTally: { FOR: null, AGAINST: null, ABSTAIN: null },
    };

    it('decisions.extraction: proposals in the label shape that score as agreeing with the output they came from', () => {
        const extraction = call('decision-extraction', raw);
        const made = decisionsExtraction.caseFromCall!(extraction, run([extraction], result))!;
        expect(made.caseId).toBe('decisions.extraction/A1');
        expect(made.newCase.input).toEqual({ ada: 'A1', pdfUrl: 'https://diavgeia.gov.gr/doc/A1', city: 'vrilissia', body: 'Δημοτική Επιτροπή' });
        expect(made.proposed).toEqual({
            subject: { agendaItemNumber: 1, isOutOfAgenda: true, verified: true },
            mayor: { present: true, verified: true },
            presidedBy: { name: null, verified: true },
            decisionAttendance: { members: null, verified: true },
        });
        const c = { expect: Object.fromEntries(Object.entries(made.proposed).map(([f, value]) => [f, { value }])) } as unknown as Case<never>;
        // Scored against what the suite's run returns: the normalized extraction.
        const outcomes = scoreExtraction(normalizeExtraction(raw as never), c);
        expect(Object.fromEntries(Object.keys(made.proposed).map(f => [f, outcomes[f]]))).toEqual({ subject: 'agree', mayor: 'agree', presidedBy: 'agree', decisionAttendance: 'agree' });
        expect(outcomes).toMatchObject({ rollCall: 'unscorable', votes: 'unscorable', excerpt: 'unscorable' });
        expect(extractionLabelValue(raw as unknown as RawExtractedDecision, 'votes')).toBeUndefined();
    });

    it('decisions.extraction: a partial or closing read makes no case', () => {
        const partial = call('decision-extraction:closing', raw);
        expect(decisionsExtraction.caseFromCall!(partial, run([partial], result))).toBeUndefined();
    });
});
