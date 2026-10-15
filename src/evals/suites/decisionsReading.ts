import { normalizeReading, readDecisionDocument, type DecisionReading } from '../../tasks/utils/readDecisionDocument.js';
import { sameDecisionNumber } from '../../tasks/utils/decisionNumberCompare.js';
import { sameBody } from '../../tasks/utils/decisionPartition.js';
import type { Case, FieldOutcome } from '../types.js';
import type { CallRecord } from '../../lib/llm/callRecord.js';
import type { ArchivedRun } from '../../lib/telemetry/archiveSink.js';
import { responseJson } from '../checks/check.js';
import { documentOfCall } from './pollDecisionsRun.js';
import type { CallCase, Suite } from './suite.js';

export type ReadingInput = { ada: string; pdfUrl: string };

const expected = (c: Case, field: string) => c.expect[field]?.value as string | null | undefined;

/**
 * A document of kind `other` is not a session decision: the right answer is no
 * session date at all, so a date read off it is a false positive. A meetingDate
 * labelled null is the same answer for a decision whose page states no date.
 */
export function scoreReading(read: DecisionReading, c: Case<ReadingInput>): Record<string, FieldOutcome> {
    const kind = expected(c, 'kind') ?? 'decision';
    const out: Record<string, FieldOutcome> = {};

    const date = expected(c, 'meetingDate');
    if (kind === 'other' || date === null) out.meetingDate = read.meetingDate ? 'disagree' : 'agree';
    else if (!read.meetingDate) out.meetingDate = 'missing';
    else if (!date) out.meetingDate = 'unscorable';
    else out.meetingDate = read.meetingDate === date ? 'agree' : 'disagree';

    const number = expected(c, 'decisionNumber');
    if (kind !== 'decision' || !number) out.decisionNumber = 'unscorable';
    else if (!read.decisionNumber) out.decisionNumber = 'missing';
    else out.decisionNumber = sameDecisionNumber(read.decisionNumber, number) ? 'agree' : 'disagree';

    const body = expected(c, 'body');
    if (kind !== 'decision' || !body) out.body = 'unscorable';
    else if (!read.body) out.body = 'missing';
    else out.body = sameBody(read.body, body) ? 'agree' : 'disagree';

    return out;
}

const READ_FIELDS = ['meetingDate', 'decisionNumber', 'body'] as const;
const LABEL_FIELDS = [...READ_FIELDS, 'kind'] as const;

function labelValue(read: DecisionReading, field: string): unknown {
    if (field === 'kind') return read.notADecision ? 'other' : 'decision';
    return (READ_FIELDS as readonly string[]).includes(field) ? read[field as (typeof READ_FIELDS)[number]] ?? null : undefined;
}

function caseFromCall(call: CallRecord, recorded: ArchivedRun): CallCase | undefined {
    const doc = documentOfCall(call, recorded);
    const raw = responseJson(call);
    if (!doc || !raw || typeof raw !== 'object') return undefined;
    const read = normalizeReading(raw as Parameters<typeof normalizeReading>[0]);
    return {
        caseId: `decisions.reading/${doc.ada}`,
        newCase: { input: { ada: doc.ada, pdfUrl: doc.pdfUrl } satisfies ReadingInput, cluster: `${doc.city}/${doc.body}`, tags: [doc.city, 'production-call'] },
        proposed: Object.fromEntries(LABEL_FIELDS.map(f => [f, labelValue(read, f)])),
    };
}

export const decisionsReading: Suite<ReadingInput, DecisionReading> = {
    id: 'decisions.reading',
    task: 'pollDecisions',
    labels: ['decision-reading'],
    run: async c => (await readDecisionDocument(c.input.pdfUrl)).result,
    score: scoreReading,
    labelValue,
    caseFromCall,
    noveltyFields: ['decisionNumber'],
};
