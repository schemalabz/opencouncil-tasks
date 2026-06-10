import { getLangfuseClient } from '../observability.js';
import { SummarizeResult } from '../../types.js';
import { RunInfo, RunWithResult } from './types.js';

function tagValue(tags: string[], prefix: string): string | null {
    const tag = tags.find(t => t.startsWith(`${prefix}:`));
    return tag ? tag.slice(prefix.length + 1) : null;
}

function toRunInfo(trace: { id: string; timestamp: string | Date; name?: string | null; tags?: string[] | null; latency?: number | null; totalCost?: number | null }): RunInfo {
    const tags = trace.tags ?? [];
    return {
        traceId: trace.id,
        timestamp: typeof trace.timestamp === 'string' ? trace.timestamp : trace.timestamp.toISOString(),
        name: trace.name ?? 'unknown',
        meeting: tagValue(tags, 'meeting'),
        version: tagValue(tags, 'version'),
        env: tagValue(tags, 'env'),
        promptsHash: tagValue(tags, 'prompts'),
        isError: tags.includes('status:error'),
        totalCost: trace.totalCost ?? null,
        latencySeconds: trace.latency ?? null,
    };
}

function requireClient() {
    const client = getLangfuseClient();
    if (!client) {
        throw new Error('Langfuse is not configured. Set LANGFUSE_SECRET_KEY, LANGFUSE_PUBLIC_KEY (and optionally LANGFUSE_BASEURL) in .env.');
    }
    return client;
}

const FETCH_ATTEMPTS = 3;

/**
 * The Langfuse Cloud traces endpoint intermittently answers 422 "Request timed
 * out"; the SDK logs the error and resolves with the error body instead of
 * throwing. Validate the shape and retry with backoff.
 */
async function withFetchRetry<T>(fn: () => Promise<T>, isValid: (result: T) => boolean, what: string): Promise<T> {
    let last: T | undefined;
    for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
        last = await fn();
        if (isValid(last)) return last;
        if (attempt < FETCH_ATTEMPTS) {
            const backoffMs = attempt * 2000;
            console.log(`Langfuse ${what} returned an unexpected response, retrying in ${backoffMs / 1000}s (${attempt}/${FETCH_ATTEMPTS - 1})...`);
            await new Promise(resolve => setTimeout(resolve, backoffMs));
        }
    }
    throw new Error(`Langfuse ${what} failed after ${FETCH_ATTEMPTS} attempts: ${JSON.stringify(last).slice(0, 300)}`);
}

export interface ListRunsFilters {
    task?: string;
    meeting?: string;
    sinceDays?: number;
    limit?: number;
}

/** List traced runs, newest first, filtered via tags. */
export async function listRuns(filters: ListRunsFilters): Promise<RunInfo[]> {
    const client = requireClient();
    const tags: string[] = [];
    if (filters.task) tags.push(`task:${filters.task}`);
    if (filters.meeting) tags.push(`meeting:${filters.meeting}`);

    // The SDK comma-joins array query params, which the API rejects — so filter
    // server-side by the single most selective tag and apply the rest client-side.
    const serverTag = filters.meeting ? `meeting:${filters.meeting}`
        : filters.task ? `task:${filters.task}` : undefined;

    const response = await withFetchRetry(
        () => client.fetchTraces({
            ...(serverTag && { tags: [serverTag] }),  // single element — the SDK's comma-join is harmless here
            ...(filters.sinceDays && { fromTimestamp: new Date(Date.now() - filters.sinceDays * 24 * 3600 * 1000) }),
            limit: filters.limit ?? 30,
            orderBy: 'timestamp.desc',
        }),
        r => Array.isArray(r.data),
        'traces query',
    );

    return response.data
        .filter(trace => tags.every(tag => (trace.tags ?? []).includes(tag)))
        .map(toRunInfo);
}

/** Fetch a run's metadata and its result payload (the trace output). */
export async function fetchRun(traceId: string): Promise<RunWithResult> {
    const client = requireClient();
    const { data: trace } = await withFetchRetry(
        () => client.fetchTrace(traceId),
        r => Boolean(r.data && typeof r.data === 'object' && 'id' in r.data),
        `trace ${traceId} fetch`,
    );

    const output = trace.output as unknown;
    if (!output || typeof output !== 'object') {
        throw new Error(`Trace ${traceId} has no output — the run may have failed or predates result logging.`);
    }
    if ('error' in (output as Record<string, unknown>) && !('subjects' in (output as Record<string, unknown>))) {
        throw new Error(`Trace ${traceId} is a failed run: ${(output as { error: string }).error}`);
    }
    if ('resultTruncated' in (output as Record<string, unknown>)) {
        throw new Error(`Trace ${traceId}'s result was too large to store inline (${(output as { resultSizeBytes: number }).resultSizeBytes} bytes) and cannot be compared.`);
    }
    if (!('subjects' in (output as Record<string, unknown>))) {
        throw new Error(`Trace ${traceId} output is not a summarize result (task: ${trace.name}). Only summarize runs can be compared.`);
    }

    return { info: toRunInfo(trace), result: output as SummarizeResult };
}
