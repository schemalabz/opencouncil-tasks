import { matchSubjects, toSubjectViews, type SubjectsResult } from '../../lib/runs/compare.js';
import type { SubjectVerdict, SubjectView } from '../../lib/runs/types.js';
import type { ArchivedRun } from '../../lib/telemetry/archiveSink.js';
import { assignSplit } from '../cases/caseStore.js';
import type { Case, Expected, FieldOutcome } from '../types.js';
import { discussedUtterances, speechTurns } from '../summarize/descriptionMetrics.js';
import type { CaseFromRunOptions, ComparedPart, PairwiseView, SourceTurn, Suite, SuiteRunContext } from './suite.js';

/**
 * A case of a subject suite (summarize, processAgenda) is a recorded run: `case.replay`
 * names it, and its archived input is the request. Until people adjudicate subjects, each
 * expected subject is that run's own output at tier `drafted`, so these suites measure
 * change against the recording, never correctness: `identical` and `cosmetic` count as
 * agreeing, `structural` does not.
 */
export type RecordedRunCaseInput = { meeting: string };

/** A recorded subject as a suite's run can produce it: a suite that runs part of the task expects that part only. */
type Project = (v: SubjectView) => SubjectView;
const WHOLE: Project = v => v;

type SubjectOutcome = { field: string; verdict: SubjectVerdict | 'missing'; changes: string[]; view?: SubjectView };

const FIELD = /^subject\[(.+)\]$/;

function subjectKey(v: SubjectView): string {
    const where = v.agendaItemIndex !== null ? `#${v.agendaItemIndex}` : v.nonAgendaReason ?? 'unplaced';
    return `${where} ${v.name}`;
}

/** subject[<agenda position> <name>] → that subject's view, one per subject of the run. */
export function expectedSubjects(views: SubjectView[]): Record<string, SubjectView> {
    const out: Record<string, SubjectView> = {};
    for (const v of views) {
        let field = `subject[${subjectKey(v)}]`;
        for (let n = 2; out[field]; n++) field = `subject[${subjectKey(v)} ~${n}]`;
        out[field] = v;
    }
    return out;
}

/**
 * Each expected subject paired with its counterpart in the output, by the `runs compare`
 * matching; `extra` holds the output's subjects that match none of them.
 */
function outcomesOf(output: SubjectsResult, c: Case<RecordedRunCaseInput>, expected: Project): { outcomes: SubjectOutcome[]; extra: SubjectView[] } {
    const baseline = Object.entries(c.expect).filter(([f]) => FIELD.test(f)).map(([field, e]) => ({ field, view: expected(e.value as SubjectView) }));
    const fieldOf = new Map(baseline.map(b => [b.view, b.field]));
    const { matched, fromOnly, toOnly } = matchSubjects(baseline.map(b => b.view), toSubjectViews(output));
    return {
        outcomes: [
            ...matched.map(m => ({ field: fieldOf.get(m.from)!, verdict: m.verdict, changes: m.changes, view: m.to })),
            ...fromOnly.map(f => ({ field: fieldOf.get(f)!, verdict: 'missing' as const, changes: [] })),
        ],
        extra: toOnly,
    };
}

export function subjectOutcomes(output: SubjectsResult, c: Case<RecordedRunCaseInput>, expected: Project = WHOLE): SubjectOutcome[] {
    return outcomesOf(output, c, expected).outcomes;
}

const OUTCOME: Record<SubjectOutcome['verdict'], FieldOutcome> = { identical: 'agree', cosmetic: 'agree', structural: 'disagree', missing: 'missing' };

/** `extra` expects no subject beyond the recorded ones, and is scored only on cases that carry it. */
export function scoreSubjects(output: SubjectsResult, c: Case<RecordedRunCaseInput>, expected: Project = WHOLE): Record<string, FieldOutcome> {
    const { outcomes, extra } = outcomesOf(output, c, expected);
    const out: Record<string, FieldOutcome> = Object.fromEntries(outcomes.map(o => [o.field, OUTCOME[o.verdict]]));
    if (c.expect.extra) out.extra = extra.length ? 'disagree' : 'agree';
    return out;
}

function detailSubjects(output: SubjectsResult, c: Case<RecordedRunCaseInput>, expected: Project): Record<string, string> {
    const { outcomes, extra } = outcomesOf(output, c, expected);
    const out: Record<string, string> = Object.fromEntries(outcomes.map(o => [o.field, o.changes.length ? `${o.verdict} (${o.changes.join(' ')})` : o.verdict]));
    if (c.expect.extra) out.extra = extra.length ? `extra (${extra.length}): ${extra.map(v => subjectKey(v).slice(0, 50)).join(' | ')}` : 'none';
    return out;
}

/** The run's meeting, or the one the caller names for a run recorded without one. */
export function recordedMeeting(recorded: ArchivedRun, opts?: CaseFromRunOptions): string {
    const meeting = opts?.meeting ?? recorded.run.meeting;
    if (!meeting || !/^[^/]+\/[^/]+$/.test(meeting)) throw new Error(`Run ${recorded.run.traceId} names no cityId/meetingId meeting (pass --meeting)`);
    return meeting;
}

/** Refuses a run a suite can't take expectations from: another task's, a failed one, or one without its request or result. */
export function assertRecordedResult(recorded: ArchivedRun, task: string): void {
    if (recorded.run.taskType !== task || !recorded.result) throw new Error(`Run ${recorded.run.traceId} is not a ${task} run with an archived result`);
    if (recorded.outcome.status !== 'success') throw new Error(`Run ${recorded.run.traceId} did not succeed (${recorded.outcome.status})`);
    if (!recorded.run.input) throw new Error(`Run ${recorded.run.traceId} has no archived request`);
}

/** The case every recorded-run suite builds: id from the meeting, cluster = city, the run as its cassette. */
export function recordedRunCase<I>(suite: string, recorded: ArchivedRun, meeting: string, input: I, expect: Record<string, Expected>): Case<I> {
    const id = `${suite}/${meeting.replace('/', '-')}`;
    return {
        id, suite, split: assignSplit(id), input, replay: recorded.run.traceId, expect,
        cluster: meeting.split('/')[0], tags: ['recorded-run', `env:${recorded.run.env}`],
    };
}

/** An expectation taken from a recorded run's own output: regression evidence only. */
export function drafted(value: unknown, recorded: ArchivedRun, now = new Date()): Expected {
    return { value, tier: 'drafted', by: 'recorded-run', at: now.toISOString().slice(0, 10), source: `run:${recorded.run.traceId}` };
}

export function recordedRequest(c: Case, recorded: ArchivedRun | null): unknown {
    if (!recorded?.run.input) throw new Error(`${c.id}: recorded run ${c.replay} has no archived request`);
    return recorded.run.input;
}

function caseFromRun(suite: string, task: string, expected: Project, recorded: ArchivedRun, opts?: CaseFromRunOptions): Case<RecordedRunCaseInput> {
    assertRecordedResult(recorded, task);
    const meeting = recordedMeeting(recorded, opts);
    const expect: Record<string, Expected> = {};
    for (const [field, view] of Object.entries(expectedSubjects(toSubjectViews(recorded.result as SubjectsResult)))) {
        expect[field] = drafted(expected(view), recorded);
    }
    expect.extra = drafted([], recorded);
    return recordedRunCase(suite, recorded, meeting, { meeting }, expect);
}

export type SlicePart = { title: string; text: string };

/** What a suite compares of a subject, as named parts: a reviewer sees the parts that differ side by side and the rest once. */
export type Slice = {
    parts(v: SubjectView): SlicePart[];
    sourceLabel?(v: SubjectView): string;
    /** What a reviewer reads beside the parts: the subject's speech (the default), or the recorded call alone when the parts were not written from the speech. */
    madeFrom?: 'speech' | 'call';
};

const asText = (parts: SlicePart[]) => parts.map(p => `${p.title}\n${p.text}`).join('\n\n');

/** The parts of two views lined up by title (a title that repeats, by its position among its namesakes). */
function alignParts(a: SlicePart[], b: SlicePart[]): { changed: ComparedPart[]; shared: SlicePart[] } {
    const keyed = (parts: SlicePart[]) => {
        const seen = new Map<string, number>();
        return parts.map(p => {
            const n = seen.get(p.title) ?? 0;
            seen.set(p.title, n + 1);
            return { key: `${p.title}#${n}`, ...p };
        });
    };
    const [ka, kb] = [keyed(a), keyed(b)];
    const inB = new Map(kb.map(p => [p.key, p.text]));
    const inA = new Set(ka.map(p => p.key));
    const changed: ComparedPart[] = [];
    const shared: SlicePart[] = [];
    for (const p of ka) {
        const other = inB.get(p.key);
        if (other === p.text) shared.push({ title: p.title, text: p.text });
        else changed.push({ title: p.title, a: p.text, b: other ?? '' });
    }
    for (const p of kb) if (!inA.has(p.key)) changed.push({ title: p.title, a: '', b: p.text });
    return { changed, shared };
}

type Tagged = Parameters<typeof discussedUtterances>[0];

/**
 * The speech either run tags to the subject, when the recorded request is a meeting's transcript.
 * Two runs of a change to the tagging differ in it, so a turn only one of them tags says which.
 */
function speechOf(a: SubjectsResult, b: SubjectsResult, ids: { a: string; b: string }, recorded?: ArchivedRun | null): SourceTurn[] | undefined {
    const request = recorded?.run.input as { transcript?: unknown } | undefined;
    if (!Array.isArray(request?.transcript) || !Array.isArray(a.utteranceDiscussionStatuses) || !Array.isArray(b.utteranceDiscussionStatuses)) return undefined;
    const [inA, inB] = [discussedUtterances(a as Tagged, ids.a), discussedUtterances(b as Tagged, ids.b)];
    const turns = speechTurns(request as Parameters<typeof speechTurns>[0], id => (inA.has(id) ? (inB.has(id) ? 'both' : 'a') : inB.has(id) ? 'b' : null));
    return turns.length ? turns.map(t => ({
        speaker: t.speaker, text: t.text,
        ...((t.party || t.role) && { detail: [t.party, t.role].filter(Boolean).join(' · ') }),
        ...(t.group !== 'both' && { only: t.group }),
    })) : undefined;
}

function pairwise(slice: Slice, expected: Project) {
    return (a: SubjectsResult, b: SubjectsResult, c: Case<RecordedRunCaseInput>, recorded?: ArchivedRun | null): PairwiseView[] => {
        const inB = new Map(subjectOutcomes(b, c, expected).map(o => [o.field, o.view]));
        const out: PairwiseView[] = [];
        for (const o of subjectOutcomes(a, c, expected)) {
            const vb = inB.get(o.field);
            if (!o.view || !vb) continue;
            const { changed, shared } = alignParts(slice.parts(o.view), slice.parts(vb));
            if (changed.length === 0) continue;
            const speech = slice.madeFrom === 'call' ? undefined : speechOf(a, b, { a: o.view.id, b: vb.id }, recorded);
            out.push({
                field: o.field, title: o.field.replace(FIELD, '$1'),
                a: asText(changed.map(p => ({ title: p.title, text: p.a }))), b: asText(changed.map(p => ({ title: p.title, text: p.b }))),
                parts: changed, shared,
                ...(speech && { speech }),
                ...(slice.sourceLabel && { sourceLabel: slice.sourceLabel(o.view) }),
            });
        }
        return out;
    };
}

const stripRefs = (text: string) => text.replace(/\[([^\]]*)\]\(REF:[A-Z]+:[^)]+\)/g, '$1');

export const CONTRIBUTIONS: Slice = {
    parts: v => v.contributions.map(c => ({ title: c.speakerName, text: stripRefs(c.text) })),
    // The label production gives the call; its prompt holds the subject's transcript.
    sourceLabel: v => `contributions:${v.name.slice(0, 40)}`,
};

export const CONTEXT: Slice = {
    parts: v => [
        { title: 'Context', text: v.context?.trim() || '(no context)' },
        ...(v.contextCitationUrls.length ? [{ title: 'Sources', text: v.contextCitationUrls.join('\n') }] : []),
    ],
    sourceLabel: v => `subject-context-search:${v.name.slice(0, 40)}`,
    // Written from a web search: the speech beside it would read as its source.
    madeFrom: 'call',
};

export const WHOLE_SUBJECT: Slice = {
    parts: v => [
        { title: 'Subject', text: `${v.name}${v.withdrawn ? ' (withdrawn)' : ''} · ${v.topic ?? 'no topic'}` },
        { title: 'Description', text: stripRefs(v.description) },
        ...CONTRIBUTIONS.parts(v).map(p => ({ title: `Contribution · ${p.title}`, text: p.text })),
        ...CONTEXT.parts(v),
    ],
};

export type SubjectSuiteSpec<O extends SubjectsResult> = {
    id: string;
    task: string;
    labels: string[];
    slice: Slice;
    /** Phase suites: the label globs live under replay. */
    replayLive?: string[];
    /**
     * For a suite whose run stops before the task does: a recorded subject as that run leaves it.
     * Cases keep it, and scoring applies it again, so a case made from a whole run still scores.
     */
    expected?: Project;
    run(c: Case<RecordedRunCaseInput>, ctx: SuiteRunContext): Promise<O>;
};

/** A suite scored subject by subject against a recorded run of a task that returns subjects. */
export function subjectSuite<O extends SubjectsResult>(spec: SubjectSuiteSpec<O>): Suite<RecordedRunCaseInput, O> {
    const expected = spec.expected ?? WHOLE;
    return {
        id: spec.id,
        task: spec.task,
        labels: spec.labels,
        ...(spec.replayLive && { replay: { live: spec.replayLive } }),
        request: recordedRequest,
        run: spec.run,
        score: (output, c) => scoreSubjects(output, c, expected),
        detail: (output, c) => detailSubjects(output, c, expected),
        caseFromRun: (recorded, opts) => caseFromRun(spec.id, spec.task, expected, recorded, opts),
        pairwiseItems: pairwise(spec.slice, expected),
    };
}
