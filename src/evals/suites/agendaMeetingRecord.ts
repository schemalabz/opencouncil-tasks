import { readExportedMeeting, type AgendaMeetingsReading, type MeetingRecordExportRow } from '../../lib/agendaMeetingRecord.js';
import type { AgendaMeetingRecord } from '../../types.js';
import { assignSplit } from '../cases/caseStore.js';
import { HUMAN_TIERS, type Case, type Expected, type FieldOutcome, type ResultRow } from '../types.js';
import type { Suite } from './suite.js';

export const MEETING_RECORD_FIELDS = ['kind', 'urgent', 'sessionNumber', 'format'] as const;
type RecordField = (typeof MEETING_RECORD_FIELDS)[number];

export type MeetingRecordReading = Pick<AgendaMeetingsReading, 'record' | 'meetings' | 'thisMeeting' | 'warnings'>;

/** A label of one invitation: what the sitting is, read from the document with the phrase it rests on. */
export interface MeetingRecordLabel {
    /** "<cityId>__<meetingId>" */
    key: string;
    kind: AgendaMeetingRecord['kind'];
    urgent: boolean;
    sessionNumber: number | null;
    format: AgendaMeetingRecord['format'];
    multipleSittings?: boolean;
    quotes?: Partial<Record<RecordField, string | null>>;
    confidence?: 'high' | 'low';
    note?: string;
}

/** equal: the record holds the label (null included); wrong: it holds another value; missed: it holds none. */
export type RecordVerdict = 'equal' | 'wrong' | 'missed';

export function recordVerdict(want: unknown, got: unknown): RecordVerdict {
    if ((want ?? null) === (got ?? null)) return 'equal';
    // A wrong value would be written; a missing one (or an unread urgency) only leaves the field to a person.
    return got !== null && got !== undefined && got !== false ? 'wrong' : 'missed';
}

const OUTCOME: Record<RecordVerdict, FieldOutcome> = { equal: 'agree', wrong: 'disagree', missed: 'missing' };

const read = (output: MeetingRecordReading, field: RecordField) => output.record?.[field] ?? null;

export function scoreMeetingRecord(output: MeetingRecordReading, c: Case<MeetingRecordExportRow>): Record<string, FieldOutcome> {
    const out: Record<string, FieldOutcome> = {};
    for (const field of MEETING_RECORD_FIELDS) {
        const e = c.expect[field];
        if (!e) continue;
        out[field] = e.tier === 'contested' ? 'unscorable' : OUTCOME[recordVerdict(e.value, read(output, field))];
    }
    return out;
}

/** Per field the verdict, and for a disagreement what was read and the phrase it was read from. */
function detailMeetingRecord(output: MeetingRecordReading, c: Case<MeetingRecordExportRow>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const field of MEETING_RECORD_FIELDS) {
        const e = c.expect[field];
        if (!e) continue;
        const got = read(output, field);
        const verdict = recordVerdict(e.value, got);
        const evidence = output.record?.[`${field}Evidence`];
        out[field] = verdict === 'equal' ? verdict : `${verdict} (label ${e.value ?? '-'}, read ${got ?? '-'})${evidence ? ` «${evidence}»` : ''}`;
    }
    return out;
}

/**
 * Per field, how often the record equals the label, over the human-tier labels (what a gate
 * reads) and over every label, contested included; then each disagreement. Holdout case ids
 * stay hidden, as in `compare`.
 */
export function meetingRecordReport(rows: ResultRow[], cases: Case<MeetingRecordExportRow>[]): string {
    const byId = new Map(cases.map(c => [c.id, c]));
    const groups = { human: new Map<string, Record<RecordVerdict, number>>(), all: new Map<string, Record<RecordVerdict, number>>() };
    const disagreements: string[] = [];
    let hiddenHoldout = 0;
    for (const row of rows) {
        const c = byId.get(row.caseId);
        for (const [field, detail] of Object.entries(row.detail ?? {})) {
            const verdict = detail.split(' ')[0] as RecordVerdict;
            const tier = c?.expect[field]?.tier;
            for (const [name, tally] of Object.entries(groups)) {
                if (name === 'human' && !(tier && HUMAN_TIERS.includes(tier))) continue;
                const t = tally.get(field) ?? { equal: 0, wrong: 0, missed: 0 };
                t[verdict]++;
                tally.set(field, t);
            }
            if (verdict === 'equal') continue;
            if (c?.split === 'holdout') { hiddenHoldout++; continue; }
            const stem = row.caseId.slice(row.caseId.indexOf('/') + 1);
            disagreements.push(`${stem} ${field}: ${detail}${tier === 'contested' ? ' [contested]' : ''}${c?.note ? `  [label note: ${c.note}]` : ''}`);
        }
    }
    const lines: string[] = [`${rows.length} row(s) over ${new Set(rows.map(r => r.caseId)).size} meeting(s)`];
    for (const [name, tally] of Object.entries(groups)) {
        lines.push('', name === 'human' ? 'adjudicated/imported labels:' : 'all labels, contested included:');
        for (const field of MEETING_RECORD_FIELDS) {
            const t = tally.get(field);
            if (!t) continue;
            const total = t.equal + t.wrong + t.missed;
            lines.push(`  ${field.padEnd(14)} ${t.equal}/${total} equal (${(100 * t.equal / Math.max(1, total)).toFixed(1)}%), ${t.wrong} wrong value, ${t.missed} missed`);
        }
    }
    if (disagreements.length) lines.push('', `Disagreements (${disagreements.length}):`, ...disagreements.map(d => `  ${d}`));
    if (hiddenHoldout) lines.push('', `${hiddenHoldout} holdout disagreement(s) not listed`);
    return lines.join('\n');
}

export type LabelProvenance = Pick<Expected, 'by' | 'at' | 'source'>;

/**
 * A case from one label and the exported meeting it labels. A label marked low confidence is
 * `contested` (scored by nothing until someone settles it); any other is `adjudicated`, its
 * quote kept beside each value. null is a value: no session number printed, no format stated.
 */
export function caseFromLabel(label: MeetingRecordLabel, row: MeetingRecordExportRow, provenance: LabelProvenance): Case<MeetingRecordExportRow> {
    const key = `${row.cityId}__${row.meetingId}`;
    if (label.key !== key) throw new Error(`Label ${label.key} is not the label of ${key}`);
    const low = label.confidence === 'low';
    const id = `agenda.meetingRecord/${key}`;
    const expect: Record<string, Expected> = {};
    for (const field of MEETING_RECORD_FIELDS) {
        const quote = label.quotes?.[field];
        expect[field] = {
            value: label[field] ?? null,
            tier: low ? 'contested' : 'adjudicated',
            ...provenance,
            ...(low && { reason: 'the labeller marked the reading low confidence (see note)' }),
            ...(quote && { evidence: quote }),
        };
    }
    return {
        id,
        suite: 'agenda.meetingRecord',
        split: assignSplit(id),
        input: row,
        expect,
        cluster: `${row.cityId}/${row.administrativeBody?.name ?? 'council'}`,
        tags: [row.cityId, row.administrativeBody?.type ?? 'council', ...(label.multipleSittings ? ['multiple-sittings'] : []), ...(low ? ['low-confidence'] : [])],
        ...(label.note && { note: label.note }),
    };
}

/**
 * The meeting record (kind, urgency, session number, format) of one agenda, read by the
 * backfill's reader: `extractAgendaMeetings`, a Sonnet call on the first pages that reads
 * the meetings without the subjects (`read-meeting-records`).
 *
 * processAgenda reads the same record in its own extraction call (Opus, with the subjects,
 * `extractAgenda`), under the same `MEETING_RULES` but a different prompt and model, so
 * these scores say nothing about it. A variant could select that path with a param
 * (`params: { reader: 'processAgenda' }`) whose `run` calls `extractAgenda`; it needs a full
 * ProcessAgendaRequest (city, people, topic labels), which an export row does not carry.
 */
export const agendaMeetingRecord: Suite<MeetingRecordExportRow, MeetingRecordReading> = {
    id: 'agenda.meetingRecord',
    task: 'processAgenda',
    labels: ['agenda-meetings'],
    run: async c => {
        const { record, meetings, thisMeeting, warnings } = await readExportedMeeting(c.input);
        return { record, meetings, thisMeeting, warnings };
    },
    score: scoreMeetingRecord,
    detail: detailMeetingRecord,
    labelValue: (output, field) => (MEETING_RECORD_FIELDS as readonly string[]).includes(field) && output.record
        ? output.record[field as RecordField] ?? null
        : undefined,
    report: meetingRecordReport,
};
