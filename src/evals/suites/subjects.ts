import { matchSubjects, toSubjectViews, type SubjectsResult } from '../../lib/runs/compare.js';
import type { SubjectVerdict, SubjectView } from '../../lib/runs/types.js';
import type { ArchivedRun } from '../../lib/telemetry/archiveSink.js';
import { assignSplit } from '../cases/caseStore.js';
import type { Case, Expected, FieldOutcome } from '../types.js';
import type { CaseFromRunOptions, PairwiseView, Suite, SuiteRunContext } from './suite.js';

/**
 * A case of a subject suite (summarize, processAgenda) is a recorded run: `case.replay`
 * names it, and its archived input is the request. Until people adjudicate subjects, each
 * expected subject is that run's own output at tier `drafted`, so these suites measure
 * change against the recording, never correctness: `identical` and `cosmetic` count as
 * agreeing, `structural` does not.
 */
export type RecordedRunCaseInput = { meeting: string };

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
function outcomesOf(output: SubjectsResult, c: Case<RecordedRunCaseInput>): { outcomes: SubjectOutcome[]; extra: SubjectView[] } {
    const baseline = Object.entries(c.expect).filter(([f]) => FIELD.test(f)).map(([field, e]) => ({ field, view: e.value as SubjectView }));
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

export function subjectOutcomes(output: SubjectsResult, c: Case<RecordedRunCaseInput>): SubjectOutcome[] {
    return outcomesOf(output, c).outcomes;
}

const OUTCOME: Record<SubjectOutcome['verdict'], FieldOutcome> = { identical: 'agree', cosmetic: 'agree', structural: 'disagree', missing: 'missing' };

/** `extra` expects no subject beyond the recorded ones, and is scored only on cases that carry it. */
export function scoreSubjects(output: SubjectsResult, c: Case<RecordedRunCaseInput>): Record<string, FieldOutcome> {
    const { outcomes, extra } = outcomesOf(output, c);
    const out: Record<string, FieldOutcome> = Object.fromEntries(outcomes.map(o => [o.field, OUTCOME[o.verdict]]));
    if (c.expect.extra) out.extra = extra.length ? 'disagree' : 'agree';
    return out;
}

function detailSubjects(output: SubjectsResult, c: Case<RecordedRunCaseInput>): Record<string, string> {
    const { outcomes, extra } = outcomesOf(output, c);
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

function caseFromRun(suite: string, task: string, recorded: ArchivedRun, opts?: CaseFromRunOptions): Case<RecordedRunCaseInput> {
    assertRecordedResult(recorded, task);
    const meeting = recordedMeeting(recorded, opts);
    const expect: Record<string, Expected> = {};
    for (const [field, view] of Object.entries(expectedSubjects(toSubjectViews(recorded.result as SubjectsResult)))) {
        expect[field] = drafted(view, recorded);
    }
    expect.extra = drafted([], recorded);
    return recordedRunCase(suite, recorded, meeting, { meeting }, expect);
}

export type Slice = { text(v: SubjectView): string; sourceLabel?(v: SubjectView): string };

function pairwise(slice: Slice) {
    return (a: SubjectsResult, b: SubjectsResult, c: Case<RecordedRunCaseInput>): PairwiseView[] => {
        const inB = new Map(subjectOutcomes(b, c).map(o => [o.field, o.view]));
        const out: PairwiseView[] = [];
        for (const o of subjectOutcomes(a, c)) {
            const vb = inB.get(o.field);
            if (!o.view || !vb) continue;
            const [ta, tb] = [slice.text(o.view), slice.text(vb)];
            if (ta === tb) continue;
            out.push({ field: o.field, title: o.field.replace(FIELD, '$1'), a: ta, b: tb, ...(slice.sourceLabel && { sourceLabel: slice.sourceLabel(o.view) }) });
        }
        return out;
    };
}

const stripRefs = (text: string) => text.replace(/\[([^\]]*)\]\(REF:[A-Z]+:[^)]+\)/g, '$1');

export const CONTRIBUTIONS: Slice = {
    text: v => v.contributions.length ? v.contributions.map(c => `${c.speakerName}\n${stripRefs(c.text)}`).join('\n\n') : '(no contributions)',
    // The label production gives the call; its prompt holds the subject's transcript.
    sourceLabel: v => `contributions:${v.name.slice(0, 40)}`,
};

export const CONTEXT: Slice = {
    text: v => `${v.context?.trim() || '(no context)'}${v.contextCitationUrls.length ? `\n\nSources:\n${v.contextCitationUrls.join('\n')}` : ''}`,
    sourceLabel: v => `subject-context-search:${v.name.slice(0, 40)}`,
};

export const WHOLE_SUBJECT: Slice = {
    text: v => [`${v.name}${v.withdrawn ? ' (withdrawn)' : ''} · ${v.topic ?? 'no topic'}`, stripRefs(v.description), CONTRIBUTIONS.text(v), CONTEXT.text(v)].join('\n\n'),
};

export type SubjectSuiteSpec<O extends SubjectsResult> = {
    id: string;
    task: string;
    labels: string[];
    slice: Slice;
    /** Phase suites: the label globs live under replay. */
    replayLive?: string[];
    run(c: Case<RecordedRunCaseInput>, ctx: SuiteRunContext): Promise<O>;
};

/** A suite scored subject by subject against a recorded run of a task that returns subjects. */
export function subjectSuite<O extends SubjectsResult>(spec: SubjectSuiteSpec<O>): Suite<RecordedRunCaseInput, O> {
    return {
        id: spec.id,
        task: spec.task,
        labels: spec.labels,
        ...(spec.replayLive && { replay: { live: spec.replayLive } }),
        request: recordedRequest,
        run: spec.run,
        score: scoreSubjects,
        detail: detailSubjects,
        caseFromRun: (recorded, opts) => caseFromRun(spec.id, spec.task, recorded, opts),
        pairwiseItems: pairwise(spec.slice),
    };
}
