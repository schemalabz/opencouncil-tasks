import { randomUUID } from 'node:crypto';
import type { CallRecord, CallRequest } from '../llm/callRecord.js';
import { requestEffort } from '../llm/cacheKey.js';
import { callCostPartsUsd, totalUsd } from '../pricing.js';
import { getRunState, type RunInfo } from './context.js';
import type { TelemetrySink } from './sink.js';
import { registerSinkFactory } from './telemetry.js';

/** Posts one request body to a PostHog capture path; the sender owns host and auth. */
export type PosthogSend = (path: string, body: unknown) => Promise<void>;

export type PosthogEvent = { event: string; properties: Record<string, unknown>; timestamp?: string };

const DEFAULT_HOST = 'https://eu.i.posthog.com';
const DISTINCT_ID = 'opencouncil-tasks';
const BATCH_PATH = '/batch/';
// The AI path takes events up to 8 MiB untruncated, but rejects a whole request if any event lacks
// `$ai_model`, so only generations go there.
const AI_BATCH_PATH = '/i/v0/ai/batch/';
const AI_MAX_EVENT_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_EVENTS = 100;
const MAX_REQUEST_BYTES = 5 * 1024 * 1024;
const SEND_TIMEOUT_MS = 10_000;
const DROPPED = '[dropped: event exceeded the 8 MiB AI capture limit]';

function envSend(): PosthogSend | null {
    const token = process.env.POSTHOG_PROJECT_TOKEN;
    if (!token) return null;
    const host = (process.env.POSTHOG_HOST || DEFAULT_HOST).replace(/\/+$/, '');
    return async (path, body) => {
        const res = await fetch(`${host}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ api_key: token, ...(body as object) }),
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`PostHog ${path} answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    };
}

type WireEvent = PosthogEvent & { distinct_id: string; uuid: string };

const byteSize = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

function fitAiLimit(e: WireEvent): WireEvent {
    if (byteSize(e) <= AI_MAX_EVENT_BYTES) return e;
    return { ...e, properties: { ...e.properties, $ai_input: DROPPED, $ai_output_choices: [{ role: 'assistant', content: DROPPED }], $ai_content_dropped: true } };
}

function chunk(events: WireEvent[]): WireEvent[][] {
    const out: WireEvent[][] = [];
    let current: WireEvent[] = [];
    let bytes = 0;
    for (const e of events) {
        const size = byteSize(e);
        if (current.length && (current.length >= MAX_REQUEST_EVENTS || bytes + size > MAX_REQUEST_BYTES)) {
            out.push(current);
            current = [];
            bytes = 0;
        }
        current.push(e);
        bytes += size;
    }
    if (current.length) out.push(current);
    return out;
}

/**
 * Sends events to PostHog's capture API. Never throws: a failed request is logged and its events
 * dropped. A no-op without POSTHOG_PROJECT_TOKEN (unless a sender is passed).
 */
export async function posthogCapture(events: PosthogEvent[], send: PosthogSend | null = envSend()): Promise<void> {
    if (!send || !events.length) return;
    const wire: WireEvent[] = events.map(e => ({
        ...e, distinct_id: DISTINCT_ID, uuid: randomUUID(),
        properties: { ...e.properties, $process_person_profile: false },
    }));
    const isAi = (e: WireEvent) => e.event === '$ai_generation' && Boolean(e.properties.$ai_model);
    const routes: Array<[string, WireEvent[]]> = [
        [AI_BATCH_PATH, wire.filter(isAi).map(fitAiLimit)],
        [BATCH_PATH, wire.filter(e => !isAi(e))],
    ];
    for (const [path, routed] of routes) {
        for (const batch of chunk(routed)) {
            try {
                await send(path, { batch, sent_at: new Date().toISOString() });
            } catch (e) {
                console.error(`PostHog capture of ${batch.length} events to ${path} failed; dropping them:`, e);
            }
        }
    }
}

/** A score attached to a trace (or one of its nodes). The value is a string because PostHog hides a falsy one. */
export function aiMetricEvent(m: { traceId: string; name: string; value: number | string | boolean; parentId?: string }): PosthogEvent {
    return {
        event: '$ai_metric',
        properties: { $ai_trace_id: m.traceId, $ai_metric_name: m.name, $ai_metric_value: String(m.value), ...(m.parentId && { $ai_parent_id: m.parentId }) },
    };
}

/** Event properties PostHog insights filter and break down by. */
export const ENV_PROPERTY = 'deployment.environment.name';
export const CITY_PROPERTY = 'city';

/** The properties every event about a run carries. */
export function runProps(run: RunInfo | undefined): Record<string, unknown> {
    if (!run) return { 'service.name': DISTINCT_ID };
    return {
        'service.name': DISTINCT_ID,
        [ENV_PROPERTY]: run.env,
        task_type: run.taskType,
        task_version: run.taskVersion,
        task_id: run.taskId,
        ...(run.meeting && { meeting: run.meeting, [CITY_PROPERTY]: run.meeting.split('/')[0] }),
        ...(run.eval && { eval_run_id: run.eval.runId, eval_case_id: run.eval.caseId, eval_rep: run.eval.rep }),
    };
}

const seconds = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 1000;
const num = (v: unknown) => (typeof v === 'number' ? v : 0);

function renderContent(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return JSON.stringify(content);
    return content.map(block => {
        if (block?.type === 'text') return String(block.text);
        if (block?.type === 'document' && block.source?.type === 'blob') return `[pdf ${String(block.source.sha256).slice(0, 12)} ${block.source.bytes} bytes]`;
        return `[${block?.type ?? 'block'}]`;
    }).join('\n');
}

function aiInput(request: CallRequest): Array<{ role: string; content: string }> {
    return [
        ...(request.system ? [{ role: 'system', content: `[system ${request.system.hash.slice(0, 12)}]` }] : []),
        ...request.messages.map(m => ({ role: m.role, content: renderContent(m.content) })),
    ];
}

function generationEvent(run: RunInfo | undefined, call: CallRecord): PosthogEvent {
    const { request, response, error } = call;
    const traceId = run?.traceId ?? call.traceId ?? call.callId;
    const current = run && getRunState()?.phase;
    const parentId = current && current.name === call.phase ? current.id : traceId;
    const model = response?.servedModel ?? request.model;
    const usage = {
        input_tokens: num(response?.usage.input_tokens),
        output_tokens: num(response?.usage.output_tokens),
        cache_read_input_tokens: num(response?.usage.cache_read_input_tokens),
        cache_creation_input_tokens: num(response?.usage.cache_creation_input_tokens),
    };
    const cost = callCostPartsUsd(call);
    return {
        event: '$ai_generation',
        timestamp: call.finishedAt,
        properties: {
            ...runProps(run),
            $ai_trace_id: traceId,
            $ai_span_id: call.callId,
            $ai_generation_id: call.callId,
            $ai_parent_id: parentId,
            $ai_span_name: call.label,
            $ai_model: model,
            $ai_provider: 'anthropic',
            $ai_base_url: 'https://api.anthropic.com',
            $ai_max_tokens: request.max_tokens,
            $ai_input: aiInput(request),
            $ai_output_choices: [{ role: 'assistant', content: response?.text ?? '' }],
            $ai_latency: response ? response.latencyMs / 1000 : seconds(call.startedAt, call.finishedAt),
            $ai_is_error: Boolean(error),
            ...(error && { $ai_error: `${error.class}: ${error.message}` }),
            $ai_http_status: error ? 500 : 200,
            ...(response && {
                $ai_input_tokens: usage.input_tokens,
                $ai_output_tokens: usage.output_tokens,
                $ai_cache_read_input_tokens: usage.cache_read_input_tokens,
                $ai_cache_creation_input_tokens: usage.cache_creation_input_tokens,
                $ai_stop_reason: response.stopReason,
                $ai_cache_hit: Boolean(response.cacheHit),
                $ai_replayed: Boolean(response.replayed),
                batch_mode: response.batchMode,
            }),
            // Passthrough with an explicit total, so PostHog neither re-prices at non-batch rates nor
            // auto-fills a side that happens to be zero.
            ...(cost && {
                $ai_input_cost_usd: cost.input,
                $ai_output_cost_usd: cost.output,
                $ai_total_cost_usd: totalUsd(cost),
                $ai_cost_passthrough: true,
            }),
            effort: requestEffort(request),
            cache_key: call.cacheKey,
        },
    };
}

export function createPosthogSink(deps: { send?: PosthogSend } = {}): TelemetrySink | null {
    const send = deps.send ?? envSend();
    if (!send) return null;
    let queue: PosthogEvent[] = [];
    return {
        name: 'posthog',
        onCall(run, call) {
            queue.push(generationEvent(run, call));
        },
        onPhaseEnd(run, phase) {
            const endedAt = phase.endedAt ?? new Date().toISOString();
            queue.push({
                event: '$ai_span',
                timestamp: endedAt,
                properties: {
                    ...runProps(run),
                    $ai_trace_id: run.traceId,
                    $ai_span_id: phase.id,
                    $ai_parent_id: run.traceId,
                    $ai_span_name: phase.name,
                    $ai_latency: seconds(phase.startedAt, endedAt),
                },
            });
        },
        onRunEnd(state, outcome) {
            const { run } = state;
            queue.push({
                event: '$ai_trace',
                timestamp: outcome.endedAt,
                properties: {
                    ...runProps(run),
                    $ai_trace_id: run.traceId,
                    $ai_span_name: run.taskType,
                    $ai_latency: seconds(run.startedAt, outcome.endedAt),
                    $ai_is_error: outcome.status === 'error',
                    ...(outcome.error && { $ai_error: outcome.error }),
                    $ai_input_state: { meeting: run.meeting, task_id: run.taskId, phases: state.phases.map(p => p.name), calls: state.calls.length },
                    $ai_output_state: { status: outcome.status },
                },
            });
        },
        async flush() {
            const pending = queue;
            queue = [];
            await posthogCapture(pending, send);
        },
    };
}

registerSinkFactory('posthog', () => createPosthogSink());
