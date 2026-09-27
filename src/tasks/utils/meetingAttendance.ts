import { AttendanceChange, AttendanceAnchor, changeAnchor } from './decisionPdfExtraction.js';
import type { AttendanceEvent } from '../../types.js';

/** The anchor as the wire carries it; «this document» becomes the document's own subject. */
export function wireAnchor(a: AttendanceAnchor, subjectId: string): AttendanceEvent['anchor'] {
    const kind = a.kind === 'this_document' ? 'subject' : a.kind;
    return {
        kind,
        agendaItemIndex: a.agendaItem?.agendaItemIndex ?? null,
        nonAgendaReason: a.agendaItem?.nonAgendaReason ?? null,
        decisionNumber: a.decisionNumber,
        decisionNumberTo: a.decisionNumberTo ?? null,
        subjectId: kind === 'subject' ? subjectId : null,
        phase: a.phase,
        timing: a.timing,
    };
}

/**
 * The changes one document states, on the wire, each as the page states it:
 * a per-vote absence stays one entry, and «this document» anchors become the
 * document's own subject. opencouncil combines per-vote absences across pages.
 */
export function toDocumentEvents(changes: AttendanceChange[], subjectId: string, resolve: (name: string) => string | null): AttendanceEvent[] {
    return changes.map(c => ({
        personId: resolve(c.name), name: c.name, type: c.type, anchor: wireAnchor(changeAnchor(c), subjectId),
        rawText: c.rawText, reportingPdfCount: 1, totalPdfCount: 1,
    }));
}
