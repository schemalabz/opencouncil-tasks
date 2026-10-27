import type { CallRecord } from '../../lib/llm/callRecord.js';
import type { ArchivedRun } from '../../lib/telemetry/archiveSink.js';
import { sameDecisionNumber } from '../../tasks/utils/decisionNumberCompare.js';
import { sameBody } from '../../tasks/utils/decisionPartition.js';
import type { PollDecisionsResult } from '../../types.js';
import { responseJson } from '../checks/check.js';

export type CallDocument = { ada: string; pdfUrl: string; city: string; body: string };

/**
 * The Diavgeia document a decision-reading or decision-extraction call of a pollDecisions
 * run read. Calls carry no URL (and imported ones no PDF), so the document is the one the
 * run's result lists with the same decision number (and session date, when the call states
 * one), the one its extraction result is matched to, or the run's only document when it
 * made one such call. Ambiguous or unmatched calls have none: a wrong document would
 * mislabel a case.
 */
export function documentOfCall(call: CallRecord, recorded: ArchivedRun): CallDocument | undefined {
    if (recorded.run.taskType !== 'pollDecisions') return undefined;
    const result = recorded.result as PollDecisionsResult | undefined;
    const city = recorded.run.meeting?.split('/')[0];
    if (!city || !result) return undefined;
    const input = recorded.run.input as { administrativeBodyName?: unknown } | undefined;
    const doc = byDecisionNumber(call, result) ?? byExtraction(call, result) ?? onlyDocument(call, recorded, result);
    const body = doc && bodyOf(doc, typeof input?.administrativeBodyName === 'string' ? input.administrativeBodyName : undefined);
    return doc && body ? { ada: doc.ada, pdfUrl: doc.pdfUrl, city, body } : undefined;
}

type Doc = { ada: string; pdfUrl: string; body?: string | null; readStatus?: string };

const BODIES = ['Δημοτικό Συμβούλιο', 'Δημοτική Επιτροπή', 'Επιτροπή Ποιότητας Ζωής', 'Οικονομική Επιτροπή'];

/**
 * The body a case is clustered under, in the cases' spelling. A poll reads every decision
 * in its window, other bodies' too, so the meeting's body names only documents that state
 * it (or that the result does not describe: the meeting's own matches).
 */
function bodyOf(doc: Doc, meetingBody: string | undefined): string | undefined {
    if (doc.readStatus === 'not_a_decision') return 'other';
    if (doc.body === undefined) return meetingBody;
    if (!doc.body) return undefined;
    if (meetingBody && sameBody(doc.body, meetingBody)) return meetingBody;
    return BODIES.find(b => sameBody(doc.body!, b)) ?? doc.body;
}

function byDecisionNumber(call: CallRecord, result: PollDecisionsResult): Doc | undefined {
    const out = responseJson(call) as { decisionNumber?: string | null; meetingDate?: string | null } | undefined;
    const number = out?.decisionNumber?.trim();
    if (!number || !result.decisions) return undefined;
    const date = out?.meetingDate ?? null;
    // A decision echoed from an earlier poll was not read again, but it can still be extracted.
    const reading = call.label === 'decision-reading';
    const matches = result.decisions.filter(d => !(reading && d.fromKnown) && d.decisionNumber && sameDecisionNumber(d.decisionNumber, number) && (!date || !d.meetingDate || d.meetingDate === date));
    return new Set(matches.map(d => d.ada)).size === 1 ? matches[0] : undefined;
}

/**
 * Decisions known from an earlier poll come back without their number, so an extraction is
 * found through the result's own extraction of it (same number, else same printed heading)
 * and the subject that extraction is matched to.
 */
function byExtraction(call: CallRecord, result: PollDecisionsResult): Doc | undefined {
    if (call.label === 'decision-reading' || !result.extractions?.decisions.length) return undefined;
    const out = responseJson(call) as { decisionNumber?: string | null; subjectHeading?: string } | undefined;
    const number = out?.decisionNumber?.trim();
    const heading = out?.subjectHeading?.trim();
    const extracted = result.extractions.decisions;
    let found = number ? extracted.filter(e => e.decisionNumber && sameDecisionNumber(e.decisionNumber, number)) : [];
    if (found.length === 0 && heading) found = extracted.filter(e => e.subjectHeading?.trim() === heading);
    const subjects = new Set(found.map(e => e.subjectId));
    const docs = result.matches.filter(m => subjects.has(m.subjectId));
    return new Set(docs.map(d => d.ada)).size === 1 ? docs[0] : undefined;
}

/** A call that states no number still has a document when the run read only one with that label. */
function onlyDocument(call: CallRecord, recorded: ArchivedRun, result: PollDecisionsResult): Doc | undefined {
    if (recorded.calls.filter(c => c.label === call.label).length !== 1) return undefined;
    const docs = call.label === 'decision-reading'
        ? (result.decisions ?? []).filter(d => !d.fromKnown)
        : result.matches;
    return new Set(docs.map(d => d.ada)).size === 1 ? docs[0] : undefined;
}
