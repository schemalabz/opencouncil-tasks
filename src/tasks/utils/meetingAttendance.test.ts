import { describe, it, expect } from 'vitest';
import {
    toDocumentEvents,
} from './meetingAttendance.js';
import { withDefaults, type RawExtractedDecision } from './decisionPdfExtraction.js';

describe('toDocumentEvents', () => {
    const resolve = (n: string) => ({ 'Α. Χαμηλοθώρη': 'p1', 'Γ. Ρεμούνδος': 'p2' } as Record<string, string>)[n] ?? null;
    it('passes a per-vote absence through as one entry on the document\'s subject', () => {
        const out = toDocumentEvents([{ name: 'Α. Χαμηλοθώρη', type: 'absent_for_vote', agendaItem: null, timing: null, rawText: 'Κατά τη διαδικασία…',
            anchor: { kind: 'this_document', agendaItem: null, decisionNumber: null, phase: null, timing: null } }], 'sub-1', resolve);
        expect(out).toEqual([
            expect.objectContaining({ type: 'absent_for_vote', personId: 'p1', rawText: 'Κατά τη διαδικασία…',
                anchor: expect.objectContaining({ kind: 'subject', subjectId: 'sub-1', timing: null, decisionNumberTo: null }) }),
        ]);
    });
    it('keeps a stated range of decisions on the wire', () => {
        const out = toDocumentEvents([{ name: 'Γ. Ρεμούνδος', type: 'absent_for_vote', agendaItem: null, timing: null, rawText: 'Εκτός αιθούσης στις με αρ. 31 – 40 ΑΔΣ',
            anchor: { kind: 'decision_number', agendaItem: null, decisionNumber: '31', decisionNumberTo: '40', phase: null, timing: 'during' } }], 'sub-1', resolve);
        expect(out).toEqual([
            expect.objectContaining({ type: 'absent_for_vote', personId: 'p2',
                anchor: expect.objectContaining({ kind: 'decision_number', decisionNumber: '31', decisionNumberTo: '40', subjectId: null }) }),
        ]);
    });
    it('reads a cached per-vote absence from before ranges as one decision, not a range', () => {
        const cached = { attendanceChanges: [{ name: 'Α. Χαμηλοθώρη', type: 'absent_for_vote', agendaItem: null, timing: null, rawText: 'x',
            anchor: { kind: 'this_document', agendaItem: null, decisionNumber: null, phase: null, timing: null } }] } as unknown as RawExtractedDecision;
        const out = toDocumentEvents(withDefaults(cached).attendanceChanges, 'sub-1', resolve);
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ type: 'absent_for_vote', anchor: { kind: 'subject', subjectId: 'sub-1', decisionNumber: null, decisionNumberTo: null } });
    });
    it('maps this_document departures to the subject anchor and keeps other anchors', () => {
        const out = toDocumentEvents([
            { name: 'Γ. Ρεμούνδος', type: 'departure', agendaItem: null, timing: null, rawText: 'x', anchor: { kind: 'this_document', agendaItem: null, decisionNumber: null, phase: null, timing: 'during' } },
            { name: 'Γ. Ρεμούνδος', type: 'arrival', agendaItem: null, timing: null, rawText: 'y', anchor: { kind: 'phase', agendaItem: null, decisionNumber: null, phase: 'pre_agenda', timing: null } },
        ], 'sub-1', resolve);
        expect(out[0].anchor).toMatchObject({ kind: 'subject', subjectId: 'sub-1', timing: 'during' });
        expect(out[1].anchor).toMatchObject({ kind: 'phase', phase: 'pre_agenda', subjectId: null });
        expect(out.every(e => e.reportingPdfCount === 1 && e.totalPdfCount === 1)).toBe(true);
    });
});
