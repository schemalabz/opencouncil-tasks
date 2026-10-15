import dotenv from 'dotenv';
import { extractMeetingId } from '../utils.js';
import { envFromProcess } from './telemetry/context.js';
import { isLangfuseConfigured, langfuseBaseUrl } from './telemetry/langfuseSink.js';
import { activeSinks, runWithTelemetry, sinkWanted, withPhase } from './telemetry/telemetry.js';
import { configuredArchive } from './archive/store.js';
import './telemetry/sinks.js';

export { MAX_TRACE_OUTPUT_BYTES, getLangfuseClient, summarizeTaskInput } from './telemetry/langfuseSink.js';

dotenv.config();

export function isObservabilityEnabled(): boolean {
    return isLangfuseConfigured();
}

/** Log at server startup where LLM calls are recorded, and whether their responses are cached. */
export function logObservabilityStatus(): void {
    let archive: string;
    try {
        archive = configuredArchive()?.url ?? 'none';
    } catch (e) {
        archive = `unusable (${e instanceof Error ? e.message : e})`;
    }
    const sinks = activeSinks().map(s => s.name);
    console.log(`🔭 Telemetry sinks: ${sinks.join(', ') || 'none'}; archive: ${archive}`);
    if (sinks.includes('langfuse')) console.log(`🔭 Langfuse enabled (${langfuseBaseUrl()})`);
    else if (sinkWanted('langfuse')) console.log('🔭 Langfuse disabled (set LANGFUSE_SECRET_KEY/LANGFUSE_PUBLIC_KEY to enable)');
    if (archive === 'none') console.warn('🔭 ARCHIVE_URL is unset: LLM responses, decision readings included, are not cached, and no run is archived');
}

type TaskTraceOptions = {
    taskType: string;
    version?: number;
    input: unknown;
    callbackUrl: string;
    taskId: string;
};

/** Run a task as one telemetry run, so every sink sees it under a single trace id. */
export function runWithTaskTrace<R>(options: TaskTraceOptions, fn: () => Promise<R>): Promise<R> {
    const meeting = extractMeetingId(options.callbackUrl); // "cityId/meetingId" or "unknown"
    return runWithTelemetry({
        taskType: options.taskType,
        taskVersion: options.version ?? null,
        taskId: options.taskId,
        meeting: meeting !== 'unknown' ? meeting : undefined,
        env: envFromProcess(),
        input: options.input,
    }, fn);
}

/** Group a pipeline phase's calls, for per-phase duration/cost rollups. No-op outside a run. */
export function withPhaseSpan<T>(name: string, fn: () => Promise<T>): Promise<T> {
    return withPhase(name, fn);
}
