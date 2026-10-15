import { archiveKeys, configuredArchive, type ArchiveStore } from '../../lib/archive/store.js';
import { spoolWrite } from '../../lib/archive/spool.js';
import { onRunEnd, sinkWanted } from '../../lib/telemetry/telemetry.js';
import { aiMetricEvent, posthogCapture, runProps } from '../../lib/telemetry/posthogSink.js';
import { langfuseScores } from '../../lib/telemetry/langfuseSink.js';
import { monitoredModes } from '../registry/registry.js';
import { checkMetricName, type FailureMode } from '../registry/schema.js';
import { runChecksOnRun, verdictBySlug, type CheckableRun, type CheckRecord } from './runChecks.js';

const pending = new Set<Promise<void>>();

/** `archive` is null when check results should reach only the platforms. */
export async function recordChecks(target: CheckableRun, records: CheckRecord[], archive: ArchiveStore | null): Promise<void> {
    if (records.length === 0) return;
    if (archive) {
        const body = Buffer.from(records.map(r => JSON.stringify(r)).join('\n') + '\n');
        const key = archiveKeys.checks(target.run.env, new Date(target.run.startedAt), target.run.traceId);
        await archive.put(key, body, 'application/x-ndjson').catch(() => spoolWrite(key, body, 'application/x-ndjson'));
    }

    if (sinkWanted('posthog')) await posthogCapture(records.filter(r => r.result !== 'unknown').map(r => {
        const e = aiMetricEvent({ traceId: r.traceId, name: checkMetricName(r.slug), value: r.result === 'fail' ? 1 : 0, parentId: r.callId });
        return { ...e, properties: { ...e.properties, ...runProps(target.run), check_mode: r.modeId, check_scope: r.scope }, timestamp: r.at };
    }));
    if (sinkWanted('langfuse')) await langfuseScores(Object.entries(verdictBySlug(records)).filter(([, v]) => v !== 'unknown').map(([slug, v]) => ({
        traceId: target.run.traceId, name: slug, value: v === 'fail' ? 1 : 0,
        comment: records.find(r => r.slug === slug && r.result === v)?.evidence,
    })), target.run.env);
}

/**
 * Resolved once: a malformed ARCHIVE_URL resolved per run would throw before the platform
 * emits, losing every run's verdicts instead of only their archive copy. Never the
 * local-disk fallback: a server would fill its own disk.
 */
function monitoringArchive(): ArchiveStore | null {
    if (!sinkWanted('archive')) return null;
    try {
        return configuredArchive();
    } catch (e) {
        console.warn('Post-task checks: not archiving check results:', e instanceof Error ? e.message : e);
        return null;
    }
}

/**
 * Runs the confirmed failure modes' checks after every successful task run, off the
 * task's path: the callback never waits for them and their failures are only logged.
 * Eval runs score their own checks in the runner.
 */
export function startMonitoring(opts: { modes?: FailureMode[] } = {}): () => void {
    let modes: FailureMode[];
    try {
        modes = opts.modes ?? monitoredModes();
    } catch (e) {
        // A broken registry file must not take the server down at boot: monitoring is optional.
        console.error('Post-task checks disabled: the failure-mode registry did not load:', e instanceof Error ? e.message : e);
        return () => {};
    }
    // Silence here would look the same as every check passing.
    if (modes.length) console.log(`Post-task checks: ${modes.length} monitored failure modes`);
    else console.warn('Post-task checks: no monitored failure modes found (is evals/failure-modes in this build?)');
    const archive = monitoringArchive();
    return onRunEnd((state, outcome) => {
        if (outcome.status !== 'success' || state.run.env === 'eval') return;
        const job = (async () => {
            try {
                const target = { run: state.run, calls: state.calls, result: outcome.result };
                await recordChecks(target, await runChecksOnRun(target, modes), archive);
            } catch (e) {
                console.error('Post-task checks failed:', e instanceof Error ? e.message : e);
            }
        })();
        pending.add(job);
        job.finally(() => pending.delete(job));
    });
}

/** For short-lived processes (the CLI): wait for checks still running. */
export async function settleMonitoring(): Promise<void> {
    while (pending.size) await Promise.allSettled([...pending]);
}
