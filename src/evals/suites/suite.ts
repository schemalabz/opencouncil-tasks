import type { CallRecord } from '../../lib/llm/callRecord.js';
import type { ArchivedRun } from '../../lib/telemetry/archiveSink.js';
import type { NewCase } from '../harvest/candidate.js';
import type { Case, FieldOutcome, ResultRow, Variant } from '../types.js';

export type SuiteRunContext = {
    variant: Variant;
    /** The case's recorded run (`case.replay`), when it has one. */
    recorded?: ArchivedRun | null;
    /** What the task is called with: `suite.request` when the suite defines it, else the case input. */
    request?: unknown;
};

export type CaseFromRunOptions = {
    /** "cityId/meetingId" for a run recorded without one (a CLI run of a task whose request names no meeting). */
    meeting?: string;
};

/** A proposed case built from one production call: what a label-confirm batch shows a person. */
export type CallCase = { caseId: string; newCase: NewCase; proposed: Record<string, unknown> };

/** One field of one case shown side by side for a pairwise review. */
export type PairwiseView = {
    field: string;
    title: string;
    a: string;
    b: string;
    /** Label of the recorded call whose prompt is the source a reviewer reads next to the item. */
    sourceLabel?: string;
};

/**
 * One evaluated decision point. `run` must call the task's production code;
 * `score` turns its output into one outcome per expected field.
 */
export interface Suite<I = unknown, O = unknown> {
    id: string;
    task: string;
    /** aiChat labels this suite exercises (for --live and for attaching failure modes). */
    labels: string[];
    /**
     * Phase suites: cases are recorded runs, replayed from their cassette with only these
     * label globs live unless the command line says otherwise. `onMiss: 'live'` lets a
     * replayed call with no recording yet go live and be recorded (the first run of a case
     * pays for it once); it applies only while the suite's own live set is used.
     */
    replay?: { live: string[]; onMiss?: 'live' };
    /** The task request for a case, recorded as the run's input (checks read it). Default: the case input. */
    request?(c: Case<I>, recorded: ArchivedRun | null): unknown;
    run(c: Case<I>, ctx: SuiteRunContext): Promise<O>;
    score(output: O, c: Case<I>): Record<string, FieldOutcome>;
    /** Per field, a finer verdict than `score`'s outcome, kept on the result row. */
    detail?(output: O, c: Case<I>): Record<string, string>;
    /**
     * The output's answer for a field in the shape the case stores it, for proposing it as
     * a label. Undefined when the output can't be stated that way: a proposal in the wrong
     * shape, once confirmed, would silently break `score`.
     */
    labelValue?(output: O, field: string): unknown;
    /**
     * The case one archived call of this suite's labels would make, with the call's answer as
     * proposed values (in `labelValue`'s shape). Undefined when the run does not say what the
     * call read.
     */
    caseFromCall?(call: CallRecord, recorded: ArchivedRun): CallCase | undefined;
    /** Fields whose value shape is a layout signal: a shape no case of the cluster has is novel (harvest --source novelty). */
    noveltyFields?: string[];
    /** A case from opencouncil's public meeting payload (`eval cases from-meeting`); `meeting` is cityId/meetingId. */
    caseFromMeeting?(meeting: string, payload: unknown): Case<I>;
    /** A case whose input and expectations come from a recorded run (`eval cases from-run`). */
    caseFromRun?(recorded: ArchivedRun, opts?: CaseFromRunOptions): Case<I>;
    /** The fields where two outputs for one case differ, as a reviewer reads them (pairwise batches). */
    pairwiseItems?(a: O, b: O, c: Case<I>): PairwiseView[];
    /** A suite's own summary of one run, beyond per-field accuracy (`eval report`). */
    report?(rows: ResultRow[], cases: Case<I>[]): string;
}
