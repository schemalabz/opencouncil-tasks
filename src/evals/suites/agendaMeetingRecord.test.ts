import { describe, expect, it } from 'vitest';
import type { AgendaMeetingRecord } from '../../types.js';
import { loadCases } from '../cases/caseStore.js';
import { agendaMeetingRecord, caseFromLabel, meetingRecordReport, type MeetingRecordLabel, type MeetingRecordReading } from './agendaMeetingRecord.js';

const row = { cityId: 'sparta', meetingId: 'jan30_2026', date: '2026-01-30', time: '18:00', agendaUrl: 'u', administrativeBody: { name: 'Δημοτικό Συμβούλιο', type: 'council' as const } };
const label: MeetingRecordLabel = {
    key: 'sparta__jan30_2026', kind: 'ordinary', urgent: true, sessionNumber: null, format: 'inPerson',
    quotes: { kind: null, sessionNumber: null, format: 'στην αίθουσα' }, confidence: 'high', note: 'ΑΡΙΘ. ΠΡΟΣΚΛΗΣΕΩΣ is no session number',
};
const provenance = { by: 'labels', at: '2026-10-13', source: 'labels:test' };

const reading = (record: Partial<AgendaMeetingRecord> | null): MeetingRecordReading => ({
    record: record && { kind: null, kindEvidence: null, urgent: false, urgentEvidence: null, sessionNumber: null, sessionNumberEvidence: null, format: null, formatEvidence: null, ...record },
    meetings: [], thisMeeting: 0, warnings: [],
});

describe('agenda.meetingRecord', () => {
    const c = caseFromLabel(label, row, provenance);

    it('keeps null as a value, and tells a wrong value from a missing one', () => {
        expect(agendaMeetingRecord.score(reading({ kind: 'ordinary', urgent: true, format: 'inPerson' }), c))
            .toEqual({ kind: 'agree', urgent: 'agree', sessionNumber: 'agree', format: 'agree' });
        // A printed invitation number read as a session number is written wrong; an unread urgency only leaves it to a person.
        expect(agendaMeetingRecord.score(reading({ kind: 'special', urgent: false, sessionNumber: 48, format: null }), c))
            .toEqual({ kind: 'disagree', urgent: 'missing', sessionNumber: 'disagree', format: 'missing' });
        expect(agendaMeetingRecord.score(reading(null), c)).toMatchObject({ kind: 'missing', sessionNumber: 'agree' });
    });

    it('makes a low-confidence label contested, so nothing scores it', () => {
        const low = caseFromLabel({ ...label, confidence: 'low' }, row, provenance);
        expect(Object.values(low.expect).map(e => e.tier)).toEqual(['contested', 'contested', 'contested', 'contested']);
        expect(Object.values(agendaMeetingRecord.score(reading({ kind: 'special' }), low))).toEqual(['unscorable', 'unscorable', 'unscorable', 'unscorable']);
        expect(c.expect.format).toMatchObject({ tier: 'adjudicated', evidence: 'στην αίθουσα' });
        expect(c.expect.kind.evidence).toBeUndefined();
    });

    it('reports human-tier and all labels apart', () => {
        const low = { ...caseFromLabel({ ...label, key: 'sparta__feb1_2026', confidence: 'low' }, { ...row, meetingId: 'feb1_2026' }, provenance), split: 'dev' as const };
        const out = reading({ kind: 'special', urgent: true, format: 'inPerson' });
        const rows = [c, low].map(k => ({ caseId: k.id, detail: agendaMeetingRecord.detail!(out, k) })) as never[];
        const report = meetingRecordReport(rows, [{ ...c, split: 'dev' }, low]);
        expect(report).toContain('adjudicated/imported labels:\n  kind           0/1 equal');
        expect(report).toContain('all labels, contested included:\n  kind           0/2 equal (0.0%), 2 wrong value, 0 missed');
        expect(report).toContain('sparta__feb1_2026 kind: wrong (label ordinary, read special) [contested]');
    });

    it('holds the 163 labelled invitations, adjudicated or contested only', () => {
        const cases = loadCases('agenda.meetingRecord');
        expect(cases).toHaveLength(163);
        expect(new Set(cases.flatMap(k => Object.values(k.expect).map(e => e.tier)))).toEqual(new Set(['adjudicated', 'contested']));
    });
});
