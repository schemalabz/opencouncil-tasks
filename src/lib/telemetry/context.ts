import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type { CallRecord } from '../llm/callRecord.js';

export const RUN_ENVS = ['production', 'staging', 'development', 'eval'] as const;
export type RunEnv = (typeof RUN_ENVS)[number];

export function isRunEnv(value: unknown): value is RunEnv {
    return (RUN_ENVS as readonly unknown[]).includes(value);
}

export function toRunEnv(value: string): RunEnv {
    if (!isRunEnv(value)) throw new Error(`Unknown run environment "${value}": expected one of ${RUN_ENVS.join(', ')}`);
    return value;
}

/** The environment this process's runs are filed under; anything but production or staging is development. */
export function envFromProcess(): RunEnv {
    const env = process.env.LANGFUSE_TRACING_ENVIRONMENT || process.env.NODE_ENV;
    return env === 'production' || env === 'staging' ? env : 'development';
}

export type RunInfo = {
    /** 32 lowercase hex chars, the same id in every sink. */
    traceId: string;
    taskType: string;
    taskVersion: number | null;
    taskId: string;
    /** "cityId/meetingId" when the run belongs to a meeting. */
    meeting?: string;
    env: RunEnv;
    input?: unknown;
    eval?: { runId: string; caseId: string; rep: number };
    startedAt: string;
};

export type PhaseInfo = { id: string; name: string; startedAt: string; endedAt?: string };

export type RunState = {
    run: RunInfo;
    phase?: PhaseInfo;
    phases: PhaseInfo[];
    calls: CallRecord[];
};

const storage = new AsyncLocalStorage<RunState>();

export function newTraceId(): string {
    return randomBytes(16).toString('hex');
}

export function newSpanId(): string {
    return randomBytes(8).toString('hex');
}

export function getRunState(): RunState | undefined {
    return storage.getStore();
}

export function runWithRunState<R>(state: RunState, fn: () => Promise<R>): Promise<R> {
    return storage.run(state, fn);
}
