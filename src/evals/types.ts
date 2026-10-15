import type { CallOverrides } from '../lib/llm/callPolicy.js';
import type { UsageLike } from '../lib/pricing.js';

/** Who stands behind an expected value. Only human-backed tiers decide a gate. */
export type Tier = 'adjudicated' | 'imported' | 'drafted' | 'contested';
export const HUMAN_TIERS: readonly Tier[] = ['adjudicated', 'imported'];
/** A person stands behind it, if only to say they can't tell: nothing regenerated may replace it. */
export const settledByPerson = (e: Pick<Expected, 'tier'>): boolean => e.tier !== 'drafted';

export type Expected = {
    value: unknown;
    tier: Tier;
    by: string;
    at: string;
    /** Where the value came from, e.g. "fixture:decision-reading-golden@v3", "review:rv-…", "signal:…". */
    source: string;
    /** For `imported`: the opencouncil signal it came from. */
    signal?: string;
    /** Required when a tier goes down. */
    reason?: string;
};

export type Split = 'dev' | 'holdout';

export type Case<I = unknown> = {
    /** "<suite>/<file stem>" */
    id: string;
    suite: string;
    split: Split;
    input: I;
    /** For multi-phase suites: the trace id of the recorded run used as the replay cassette. */
    replay?: string | null;
    expect: Record<string, Expected>;
    /** Unit for clustered statistics (body, meeting). */
    cluster: string;
    tags: string[];
    /** Failure modes this case is a gate case for. */
    guards?: string[];
    history?: Array<{ at: string; change: string; batch?: string; reason?: string }>;
};

/** One field's verdict for one output. `unscorable` = no usable label (contested, unlabelled). */
export type FieldOutcome = 'agree' | 'disagree' | 'missing' | 'unscorable';

export type CheckOutcome = 'pass' | 'fail' | 'unknown';

/** One (case, repeat) of a run. */
export type ResultRow = {
    caseId: string;
    rep: number;
    fields: Record<string, FieldOutcome>;
    /** Per field, a finer verdict than the outcome when the suite states one (summarize: identical|cosmetic|structural). */
    detail?: Record<string, string>;
    /** Failure-mode slug → result, for every mode of this suite with a code detector, whatever its status. */
    checks: Record<string, CheckOutcome>;
    usage: UsageLike;
    costUsd: number;
    latencyMs: number;
    servedModels: string[];
    /** `truncated` when max_tokens may have cut the output short: shown, but not averaged in as wrong. */
    status: 'ok' | 'truncated';
    traceId: string;
    output: unknown;
};

/** An attempt that produced nothing scorable; never scored as wrong. */
export type ErrorRow = { caseId: string; rep: number; errorClass: string; message: string; traceId?: string; costUsd: number };

export type Variant = {
    name: string;
    overrides: Record<string, CallOverrides>;
    /** Suite-specific parameters, e.g. a conventions file for extraction. */
    params?: Record<string, unknown>;
};

export type RunManifest = {
    runId: string;
    suite: string;
    variant: Variant;
    split: Split | 'all';
    reps: number;
    cases: number;
    /** caseSetSha of the cases used, so a comparison can tell the case sets apart and see expectations changed since. */
    caseSetSha: string;
    gitRef: string;
    gitDirty: boolean;
    startedAt: string;
    finishedAt?: string;
    spentUsd: number;
    /** Set when calls were served from recordings, with these label globs live (`onMiss: 'live'`: an unrecorded call went live). */
    replay?: { live: string[]; onMiss?: 'live' };
    status: 'running' | 'complete' | 'incomplete';
    incompleteReason?: string;
};
