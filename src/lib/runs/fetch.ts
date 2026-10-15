import { createHash } from 'node:crypto';
import { openArchive, type ArchiveStore } from '../archive/store.js';
import { callsCostUsd } from '../pricing.js';
import { decodeRunFile, readArchivedRun, type ArchivedRun } from '../telemetry/archiveSink.js';
import { RUN_ENVS, type RunEnv } from '../telemetry/context.js';
import { SummarizeResult } from '../../types.js';
import { RunInfo, RunWithResult } from './types.js';

const DAY_MS = 24 * 3600 * 1000;

export function toRunInfo(archived: ArchivedRun): RunInfo {
    const { run, outcome, calls } = archived;
    const systemHashes = [...new Set(calls.map(c => c.request.system?.hash).filter((h): h is string => Boolean(h)))].sort();
    return {
        traceId: run.traceId,
        timestamp: run.startedAt,
        name: run.taskType,
        meeting: run.meeting ?? null,
        version: run.taskVersion === null ? null : String(run.taskVersion),
        env: run.env,
        promptsHash: systemHashes.length ? createHash('sha256').update(systemHashes.join('\n')).digest('hex').slice(0, 12) : null,
        isError: outcome.status === 'error',
        isCancelled: outcome.status === 'cancelled',
        totalCost: callsCostUsd(calls).usd,
        latencySeconds: (new Date(outcome.endedAt).getTime() - new Date(run.startedAt).getTime()) / 1000,
    };
}

export interface ListRunsFilters {
    task?: string;
    meeting?: string;
    /** Default 30. */
    sinceDays?: number;
    /** Default 30. */
    limit?: number;
    env?: RunEnv;
}

const dayPrefix = (date: Date): string =>
    `${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${String(date.getUTCDate()).padStart(2, '0')}/`;

/**
 * Archived runs newest first, one UTC day at a time (sorted within the day), so a
 * caller that stops early reads few run files. Shared by `runs list` and check backfills.
 */
export async function* iterateArchivedRuns(filters: Omit<ListRunsFilters, 'limit'>, store: ArchiveStore = openArchive()): AsyncGenerator<ArchivedRun> {
    const sinceDays = filters.sinceDays ?? 30;
    const envs = filters.env ? [filters.env] : RUN_ENVS;
    for (let daysAgo = 0; daysAgo <= sinceDays; daysAgo++) {
        const day = dayPrefix(new Date(Date.now() - daysAgo * DAY_MS));
        const keys: string[] = [];
        for (const env of envs) {
            for await (const key of store.list(`${env}/calls/${day}${filters.task ? `${filters.task}/` : ''}`)) {
                // Calls made outside any run are archived under the same tree but have no run line.
                if (key.split('/')[5] !== 'adhoc') keys.push(key);
            }
        }
        const dayRuns = await Promise.all(keys.map(async key => {
            const body = await store.get(key);
            return body ? decodeRunFile(body, key) : null;
        }));
        const matching = dayRuns
            .filter((r): r is ArchivedRun => r !== null && (!filters.meeting || r.run.meeting === filters.meeting))
            .sort((a, b) => b.run.startedAt.localeCompare(a.run.startedAt));
        for (const run of matching) yield run;
    }
}

/** Archived runs, newest first. */
export async function listRuns(filters: ListRunsFilters, store: ArchiveStore = openArchive()): Promise<RunInfo[]> {
    const limit = filters.limit ?? 30;
    const runs: RunInfo[] = [];
    for await (const archived of iterateArchivedRuns(filters, store)) {
        runs.push(toRunInfo(archived));
        if (runs.length >= limit) break;
    }
    return runs;
}

export async function requireArchivedRun(traceId: string, store: ArchiveStore): Promise<ArchivedRun> {
    const archived = await readArchivedRun(traceId, store);
    if (!archived) throw new Error(`Run ${traceId} not found in the archive (${store.url}).`);
    return archived;
}

/** A summarize run's metadata and result, for comparison. */
export async function fetchRun(traceId: string, store: ArchiveStore = openArchive()): Promise<RunWithResult> {
    const archived = await requireArchivedRun(traceId, store);
    const { outcome, result } = archived;
    if (outcome.status !== 'success') {
        throw new Error(`Run ${traceId} is a failed run: ${outcome.error ?? outcome.status}`);
    }
    if (!result || typeof result !== 'object') {
        throw new Error(`Run ${traceId} has no archived result (results over 20 MB are not archived).`);
    }
    if (!('subjects' in result)) {
        throw new Error(`Run ${traceId} is not a summarize result (task: ${archived.run.taskType}). Only summarize runs can be compared.`);
    }
    return { info: toRunInfo(archived), result: result as SummarizeResult };
}
