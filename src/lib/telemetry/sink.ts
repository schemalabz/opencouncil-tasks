import type { CallBlob, CallRecord } from '../llm/callRecord.js';
import type { PhaseInfo, RunInfo, RunState } from './context.js';

export type RunOutcome = {
    status: 'success' | 'error' | 'cancelled';
    result?: unknown;
    error?: string;
    endedAt: string;
};

/**
 * A destination for telemetry. Every hook is optional and may throw; the fan-out
 * isolates failures so one broken sink never affects a task or the other sinks.
 */
export interface TelemetrySink {
    readonly name: string;
    onRunStart?(run: RunInfo): void;
    onPhaseEnd?(run: RunInfo, phase: PhaseInfo): void;
    /** `run` is undefined for a call made outside any run (ad-hoc CLI use). */
    onCall?(run: RunInfo | undefined, call: CallRecord, extras: { blobs?: CallBlob[] }): void;
    onRunEnd?(state: RunState, outcome: RunOutcome): Promise<void> | void;
    flush?(): Promise<void>;
}
