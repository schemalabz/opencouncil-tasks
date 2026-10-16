import { archiveKeys, type ArchiveStore } from '../../../lib/archive/store.js';
import { readArchivedRun, type ArchivedRun } from '../../../lib/telemetry/archiveSink.js';
import type { RunEnv } from '../../../lib/telemetry/context.js';
import type { CheckRecord } from '../../monitor/runChecks.js';
import { modeAppliesTo, modeSuites } from '../../registry/registry.js';
import type { FailureMode } from '../../registry/schema.js';
import { SUITES } from '../../suites/registry.js';
import { candidateId, type Candidate } from '../candidate.js';

const DAY_MS = 24 * 3600 * 1000;

export type MonitoringOptions = {
    env: RunEnv;
    sinceDays: number;
    /** The modes whose failures count; a record of any other mode is ignored. */
    modes: FailureMode[];
    suite?: string;
    now?: Date;
};

/** Every check record that fired, one candidate per (run, call, mode). */
export async function harvestMonitoring(store: ArchiveStore, opts: MonitoringOptions): Promise<Candidate[]> {
    const now = opts.now ?? new Date();
    const modes = new Map(opts.modes.map(m => [m.id, m]));
    const out = new Map<string, Candidate>();
    for (let daysAgo = 0; daysAgo <= opts.sinceDays; daysAgo++) {
        for await (const key of store.list(archiveKeys.checksDay(opts.env, new Date(now.getTime() - daysAgo * DAY_MS)))) {
            const body = await store.get(key);
            if (!body) continue;
            for (const line of body.toString('utf8').split('\n')) {
                if (!line.trim()) continue;
                const r = JSON.parse(line) as CheckRecord;
                const mode = modes.get(r.modeId);
                if (r.result !== 'fail' || !mode) continue;
                if (opts.suite && !modeAppliesTo(mode, opts.suite)) continue;
                const id = candidateId('monitoring', r.traceId, r.callId ?? '', r.slug);
                out.set(id, {
                    id,
                    // A record names no task, so a mode shared by several suites files under the one asked for, else its first.
                    suite: opts.suite ?? modeSuites(mode)[0],
                    source: 'monitoring',
                    signal: `check:${r.slug}`,
                    traceId: r.traceId,
                    ...(r.callId && { callId: r.callId }),
                    createdAt: now.toISOString(),
                    modeId: mode.id,
                    ...(r.label && { label: r.label }),
                    ...(r.evidence && { evidence: r.evidence }),
                    env: opts.env,
                });
            }
        }
    }
    const candidates = [...out.values()];
    await attachCases(store, candidates);
    return candidates;
}

/**
 * A fired call of a suite that can state a case for it becomes a proposed case, so
 * `eval review build label-confirm` can put the call's answers in front of a person.
 */
async function attachCases(store: ArchiveStore, candidates: Candidate[]): Promise<void> {
    const runs = new Map<string, Promise<ArchivedRun | null>>();
    for (const c of candidates) {
        const suite = SUITES[c.suite];
        if (!suite?.caseFromCall || !c.callId) continue;
        if (!runs.has(c.traceId)) runs.set(c.traceId, readArchivedRun(c.traceId, store).catch(() => null));
        const run = await runs.get(c.traceId)!;
        const call = run?.calls.find(k => k.callId === c.callId);
        const made = run && call ? suite.caseFromCall(call, run) : undefined;
        if (!made) continue;
        c.caseId = made.caseId;
        c.newCase = made.newCase;
        if (Object.keys(made.proposed).length) {
            c.proposed = made.proposed;
            c.fields = Object.keys(made.proposed);
        }
    }
}
