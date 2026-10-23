import { extractAgenda, foldAgendaTitle, processAgenda, type ExtractedSubject } from '../../tasks/processAgenda.js';
import type { ArchivedRun } from '../../lib/telemetry/archiveSink.js';
import type { AgendaMeetingRecord, ProcessAgendaRequest, ProcessAgendaResult, Subject, TaskWarning } from '../../types.js';
import { withCallbackUrl } from '../taskRunner.js';
import type { Case, Expected, FieldOutcome } from '../types.js';
import type { CaseFromRunOptions, Suite } from './suite.js';
import {
    assertRecordedResult, CONTEXT, drafted, recordedMeeting, recordedRequest, recordedRunCase, subjectSuite, type RecordedRunCaseInput,
} from './subjects.js';

/**
 * One agenda item as the extraction suite scores it. `kind` is where the item sits:
 * on the numbered agenda, or before or outside it (processAgenda only emits `agenda`
 * today; the field is there so a change that starts placing items elsewhere shows).
 */
export type AgendaItemView = {
    number: number | null;
    section: { index: number; title: string } | null;
    title: string | null;
    kind: 'agenda' | 'beforeAgenda' | 'outOfAgenda';
    name: string;
};

const SCORED: Array<{ name: string; same(a: AgendaItemView, b: AgendaItemView): boolean }> = [
    { name: 'title', same: (a, b) => a.title === b.title },
    { name: 'number', same: (a, b) => a.number === b.number },
    { name: 'section', same: (a, b) => a.section?.index === b.section?.index && a.section?.title === b.section?.title },
    { name: 'kind', same: (a, b) => a.kind === b.kind },
];

export function itemFromSubject(s: Subject): AgendaItemView {
    return {
        number: typeof s.agendaItemIndex === 'number' ? s.agendaItemIndex : null,
        section: s.agendaSection ?? null,
        title: s.agendaItemTitle ?? null,
        kind: s.agendaItemIndex === 'BEFORE_AGENDA' ? 'beforeAgenda' : s.agendaItemIndex === 'OUT_OF_AGENDA' ? 'outOfAgenda' : 'agenda',
        name: s.name,
    };
}

export function itemFromExtracted(s: ExtractedSubject): AgendaItemView {
    return {
        number: s.agendaItemIndex,
        section: s.agendaSectionIndex !== null && s.agendaSectionTitle !== null ? { index: s.agendaSectionIndex, title: s.agendaSectionTitle } : null,
        title: s.agendaItemTitle,
        kind: 'agenda',
        name: s.name,
    };
}

const position = (v: AgendaItemView) => v.kind !== 'agenda' ? v.kind : `${v.section ? `${v.section.index}.` : '#'}${v.number ?? '?'}`;

/** item[<position> <title>] → the item, one per item of the run; "extra" expects no item beyond them. */
export function expectedItems(items: AgendaItemView[]): Record<string, AgendaItemView> {
    const out: Record<string, AgendaItemView> = {};
    for (const v of items) {
        const key = `${position(v)} ${(v.title ?? v.name).slice(0, 60).trim()}`;
        let field = `item[${key}]`;
        for (let n = 2; out[field]; n++) field = `item[${key} ~${n}]`;
        out[field] = v;
    }
    return out;
}

type ItemOutcome = { field: string; verdict: 'identical' | 'changed' | 'missing'; changes: string[] };

const ITEM_FIELD = /^item\[/;

/**
 * Pairs each expected item with one output item: by (kind, section, number) first, in
 * order when a position repeats, then by folded title for items whose number moved.
 */
export function matchItems(expected: Array<{ field: string; view: AgendaItemView }>, output: AgendaItemView[]): { outcomes: ItemOutcome[]; extra: AgendaItemView[] } {
    const left = [...output];
    const take = (pred: (v: AgendaItemView) => boolean) => {
        const i = left.findIndex(pred);
        return i < 0 ? undefined : left.splice(i, 1)[0];
    };
    const pairs = new Map<string, AgendaItemView>();
    for (const e of expected) {
        const got = take(v => position(v) === position(e.view) && (e.view.number !== null || v.title === e.view.title));
        if (got) pairs.set(e.field, got);
    }
    for (const e of expected.filter(e => !pairs.has(e.field))) {
        const folded = foldAgendaTitle(e.view.title ?? e.view.name);
        const got = take(v => folded !== '' && foldAgendaTitle(v.title ?? v.name) === folded);
        if (got) pairs.set(e.field, got);
    }
    const outcomes = expected.map(({ field, view }): ItemOutcome => {
        const got = pairs.get(field);
        if (!got) return { field, verdict: 'missing', changes: [] };
        const changes = SCORED.filter(f => !f.same(view, got)).map(f => f.name);
        return { field, verdict: changes.length ? 'changed' : 'identical', changes };
    });
    return { outcomes, extra: left };
}

/** `meetingRecord` is carried for a suite that scores it; this one scores the items. */
export type AgendaExtractionOutput = { subjects: ExtractedSubject[]; warnings: TaskWarning[]; meetingRecord?: AgendaMeetingRecord | null };

function outcomesOf(output: AgendaExtractionOutput, c: Case<RecordedRunCaseInput>) {
    const expected = Object.entries(c.expect).filter(([f]) => ITEM_FIELD.test(f)).map(([field, e]) => ({ field, view: e.value as AgendaItemView }));
    return matchItems(expected, output.subjects.map(itemFromExtracted));
}

const OUTCOME: Record<ItemOutcome['verdict'], FieldOutcome> = { identical: 'agree', changed: 'disagree', missing: 'missing' };

export function scoreAgendaExtraction(output: AgendaExtractionOutput, c: Case<RecordedRunCaseInput>): Record<string, FieldOutcome> {
    const { outcomes, extra } = outcomesOf(output, c);
    const out: Record<string, FieldOutcome> = Object.fromEntries(outcomes.map(o => [o.field, OUTCOME[o.verdict]]));
    if (c.expect.extra) out.extra = extra.length ? 'disagree' : 'agree';
    return out;
}

function detailAgendaExtraction(output: AgendaExtractionOutput, c: Case<RecordedRunCaseInput>): Record<string, string> {
    const { outcomes, extra } = outcomesOf(output, c);
    const out: Record<string, string> = Object.fromEntries(outcomes.map(o => [o.field, o.changes.length ? `${o.verdict} (${o.changes.join(' ')})` : o.verdict]));
    if (c.expect.extra) out.extra = extra.length ? `extra (${extra.length}): ${extra.map(v => `${position(v)} ${(v.title ?? v.name).slice(0, 40)}`).join(' | ')}` : 'none';
    return out;
}

/** Expectations from a recorded processAgenda run: each agenda item it returned, at tier drafted. */
function agendaCaseFromRun(suite: string, recorded: ArchivedRun, opts?: CaseFromRunOptions): Case<RecordedRunCaseInput> {
    assertRecordedResult(recorded, 'processAgenda');
    const meeting = recordedMeeting(recorded, opts);
    const items = (recorded.result as ProcessAgendaResult).subjects.map(itemFromSubject);
    const expect: Record<string, Expected> = {};
    for (const [field, view] of Object.entries(expectedItems(items))) expect[field] = drafted(view, recorded);
    expect.extra = drafted([], recorded);
    return recordedRunCase(suite, recorded, meeting, { meeting }, expect);
}

/**
 * The extraction phase alone (document → agenda items), through production's own
 * `extractAgenda`: no enrichment runs, so nothing else is called. Scored item by
 * item against the recording (drafted: change, not correctness).
 */
export const agendaExtraction: Suite<RecordedRunCaseInput, AgendaExtractionOutput> = {
    id: 'agenda.extraction',
    task: 'processAgenda',
    labels: ['agenda-extraction*'],
    replay: { live: ['agenda-extraction*'] },
    request: recordedRequest,
    run: async (_c, ctx) => {
        const { extracted, warnings, meetingRecord } = await extractAgenda(ctx.request as ProcessAgendaRequest, () => {});
        return { subjects: extracted, warnings, meetingRecord };
    },
    score: scoreAgendaExtraction,
    detail: detailAgendaExtraction,
    caseFromRun: (recorded, opts) => agendaCaseFromRun('agenda.extraction', recorded, opts),
};

/** processAgenda's context search, scored and checked exactly as summarize.context (FM-0001/0002 list both suites). */
export const agendaContext = subjectSuite({
    id: 'agenda.context',
    task: 'processAgenda',
    labels: ['subject-context-search:*'],
    slice: CONTEXT,
    replayLive: ['subject-context-search:*'],
    run: async (c, ctx) => processAgenda(withCallbackUrl(ctx.request, c.input.meeting, `eval-${c.id}`) as ProcessAgendaRequest, () => {}),
});
