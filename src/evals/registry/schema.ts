export type ModeStatus = 'candidate' | 'confirmed' | 'guarded' | 'regression' | 'retired';

export const MODE_STATUSES: readonly ModeStatus[] = ['candidate', 'confirmed', 'guarded', 'regression', 'retired'];
export const SEVERITIES = ['critical', 'major', 'degraded', 'minor'] as const;
export const IMPACTS = ['visible', 'silent'] as const;
export const SCOPES = ['call', 'task'] as const;
export const RELATION_TYPES = ['derived', 'merged', 'renamed', 'supersedes', 'similar'] as const;
export const DECISIONS = ['fix', 'evaluate', 'monitor', 'accept'] as const;

/** Check verdicts are `$ai_metric` events under this name; the PostHog insight over them carries it too. */
export const CHECK_METRIC_PREFIX = 'check:';
export const checkMetricName = (slug: string) => `${CHECK_METRIC_PREFIX}${slug}`;

export type CodeDetector = { kind: 'code'; module: string; export?: string };
export type JudgeDetector = {
    kind: 'judge';
    prompt: string;
    model: string;
    sample: number;
    calibration?: { tpr: number; tnr: number; n: number; at: string };
};

export type FailureMode = {
    /** FM-NNNN, never reused. */
    id: string;
    /** Stable snake_case name, used as the score and metric name everywhere. */
    slug: string;
    title: string;
    definition: string;
    boundary?: string;
    /** The suite(s) whose outputs it applies to; "*" for every suite. One detector serves every suite listed. */
    suite: string | string[];
    scope: (typeof SCOPES)[number];
    severity: (typeof SEVERITIES)[number];
    impact: (typeof IMPACTS)[number];
    status: ModeStatus;
    detector?: CodeDetector | JudgeDetector;
    issue?: string;
    related?: Array<{ type: (typeof RELATION_TYPES)[number]; id: string }>;
    decision?: (typeof DECISIONS)[number];
    /** Human-readable alert spec for the monitoring side. */
    alert?: string;
    /** Why a retired mode was retired, when it has no successor. */
    reason?: string;
    /** The YAML file it was loaded from (set by the loader). */
    file?: string;
};

export type DetectorCaseKind = 'must-fire' | 'must-not-fire' | 'known-miss' | 'known-false-alarm';

export const DETECTOR_CASE_KINDS: readonly DetectorCaseKind[] = ['must-fire', 'must-not-fire', 'known-miss', 'known-false-alarm'];

export type DetectorCase = {
    kind: DetectorCaseKind;
    note?: string;
    /** A minimal CallRecord-shaped object (call scope) or TaskOutput (task scope). */
    input: unknown;
    file?: string;
};

/** Statuses that require a working detector with positive and negative cases. */
export const GUARDED_STATUSES: readonly ModeStatus[] = ['guarded', 'regression'];
/** Checks run on production traffic only once a person has confirmed the mode. */
export const MONITORED_STATUSES: readonly ModeStatus[] = ['confirmed', 'guarded', 'regression'];
/** Statuses that require a tracking issue. */
export const ISSUE_STATUSES: readonly ModeStatus[] = ['confirmed', 'guarded', 'regression'];
