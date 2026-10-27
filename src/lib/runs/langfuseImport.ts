import type Anthropic from '@anthropic-ai/sdk';
import type { ArchiveStore } from '../archive/store.js';
import { archiveKeys } from '../archive/store.js';
import type { CallBlob, CallRecord } from '../llm/callRecord.js';
import { computeCacheKey, sanitizeParams } from '../llm/cacheKey.js';
import { getLangfuseClient } from '../observability.js';
import { toRunEnv, type PhaseInfo, type RunEnv, type RunState } from '../telemetry/context.js';
import type { RunOutcome } from '../telemetry/sink.js';
import { runFileWrites } from '../telemetry/archiveSink.js';

/** The fields of a Langfuse trace (GET /api/public/traces/{id}) the import reads. */
export type LangfuseTrace = {
    id: string;
    name?: string | null;
    timestamp: string;
    environment?: string | null;
    tags?: string[];
    input?: unknown;
    output?: unknown;
    latency?: number | null;
    observations: LangfuseObservation[];
};

type LangfuseObservation = {
    id: string;
    type: string;
    name?: string | null;
    parentObservationId?: string | null;
    isRootObservation?: boolean;
    startTime: string;
    endTime?: string | null;
    level?: string | null;
    statusMessage?: string | null;
    input?: unknown;
    output?: unknown;
    metadata?: Record<string, unknown> | null;
    model?: string | null;
    modelParameters?: Record<string, unknown> | null;
    latency?: number | null;
    usageDetails?: Record<string, number> | null;
};

const tagValue = (tags: string[] | undefined, key: string) => tags?.find(t => t.startsWith(`${key}:`))?.slice(key.length + 1);

/** Langfuse v4 traces have UUID ids; ours (and v5's) are the same 32 hex chars without dashes. */
export const archiveTraceId = (langfuseId: string) => langfuseId.replace(/-/g, '').toLowerCase();

function outputText(output: unknown): string {
    if (typeof output === 'string') return output;
    if (output && typeof output === 'object' && 'content' in output && typeof (output as { content: unknown }).content === 'string') return (output as { content: string }).content;
    return output === undefined || output === null ? '' : JSON.stringify(output);
}

type Message = { role: string; content: unknown };

/**
 * Older traces hold the input as one message list with the system prompt first; the
 * telemetry sink writes `{ system, messages }`, its system the text (or only a hash ref).
 */
function generationMessages(input: unknown): { system: string; messages: Message[] } {
    if (input && typeof input === 'object' && !Array.isArray(input) && Array.isArray((input as { messages?: unknown }).messages)) {
        const { system, messages } = input as { system?: unknown; messages: Message[] };
        return { system: typeof system === 'string' ? system : '', messages };
    }
    const all = Array.isArray(input) ? input as Message[] : [{ role: 'user', content: input ?? '' }];
    return {
        system: all.filter(m => m.role === 'system').map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n\n'),
        messages: all.filter(m => m.role !== 'system'),
    };
}

function callFromGeneration(o: LangfuseObservation, traceId: string, phases: Map<string, string>): { call: CallRecord; blobs: CallBlob[] } {
    const { system, messages } = generationMessages(o.input);
    const meta = o.metadata ?? {};
    // The telemetry sink writes modelParameters; traces from before it carry metadata.maxTokens.
    const maxTokens = [o.modelParameters?.max_tokens, meta.maxTokens].map(Number).find(n => Number.isInteger(n) && n > 0) ?? 0;
    const params = {
        model: o.model ?? 'unknown',
        max_tokens: maxTokens,
        ...(system && { system }),
        messages,
    } as Anthropic.Messages.MessageCreateParamsNonStreaming;
    const { request, blobs } = sanitizeParams(params);
    const text = outputText(o.output);
    const usage = o.usageDetails ?? {};
    const finishedAt = o.endTime ?? o.startTime;
    const failed = o.level === 'ERROR';
    return {
        blobs,
        call: {
            v: 1,
            callId: o.id,
            traceId,
            label: o.name ?? undefined,
            phase: o.parentObservationId ? phases.get(o.parentObservationId) : undefined,
            request,
            cacheKey: computeCacheKey(request),
            ...(failed
                ? { error: { class: 'ImportedError', message: o.statusMessage ?? 'error recorded in Langfuse' } }
                : {
                    response: {
                        servedModel: o.model ?? 'unknown',
                        stopReason: String(meta.stopReason ?? 'unknown'),
                        text,
                        content: [{ type: 'text', text }],
                        usage: {
                            input_tokens: usage.input ?? 0,
                            output_tokens: usage.output ?? 0,
                            ...(usage.cache_read_input_tokens !== undefined && { cache_read_input_tokens: usage.cache_read_input_tokens }),
                            ...(usage.cache_creation_input_tokens !== undefined && { cache_creation_input_tokens: usage.cache_creation_input_tokens }),
                            ...(usage.web_search_requests !== undefined && { server_tool_use: { web_search_requests: usage.web_search_requests } }),
                        },
                        latencyMs: Math.round((o.latency ?? 0) * 1000),
                        batchMode: meta.batchMode === true,
                    },
                }),
            startedAt: o.startTime,
            finishedAt,
            importedFrom: 'langfuse',
        },
    };
}

/**
 * A Langfuse trace as an archived run. Calls keep their verbatim prompts and outputs, so
 * call-scope checks and reading work; the request is rebuilt from what Langfuse kept, so its
 * cacheKey never matches a live call and replay never serves it. The task's result is kept
 * only when the trace holds it whole.
 */
export function runFromLangfuseTrace(trace: LangfuseTrace): { state: RunState; outcome: RunOutcome; blobs: CallBlob[] } {
    const traceId = archiveTraceId(trace.id);
    // The v2 observations API also returns the trace's root span, which is the run, not a phase.
    const spans = trace.observations
        .filter(o => o.type === 'SPAN' && !o.isRootObservation)
        .sort((a, b) => a.startTime.localeCompare(b.startTime));
    const phases: PhaseInfo[] = spans.map(o => ({ id: o.id, name: o.name ?? 'span', startedAt: o.startTime, ...(o.endTime && { endedAt: o.endTime }) }));
    const phaseNames = new Map(spans.map(o => [o.id, o.name ?? 'span']));
    const generations = trace.observations.filter(o => o.type === 'GENERATION').sort((a, b) => a.startTime.localeCompare(b.startTime));
    const converted = generations.map(o => callFromGeneration(o, traceId, phaseNames));
    const version = tagValue(trace.tags, 'version');
    const output = trace.output as { resultTruncated?: boolean; error?: unknown } | null | undefined;
    const endedAt = new Date(new Date(trace.timestamp).getTime() + (trace.latency ?? 0) * 1000).toISOString();
    return {
        state: {
            run: {
                traceId,
                taskType: trace.name ?? tagValue(trace.tags, 'task') ?? 'unknown',
                taskVersion: version ? Number(version) : null,
                taskId: `langfuse-${trace.id}`,
                meeting: tagValue(trace.tags, 'meeting'),
                env: toRunEnv(trace.environment ?? 'production'),
                input: trace.input,
                startedAt: trace.timestamp,
            },
            phases,
            calls: converted.map(c => c.call),
        },
        outcome: {
            status: output && typeof output === 'object' && output.error ? 'error' : 'success',
            ...(output && typeof output === 'object' && output.error ? { error: String(output.error) } : {}),
            ...(output && typeof output === 'object' && !output.resultTruncated && !output.error ? { result: output } : {}),
            endedAt,
        },
        blobs: converted.flatMap(c => c.blobs),
    };
}

const TRACE_DEADLINE_MS = 5 * 60_000;
const OBSERVATION_FIELDS = 'core,basic,time,io,metadata,model,usage';

// v2 returns input and output as raw strings. The input is a JSON message list; the output is
// kept verbatim, since a structured output's text must survive byte for byte.
function fromV2Observation(o: LangfuseObservation): LangfuseObservation {
    if (typeof o.input !== 'string') return o;
    try { return { ...o, input: JSON.parse(o.input) }; } catch { return o; }
}

function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} took over ${ms / 1000}s`)), ms); });
    return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

export type ImportOptions = { env: RunEnv; sinceDays: number; task?: string; limit?: number; concurrency?: number; onProgress?: (done: number, total: number) => void };
export type ImportSummary = { listed: number; imported: number; skipped: number; failed: number; calls: number };

/** Copies Langfuse traces into the archive, skipping runs it already holds. */
export async function importLangfuseRuns(store: ArchiveStore, opts: ImportOptions): Promise<ImportSummary> {
    const client = getLangfuseClient();
    if (!client) throw new Error('LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY are not set');
    const fromTimestamp = new Date(Date.now() - opts.sinceDays * 86_400_000).toISOString();
    // The traces endpoints allow about 15 requests a minute, so traces are listed with their
    // input and output (a few pages) and each trace's observations come from the v2
    // observations endpoint, which Langfuse points high-volume reads to.
    const traces: LangfuseTrace[] = [];
    for (let page = 1; ; page++) {
        const res = await client.api.trace.list({ page, limit: 100, environment: opts.env, fromTimestamp, fields: 'core,io,metrics', ...(opts.task && { name: opts.task }) });
        traces.push(...res.data.map(t => ({ ...(t as unknown as LangfuseTrace), observations: [] })));
        if (page >= res.meta.totalPages || (opts.limit && traces.length >= opts.limit)) break;
    }
    const wanted = opts.limit ? traces.slice(0, opts.limit) : traces;
    const summary: ImportSummary = { listed: wanted.length, imported: 0, skipped: 0, failed: 0, calls: 0 };
    let next = 0;
    const worker = async () => {
        while (next < wanted.length) {
            const listed = wanted[next++];
            const id = listed.id;
            try {
                if (await store.exists(archiveKeys.traceIndex(archiveTraceId(id)))) { summary.skipped++; continue; }
                // Without a deadline one stalled response holds a worker forever.
                const calls = await withDeadline((async () => {
                    const observations: LangfuseObservation[] = [];
                    for (let cursor: string | undefined; ;) {
                        const res = await client.api.observations.getMany(
                            { traceId: id, fields: OBSERVATION_FIELDS, limit: 100, ...(cursor && { cursor }) },
                            { timeoutInSeconds: 120, maxRetries: 3 },
                        );
                        observations.push(...res.data.map(o => fromV2Observation(o as unknown as LangfuseObservation)));
                        cursor = res.meta.cursor;
                        if (!cursor || res.data.length === 0) break;
                    }
                    const { state, outcome, blobs } = runFromLangfuseTrace({ ...listed, observations });
                    for (const blob of blobs) {
                        const key = archiveKeys.blob(blob.sha256);
                        if (!(await store.exists(key))) await store.put(key, blob.data, blob.mediaType);
                    }
                    // The index goes last, so an interrupted import retries the run rather than skipping it.
                    for (const w of await runFileWrites(state, outcome)) await store.put(w.key, w.body, w.contentType);
                    return state.calls.length;
                })(), TRACE_DEADLINE_MS, `trace ${id}`);
                summary.imported++;
                summary.calls += calls;
            } catch (e) {
                summary.failed++;
                console.error(`Langfuse trace ${id} not imported:`, e instanceof Error ? e.message : e);
            }
            opts.onProgress?.(summary.imported + summary.skipped + summary.failed, wanted.length);
        }
    };
    await Promise.all(Array.from({ length: opts.concurrency ?? 4 }, worker));
    return summary;
}
