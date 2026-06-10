import { Langfuse, LangfuseTraceClient, LangfuseSpanClient, LangfuseGenerationClient } from 'langfuse';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import { extractMeetingId } from '../utils.js';

dotenv.config();

/**
 * Langfuse observability layer.
 *
 * Every helper here is a no-op when LANGFUSE_SECRET_KEY/LANGFUSE_PUBLIC_KEY are
 * not configured, so the task server runs identically with or without
 * observability enabled.
 *
 * Structure of a traced run:
 *   trace (one per task run, created by TaskManager)
 *   ├─ span "Phase 1: ..." (created by tasks via withPhaseSpan)
 *   │   └─ generation (created by aiChat via observeGeneration)
 *   └─ generation (aiChat calls outside any phase attach to the trace)
 *
 * Propagation uses AsyncLocalStorage so aiChat finds the active trace/span
 * without threading parameters through every call site.
 */

type TelemetryContext = {
    trace: LangfuseTraceClient;
    span?: LangfuseSpanClient;
    promptHashes: Set<string>;
};

const telemetryStorage = new AsyncLocalStorage<TelemetryContext>();

let client: Langfuse | null = null;
let initialized = false;

export function isObservabilityEnabled(): boolean {
    return Boolean(process.env.LANGFUSE_SECRET_KEY && process.env.LANGFUSE_PUBLIC_KEY);
}

function getClient(): Langfuse | null {
    if (!initialized) {
        initialized = true;
        if (isObservabilityEnabled()) {
            client = new Langfuse({
                secretKey: process.env.LANGFUSE_SECRET_KEY,
                publicKey: process.env.LANGFUSE_PUBLIC_KEY,
                baseUrl: process.env.LANGFUSE_BASEURL,
            });
            client.on('error', (error) => {
                console.error('Langfuse error:', error);
            });
        }
    }
    return client;
}

/** Log observability status at server startup. */
export function logObservabilityStatus(): void {
    if (isObservabilityEnabled()) {
        console.log(`🔭 Langfuse observability enabled (${process.env.LANGFUSE_BASEURL || 'https://cloud.langfuse.com'})`);
    } else {
        console.log('🔭 Langfuse observability disabled (set LANGFUSE_SECRET_KEY/LANGFUSE_PUBLIC_KEY to enable)');
    }
}

/** Short stable fingerprint of a prompt, for distinguishing runs with edited prompts. */
export function promptHash(prompt: string): string {
    return createHash('sha256').update(prompt).digest('hex').slice(0, 12);
}

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

type TaskTraceOptions = {
    taskType: string;
    version?: number;
    input: unknown;
    callbackUrl: string;
};

/**
 * Results above this size are replaced by a structural summary in the trace
 * output (Langfuse rejects events near 1MB; Greek text inflates UTF-8 bytes).
 */
const MAX_TRACE_OUTPUT_BYTES = 800_000;

/**
 * Run a task inside a Langfuse trace. Creates the trace, propagates it via
 * AsyncLocalStorage, records the result as trace output on success (with its
 * serialized size for diagnosability), and flushes before returning.
 *
 * When observability is disabled, runs the task directly.
 */
export async function runWithTaskTrace<R>(options: TaskTraceOptions, fn: () => Promise<R>): Promise<R> {
    const langfuse = getClient();
    if (!langfuse) return fn();

    const { taskType, version, input, callbackUrl } = options;
    const meeting = extractMeetingId(callbackUrl); // "cityId/meetingId" or "unknown"
    const hasMeeting = meeting !== 'unknown';
    const cityId = hasMeeting ? meeting.split('/')[0] : undefined;

    const tags = [
        `task:${taskType}`,
        `version:${version ?? 'unversioned'}`,
        `env:${process.env.NODE_ENV || 'development'}`,
        ...(hasMeeting ? [`meeting:${meeting}`, `city:${cityId}`] : []),
    ];

    const trace = langfuse.trace({
        name: taskType,
        sessionId: hasMeeting ? `${taskType}:${meeting}` : undefined,
        tags,
        input: summarizeTaskInput(input),
    });

    const context: TelemetryContext = { trace, promptHashes: new Set() };
    try {
        const result = await telemetryStorage.run(context, fn);
        const serializedSize = Buffer.byteLength(JSON.stringify(result) ?? '');
        // Oversized outputs (e.g. transcribe's full word-level transcript) would
        // exceed Langfuse's event limit and silently drop the completion update.
        // Store a structural summary instead so the run record always lands.
        const output = serializedSize <= MAX_TRACE_OUTPUT_BYTES
            ? result as object
            : { resultTruncated: true, resultSizeBytes: serializedSize, resultSummary: summarizeTaskInput(result) };
        trace.update({
            output,
            metadata: { resultSizeBytes: serializedSize },
            tags: [...tags, ...compositePromptTag(context.promptHashes)],
        });
        return result;
    } catch (error) {
        trace.update({
            output: { error: error instanceof Error ? error.message : String(error) },
            tags: [...tags, 'status:error', ...compositePromptTag(context.promptHashes)],
        });
        trace.event({ name: 'task-error', level: 'ERROR', statusMessage: error instanceof Error ? error.message : String(error) });
        throw error;
    } finally {
        await langfuse.flushAsync().catch((e) => console.error('Langfuse flush failed:', e));
    }
}

/** Composite fingerprint of all distinct system prompts used in the run. */
function compositePromptTag(hashes: Set<string>): string[] {
    if (hashes.size === 0) return [];
    const composite = createHash('sha256').update([...hashes].sort().join(',')).digest('hex').slice(0, 12);
    return [`prompts:${composite}`];
}

/**
 * Group the generations of a pipeline phase under a span, giving the Langfuse
 * trace view per-phase duration/cost rollups. No-op outside a traced run.
 */
export async function withPhaseSpan<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const context = telemetryStorage.getStore();
    if (!context) return fn();

    const span = context.trace.span({ name });
    try {
        return await telemetryStorage.run({ ...context, span }, fn);
    } finally {
        span.end();
    }
}

export type GenerationHandle = {
    end: (params: { output: unknown; usage: Anthropic.Messages.Usage; metadata?: Record<string, unknown> }) => void;
    error: (message: string) => void;
};

const NOOP_GENERATION: GenerationHandle = { end: () => { }, error: () => { } };

type ObserveGenerationOptions = {
    name: string;
    model: string;
    input: unknown;
    systemPrompt: string;
    metadata?: Record<string, unknown>;
};

/**
 * Open a generation under the active span (or trace). Records the system
 * prompt's hash both on the generation and in the run's composite fingerprint.
 * Returns a no-op handle outside a traced run.
 */
export function observeGeneration(options: ObserveGenerationOptions): GenerationHandle {
    const context = telemetryStorage.getStore();
    if (!context) return NOOP_GENERATION;

    const hash = promptHash(options.systemPrompt);
    context.promptHashes.add(hash);

    const parent = context.span ?? context.trace;
    const generation: LangfuseGenerationClient = parent.generation({
        name: options.name,
        model: options.model,
        input: options.input,
        metadata: { ...options.metadata, promptHash: hash },
    });

    let done = false;
    return {
        end: ({ output, usage, metadata }) => {
            if (done) return;
            done = true;
            generation.end({
                output,
                ...(metadata && { metadata }),
                usageDetails: {
                    input: usage.input_tokens,
                    output: usage.output_tokens,
                    ...(usage.cache_read_input_tokens ? { cache_read_input_tokens: usage.cache_read_input_tokens } : {}),
                    ...(usage.cache_creation_input_tokens ? { cache_creation_input_tokens: usage.cache_creation_input_tokens } : {}),
                    // Server-side tool use ($10/1k web searches) — recorded so search-heavy
                    // calls are visible even though Langfuse doesn't price this component.
                    ...(usage.server_tool_use?.web_search_requests ? { web_search_requests: usage.server_tool_use.web_search_requests } : {}),
                },
            });
        },
        error: (message) => {
            if (done) return;
            done = true;
            generation.end({ level: 'ERROR', statusMessage: message });
        },
    };
}
