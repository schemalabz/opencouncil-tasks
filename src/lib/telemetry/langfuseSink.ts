import { ROOT_CONTEXT, TraceFlags, trace, type Attributes, type Span, type SpanContext, type Tracer } from '@opentelemetry/api';
import { BasicTracerProvider, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { LangfuseClient } from '@langfuse/client';
import { LANGFUSE_SDK_VERSION, LANGFUSE_TRACER_NAME } from '@langfuse/core';
import {
    LangfuseOtelSpanAttributes as A,
    createObservationAttributes,
    createTraceAttributes,
    type LangfuseObservationAttributes,
    type LangfuseObservationType,
} from '@langfuse/tracing';
import { callCostUsd } from '../pricing.js';
import { requestEffort } from '../llm/cacheKey.js';
import type { CallRecord, CallRequest } from '../llm/callRecord.js';
import { newSpanId, type RunEnv, type RunInfo, type RunState } from './context.js';
import type { RunOutcome, TelemetrySink } from './sink.js';
import { registerSinkFactory } from './telemetry.js';

/**
 * Results above this size are replaced by a structural summary in the trace
 * output (Langfuse rejects oversized observations; Greek text inflates UTF-8 bytes).
 */
export const MAX_TRACE_OUTPUT_BYTES = 800_000;

/**
 * Generic input summary for the trace: scalar fields and array lengths only.
 * Full task inputs (transcripts, PDFs) are megabytes and add no value in Langfuse.
 */
export function summarizeTaskInput(input: unknown): Record<string, unknown> {
    if (input === null || typeof input !== 'object') return { value: input };
    const summary: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
        if (value === null || value === undefined) continue;
        if (typeof value === 'string') {
            summary[key] = value.length > 500 ? `${value.slice(0, 500)}… (${value.length} chars)` : value;
        } else if (typeof value === 'number' || typeof value === 'boolean') {
            summary[key] = value;
        } else if (Array.isArray(value)) {
            summary[`${key}Count`] = value.length;
        }
    }
    return summary;
}

export function isLangfuseConfigured(): boolean {
    return Boolean(process.env.LANGFUSE_SECRET_KEY && process.env.LANGFUSE_PUBLIC_KEY);
}

export function langfuseBaseUrl(): string {
    return process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_BASEURL || 'https://cloud.langfuse.com';
}

let client: LangfuseClient | null | undefined;

/** The Langfuse API client, for code that calls the API directly. Null when Langfuse is not configured. */
export function getLangfuseClient(): LangfuseClient | null {
    if (client === undefined) {
        client = isLangfuseConfigured()
            ? new LangfuseClient({ publicKey: process.env.LANGFUSE_PUBLIC_KEY, secretKey: process.env.LANGFUSE_SECRET_KEY, baseUrl: langfuseBaseUrl() })
            : null;
    }
    return client;
}

function traceAttributes(run: RunInfo, outcome: RunOutcome, resultSizeBytes: number | undefined): Attributes {
    const city = run.meeting?.split('/')[0];
    const tags = [
        `task:${run.taskType}`,
        `version:${run.taskVersion ?? 'unversioned'}`,
        ...(run.meeting ? [`meeting:${run.meeting}`, `city:${city}`] : []),
        // Distinct so cancellations are filterable and don't read as genuine failures.
        ...(outcome.status === 'success' ? [] : [`status:${outcome.status}`]),
        ...(run.eval ? ['env:eval', `eval-run:${run.eval.runId}`] : []),
    ];
    const metadata: Record<string, string | undefined> = {
        taskId: run.taskId,
        runId: run.eval?.runId,
        caseId: run.eval?.caseId,
        rep: run.eval ? String(run.eval.rep) : undefined,
        resultSizeBytes: resultSizeBytes === undefined ? undefined : String(resultSizeBytes),
    };
    const attrs: Attributes = { [A.TRACE_NAME]: run.taskType, [A.TRACE_TAGS]: tags };
    if (run.meeting) attrs[A.TRACE_SESSION_ID] = `${run.taskType}:${run.meeting}`;
    if (run.taskVersion !== null) attrs[A.VERSION] = String(run.taskVersion);
    for (const [key, value] of Object.entries(metadata)) {
        if (value !== undefined) attrs[`${A.TRACE_METADATA}.${key}`] = value;
    }
    return attrs;
}

function rootOutput(outcome: RunOutcome): { output: unknown; resultSizeBytes?: number } {
    if (outcome.status !== 'success') return { output: { error: outcome.error } };
    const resultSizeBytes = Buffer.byteLength(JSON.stringify(outcome.result) ?? '');
    const output = resultSizeBytes <= MAX_TRACE_OUTPUT_BYTES
        ? outcome.result
        : { resultTruncated: true, resultSizeBytes, resultSummary: summarizeTaskInput(outcome.result) };
    return { output, resultSizeBytes };
}

function num(value: unknown): number | undefined {
    return typeof value === 'number' ? value : undefined;
}

function usageDetails(usage: Record<string, unknown>): Record<string, number> {
    const serverTools = (usage.server_tool_use ?? {}) as Record<string, unknown>;
    const outputDetails = (usage.output_tokens_details ?? {}) as Record<string, unknown>;
    const details: Record<string, number | undefined> = {
        input: num(usage.input_tokens),
        output: num(usage.output_tokens),
        cache_read_input_tokens: num(usage.cache_read_input_tokens),
        cache_creation_input_tokens: num(usage.cache_creation_input_tokens),
        // Server-side tool use is billed per request; recorded so search-heavy
        // calls are visible even though Langfuse doesn't price this component.
        web_search_requests: num(serverTools.web_search_requests),
        web_fetch_requests: num(serverTools.web_fetch_requests),
        thinking_tokens: num(outputDetails.thinking_tokens),
    };
    return Object.fromEntries(Object.entries(details).filter(([key, v]) => v !== undefined && (v !== 0 || key === 'input' || key === 'output'))) as Record<string, number>;
}

function compactBlock(block: unknown): unknown {
    const b = block as { type?: string; source?: { type?: string; sha256?: string; media_type?: string; bytes?: number } };
    if (b?.type === 'document' && b.source?.type === 'blob') {
        const kind = b.source.media_type === 'application/pdf' ? 'pdf' : b.source.media_type;
        return `[${kind} ${b.source.sha256?.slice(0, 12)} ${b.source.bytes} bytes]`;
    }
    return block;
}

function generationInput(request: CallRequest, systemText: string | undefined): unknown {
    return {
        system: systemText ?? (request.system && { hash: request.system.hash }),
        messages: request.messages.map(m => ({
            role: m.role,
            content: Array.isArray(m.content) ? m.content.map(compactBlock) : m.content,
        })),
    };
}

function generationAttributes(call: CallRecord, systemText: string | undefined): LangfuseObservationAttributes {
    const { request, response } = call;
    const model = response?.servedModel ?? request.model;
    const modelParameters: Record<string, string | number> = { max_tokens: request.max_tokens };
    const effort = requestEffort(request);
    if (effort) modelParameters.effort = effort;
    if (typeof request.temperature === 'number') modelParameters.temperature = request.temperature;

    const usage = response?.usage;
    // A served recording cost nothing; its usage stays on the record as what the original call billed.
    const cost = response?.cacheHit ? 0 : usage && typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number'
        ? callCostUsd(call)
        : null;

    return {
        model,
        modelParameters,
        input: generationInput(request, systemText),
        output: response?.text,
        ...(usage && { usageDetails: usageDetails(usage) }),
        ...(cost !== null && { costDetails: { total: cost } }),
        metadata: {
            cacheKey: call.cacheKey,
            promptHash: request.system?.hash.slice(0, 12),
            stopReason: response?.stopReason,
            batchMode: response?.batchMode,
            promoted: response?.promoted,
            cacheHit: response?.cacheHit,
            replayed: response?.replayed,
        },
        ...(call.error && { level: 'ERROR' as const, statusMessage: call.error.message }),
    };
}

function emitRun(tracer: Tracer, state: RunState, outcome: RunOutcome, now: () => Date, systemTexts: Map<string, string>): void {
    const { run } = state;
    const { output, resultSizeBytes } = rootOutput(outcome);
    const shared = traceAttributes(run, outcome, resultSizeBytes);

    const start = (name: string, type: LangfuseObservationType, attrs: LangfuseObservationAttributes, startTime: string, parent: SpanContext): Span => {
        const span = tracer.startSpan(
            name,
            { startTime: new Date(startTime), attributes: { ...createObservationAttributes(type, attrs), ...shared } },
            trace.setSpanContext(ROOT_CONTEXT, parent),
        );
        // Set after start: the processor stamps its process-wide environment when a span starts.
        span.setAttribute(A.ENVIRONMENT, run.env);
        return span;
    };

    // A fabricated parent is how Langfuse documents forcing our own trace id: the
    // processor treats a span whose parent it never saw as the trace's root.
    const fakeParent: SpanContext = { traceId: run.traceId, spanId: newSpanId(), traceFlags: TraceFlags.SAMPLED };
    const input = summarizeTaskInput(run.input);
    const root = start(run.taskType, 'span', {
        input,
        output,
        ...(outcome.status === 'error' && { level: 'ERROR' as const, statusMessage: outcome.error }),
        ...(outcome.status === 'cancelled' && { level: 'WARNING' as const, statusMessage: outcome.error }),
    }, run.startedAt, fakeParent);
    // Langfuse no longer derives trace input/output from the root observation, and
    // the runs CLI reads the result from the trace output.
    root.setAttributes(createTraceAttributes({ input, output }));

    const phaseSpans = new Map<string, Span>();
    for (const phase of state.phases) {
        phaseSpans.set(phase.name, start(phase.name, 'span', {}, phase.startedAt, root.spanContext()));
    }
    for (const call of state.calls) {
        const parent = (call.phase && phaseSpans.get(call.phase)) || root;
        start(call.label ?? 'aiChat', 'generation', generationAttributes(call, call.request.system && systemTexts.get(call.request.system.hash)), call.startedAt, parent.spanContext())
            .end(new Date(call.finishedAt));
    }
    for (const phase of state.phases) {
        phaseSpans.get(phase.name)!.end(phase.endedAt ? new Date(phase.endedAt) : now());
    }
    root.end(new Date(outcome.endedAt));
}

/**
 * Emits each run to Langfuse once it has ended, as a back-dated trace whose id is
 * the run's own trace id (so other sinks can link to it). Uses a private tracer
 * provider: nothing registers globally, so it cannot collide with other OTel users.
 */
export function createLangfuseSink(deps: { processor?: SpanProcessor; now?: () => Date } = {}): TelemetrySink | null {
    let processor = deps.processor;
    if (!processor) {
        if (!isLangfuseConfigured()) return null;
        processor = new LangfuseSpanProcessor({
            publicKey: process.env.LANGFUSE_PUBLIC_KEY,
            secretKey: process.env.LANGFUSE_SECRET_KEY,
            baseUrl: langfuseBaseUrl(),
            environment: process.env.LANGFUSE_TRACING_ENVIRONMENT,
            // A run's spans are all created when it ends; 'immediate' exports each one in its own
            // request and the OTLP exporter drops everything past 30 in flight.
            exportMode: 'batched',
        });
    }
    const provider = new BasicTracerProvider({ spanProcessors: [processor] });
    const tracer = provider.getTracer(LANGFUSE_TRACER_NAME, LANGFUSE_SDK_VERSION);
    const now = deps.now ?? (() => new Date());
    const flushing = processor;
    // Call records carry only the system prompt's hash; its text arrives once, with the call's blobs.
    const systemTexts = new Map<string, Map<string, string>>();
    return {
        name: 'langfuse',
        onCall(run, call, extras) {
            const hash = call.request.system?.hash;
            const blob = hash && extras.blobs?.find(b => b.sha256 === hash);
            if (!run || !hash || !blob) return;
            const texts = systemTexts.get(run.traceId) ?? new Map<string, string>();
            texts.set(hash, blob.data.toString('utf8'));
            systemTexts.set(run.traceId, texts);
        },
        onRunEnd: (state, outcome) => {
            const texts = systemTexts.get(state.run.traceId) ?? new Map<string, string>();
            systemTexts.delete(state.run.traceId);
            emitRun(tracer, state, outcome, now, texts);
        },
        flush: () => flushing.forceFlush(),
    };
}

export type LangfuseScore = { traceId: string; name: string; value: number; comment?: string };

/**
 * Boolean scores on traces (check results). Scores are queued separately from
 * spans, so both flushes are needed or the last ones are dropped at exit.
 */
export async function langfuseScores(scores: LangfuseScore[], env: RunEnv): Promise<void> {
    const client = getLangfuseClient();
    if (!client || scores.length === 0) return;
    for (const s of scores) {
        client.score.create({ traceId: s.traceId, name: s.name, value: s.value, dataType: 'BOOLEAN', comment: s.comment, environment: env });
    }
    await client.flush();
    await client.flush();
}

registerSinkFactory('langfuse', () => createLangfuseSink());
