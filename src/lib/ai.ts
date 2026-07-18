import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import path from 'path';
import { promises as fs } from 'fs';
import { observeGeneration, GenerationHandle } from './observability.js';
import { TaskCancelledError, abortableSleep, getTaskControl, throwIfCancelled } from './taskControl.js';

dotenv.config();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
export type UsageStats = {
    usage: Anthropic.Messages.Usage;
    resolvedModel?: string;
    batchMode?: boolean;
};
export type ResultWithUsage<T> = {
    result: T;
    maxTokens?: number;
    response?: Anthropic.Messages.Message;  // Full response for accessing citations, etc.
} & UsageStats;
export const NO_USAGE: Anthropic.Messages.Usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    cache_creation: null,
    server_tool_use: null,
    service_tier: null
};
export const NO_USAGE_STATS: UsageStats = { usage: NO_USAGE };
export const addUsage = (usage: Anthropic.Messages.Usage, otherUsage: Anthropic.Messages.Usage): Anthropic.Messages.Usage => ({
    input_tokens: usage.input_tokens + otherUsage.input_tokens,
    output_tokens: usage.output_tokens + otherUsage.output_tokens,
    cache_creation_input_tokens: (usage.cache_creation_input_tokens || 0) + (otherUsage.cache_creation_input_tokens || 0),
    cache_read_input_tokens: (usage.cache_read_input_tokens || 0) + (otherUsage.cache_read_input_tokens || 0),
    cache_creation: null,  // Don't aggregate cache_creation details
    server_tool_use: {
        web_search_requests: (usage.server_tool_use?.web_search_requests || 0) + (otherUsage.server_tool_use?.web_search_requests || 0),
    },
    service_tier: usage.service_tier || otherUsage.service_tier  // Take the first non-null tier
});

export function formatUsage(usage: Anthropic.Messages.Usage): string {
    const parts = [`${usage.input_tokens.toLocaleString()} in, ${usage.output_tokens.toLocaleString()} out`];
    if (usage.cache_creation_input_tokens) parts.push(`${usage.cache_creation_input_tokens.toLocaleString()} cache-write`);
    if (usage.cache_read_input_tokens) parts.push(`${usage.cache_read_input_tokens.toLocaleString()} cache-read`);
    return parts.join(', ');
}

export const HAIKU_MODEL = 'claude-haiku-4-5-20251001';


const logFilePath = path.join(process.env.LOG_DIR || process.cwd(), 'ai.log');
export async function logToFile(message: string, data?: any) {
    const timestamp = new Date().toISOString();
    let logEntry = `${timestamp} - ${message}`;
    if (data) {
        logEntry += `:\n${JSON.stringify(data, null, 2)}`;
    }
    logEntry += '\n---\n';
    try {
        await fs.appendFile(logFilePath, logEntry);
    } catch (err) {
        console.error('Failed to write to log file:', err);
    }
}

type AiChatOptions = {
    model?: string;
    documentBase64?: string;
    systemPrompt: string;
    userPrompt: string;
    // WARNING: trailing-assistant prefill returns 400 on Claude 4.6+ models
    // ("This model does not support assistant message prefill"). Only pass
    // this for older models (current callers use Haiku 4.5 / Sonnet 4.0).
    prefillSystemResponse?: string;
    // Partial output from a max_tokens-truncated response: sent back as a
    // non-final assistant turn followed by a user instruction to continue
    // (the prefill-based continuation is rejected by Claude 4.6+ models)
    continueFromPartial?: string;
    prependToResponse?: string;
    parseJson?: boolean;
    maxTokens?: number;
    tools?: Anthropic.Messages.Tool[];
    outputFormat?: Anthropic.Beta.Messages.MessageCreateParams['output_format'];
    cacheSystemPrompt?: boolean;  // Enable prompt caching for system prompt
    batchFirst?: boolean;  // Skip streaming, go directly to Batches API (300K output limit)
    label?: string;  // Observability: generation name shown in Langfuse (defaults to "aiChat")
}

export type TransientErrorKind = 'connection' | 'server' | false;

export function classifyTransientError(e: unknown): TransientErrorKind {
    if (e instanceof Anthropic.APIConnectionError) return 'connection';
    if (e instanceof Anthropic.InternalServerError) return 'server';
    // Streaming errors arrive as base APIError (no HTTP status), bypassing
    // the SDK's status-based class hierarchy. Check the inner error type.
    if (e instanceof Anthropic.APIError) {
        const inner = (e.error as any)?.error?.type;
        if (inner === 'overloaded_error' || inner === 'api_error') return 'server';
    }
    // Node's undici throws TypeError: terminated when the TCP connection drops
    // mid-stream. The SDK wraps it in AnthropicError. Retry is the correct
    // mitigation: https://github.com/anthropics/anthropic-sdk-typescript/issues/774#issuecomment-4329060307
    if (e instanceof Anthropic.AnthropicError) {
        const cause = (e as any).cause;
        if (cause instanceof TypeError && cause.message === 'terminated') return 'connection';
    }
    // Check the cause chain — errors wrapped by formatApiError or other layers
    // should still be classifiable by their original type.
    if (e instanceof Error && (e as any).cause) {
        return classifyTransientError((e as any).cause);
    }
    return false;
}

/**
 * Format an Anthropic SDK error into a plain Error with a human-readable message.
 *
 * The SDK's makeMessage() produces a JSON blob when the API response body has
 * no top-level .message (which is the case for most error responses — the
 * actual message lives at body.error.message). We extract the useful parts
 * and build a readable string that works well in alerts (Discord, etc.).
 */
export function formatApiError(e: unknown): Error {
    if (e instanceof Anthropic.APIError) {
        const inner = (e.error as any)?.error;
        const errorType = inner?.type ?? 'unknown';
        const errorMessage = inner?.message ?? 'no details';
        const parts = [
            e.status ? `${e.status}` : null,
            `${errorType}: ${errorMessage}`,
            e.requestID ? `(request: ${e.requestID})` : null,
        ].filter(Boolean);
        const wrapped = new Error(parts.join(' '));
        wrapped.cause = e;
        return wrapped;
    }
    if (e instanceof Error) return e;
    return new Error(String(e));
}

const MAX_TRANSIENT_RETRIES = 2;

const BACKOFF_BASE_MS: Record<Exclude<TransientErrorKind, false>, number> = {
    connection: 5_000,   // 5s, 10s — quick reconnect
    server:    30_000,   // 30s, 60s — give Anthropic time to recover
};

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let transientRetries = 0;
    while (true) {
        try {
            return await fn();
        } catch (e: any) {
            // Rate limit: wait for reset time
            if (e instanceof Anthropic.RateLimitError) {
                const resetHeader = e.headers?.get('anthropic-ratelimit-tokens-reset');
                if (resetHeader) {
                    const resetTime = new Date(resetHeader);
                    const now = new Date();
                    const sleepTime = resetTime.getTime() - now.getTime() + 1000;
                    console.log(`Rate limit hit, sleeping until ${resetTime.toISOString()} (${sleepTime}ms)`);
                    await abortableSleep(sleepTime, getTaskControl()?.cancel.signal);
                    throwIfCancelled();
                    continue;
                }
            }
            // Transient errors: retry with category-specific backoff
            const errorKind = classifyTransientError(e);
            if (errorKind && transientRetries < MAX_TRANSIENT_RETRIES) {
                transientRetries++;
                const backoffMs = transientRetries * BACKOFF_BASE_MS[errorKind];
                console.log(`Transient ${errorKind} error (attempt ${transientRetries}/${MAX_TRANSIENT_RETRIES}), retrying in ${backoffMs}ms...`);
                await abortableSleep(backoffMs, getTaskControl()?.cancel.signal);
                throwIfCancelled();
                continue;
            }
            throw e;
        }
    }
}

const BATCH_POLL_INTERVAL_MS = 60_000; // 60s between polls
const BATCH_CANCEL_POLL_INTERVAL_MS = 5_000; // faster polls while a cancel drains

/** Thrown when a batch request was cancelled for promotion; the caller re-issues via streaming. */
export class BatchPromotedError extends Error {
    constructor() {
        super('Batch request cancelled for promotion to streaming');
        this.name = 'BatchPromotedError';
    }
}

export async function executeBatch(
    requestParams: Anthropic.Messages.MessageCreateParamsNonStreaming,
    requestOptions: Anthropic.RequestOptions,
    client: Anthropic = anthropic,
): Promise<Anthropic.Messages.Message> {
    const control = getTaskControl();
    const cancelSignal = control?.cancel.signal;
    const promoteSignal = control?.promote.signal;
    const wakeSignal = cancelSignal && promoteSignal ? AbortSignal.any([cancelSignal, promoteSignal]) : undefined;

    const batch = await client.messages.batches.create({
        requests: [{
            custom_id: 'request-1',
            params: requestParams,
        }],
    }, requestOptions);

    console.log(`Batch created: ${batch.id}, polling for result...`);

    while (true) {
        await abortableSleep(BATCH_POLL_INTERVAL_MS, wakeSignal);

        if (cancelSignal?.aborted) {
            await cancelBatchQuietly(client, batch.id);
            throw new TaskCancelledError(`Batch ${batch.id} cancelled with its task`);
        }
        if (promoteSignal?.aborted) {
            return await resolvePromotedBatch(client, batch.id, cancelSignal);
        }

        const status = await client.messages.batches.retrieve(batch.id);
        const elapsed = Math.round((Date.now() - new Date(status.created_at).getTime()) / 1000);
        console.log(`Batch ${batch.id}: ${status.processing_status} (${elapsed}s elapsed, ${status.request_counts.processing} processing, ${status.request_counts.succeeded} succeeded)`);

        if (status.processing_status === 'ended') {
            const results = await client.messages.batches.results(batch.id);
            for await (const result of results) {
                if (result.custom_id === 'request-1') {
                    if (result.result.type === 'succeeded') {
                        return result.result.message;
                    }
                    if (result.result.type === 'errored') {
                        throw new Error(`Batch request errored: ${JSON.stringify(result.result.error)}`);
                    }
                    if (result.result.type === 'expired') {
                        throw new Error(`Batch request expired (exceeded Anthropic's 24h processing window)`);
                    }
                    throw new Error(`Batch request ${result.result.type}`);
                }
            }
            throw new Error('Batch completed but no result found for request-1');
        }
    }
}

async function cancelBatchQuietly(client: Anthropic, batchId: string): Promise<void> {
    try {
        await client.messages.batches.cancel(batchId);
    } catch (e) {
        console.warn(`Failed to cancel batch ${batchId}: ${e instanceof Error ? e.message : e}`);
    }
}

/**
 * Promotion: cancel the batch, wait for it to end, then resolve the race —
 * a request that finished before the cancel landed is already paid for
 * (batch rates), so use its result; otherwise tell the caller to re-issue
 * via streaming.
 */
async function resolvePromotedBatch(
    client: Anthropic,
    batchId: string,
    cancelSignal: AbortSignal | undefined,
): Promise<Anthropic.Messages.Message> {
    console.log(`Batch ${batchId}: promotion requested, cancelling batch...`);
    await cancelBatchQuietly(client, batchId);

    while (true) {
        const status = await client.messages.batches.retrieve(batchId);
        if (status.processing_status === 'ended') break;
        await abortableSleep(BATCH_CANCEL_POLL_INTERVAL_MS, cancelSignal);
        if (cancelSignal?.aborted) throw new TaskCancelledError(`Batch ${batchId} cancelled with its task`);
    }

    const results = await client.messages.batches.results(batchId);
    for await (const result of results) {
        if (result.custom_id === 'request-1' && result.result.type === 'succeeded') {
            console.log(`Batch ${batchId}: request completed before cancel landed — using the paid result`);
            return result.result.message;
        }
    }
    throw new BatchPromotedError();
}

/**
 * Cuts a max_tokens-truncated partial back to its last complete line, so the
 * continuation regenerates the cut line whole instead of resuming mid-word
 * (the seam of a mid-line stitch can drop characters). Returns the partial
 * unchanged when it has no usable line boundary (e.g. single-line JSON).
 */
export function cutToLineBoundary(partial: string): string {
    const lastNewline = partial.lastIndexOf('\n');
    return lastNewline > 0 ? partial.slice(0, lastNewline + 1) : partial;
}

/**
 * The user-turn instruction that continues a max_tokens-truncated response.
 * The full partial precedes it as an assistant turn; the tail is repeated here
 * to anchor the exact continuation point.
 */
export function continuationPrompt(partial: string): string {
    const tail = partial.slice(-200);
    return `Your previous response was cut off by the output token limit. It currently ends with:\n${tail}\n\nContinue EXACTLY from where it stopped: output only the remaining content, completing the line you were in the middle of if it was cut mid-line. Do not repeat anything already written, do not add any preamble or commentary, and do not restart any numbering or structure from the beginning.`;
}

export async function aiChat<T>({ model, systemPrompt, userPrompt, prefillSystemResponse, continueFromPartial, prependToResponse, documentBase64, parseJson = true, maxTokens: maxTokensParam, tools, outputFormat, cacheSystemPrompt = false, batchFirst = false, label }: AiChatOptions): Promise<ResultWithUsage<T>> {
    const maxTokens = maxTokensParam ?? 64000;
    let generation: GenerationHandle | undefined;
    try {
        console.log(`Sending message to claude${batchFirst ? ' (batch-first)' : ''}...`);
        const control = getTaskControl();
        throwIfCancelled();
        let messages: Anthropic.Messages.MessageParam[] = [];
        if (documentBase64) {
            messages.push({
                role: "user",
                content: [
                    {
                        type: "document",
                        source: {
                            type: "base64",
                            media_type: "application/pdf",
                            data: documentBase64
                        },
                    }
                ]
            });
        }
        messages.push({ "role": "user", "content": userPrompt });

        // Only use prefill if NOT using structured outputs (they're incompatible)
        if (prefillSystemResponse && !outputFormat) {
            messages.push({ "role": "assistant", "content": prefillSystemResponse });
        }

        // Continuation of a truncated response: the partial goes back as a
        // non-final assistant turn (mid-conversation assistant messages are
        // allowed on all models) with a user turn asking to resume from there.
        // NOTE: mutually exclusive with prefillSystemResponse — passing both
        // would emit two back-to-back assistant turns (the max_tokens recursion
        // folds any caller prefill into the partial instead)
        if (continueFromPartial && !outputFormat) {
            messages.push({ "role": "assistant", "content": continueFromPartial });
            messages.push({ "role": "user", "content": continuationPrompt(continueFromPartial) });
        }

        // Convert system prompt to array format with cache control if caching is enabled
        const systemPromptParam: string | Anthropic.Messages.TextBlockParam[] =
            cacheSystemPrompt
                ? [{
                    type: "text",
                    text: systemPrompt,
                    cache_control: { type: "ephemeral" }
                  }]
                : systemPrompt;

        const resolvedModel = model || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";
        const requestParams: Anthropic.Messages.MessageCreateParamsNonStreaming = {
            model: resolvedModel,
            max_tokens: maxTokens,
            system: systemPromptParam,
            messages,
            // Opus 4.7 rejects the temperature parameter; older models still accept it.
            ...(resolvedModel.startsWith("claude-opus-4-7") ? {} : { temperature: 0 }),
            ...(tools && { tools }),
            ...(outputFormat && {
                output_format: outputFormat
            })
        };

        generation = observeGeneration({
            name: label || 'aiChat',
            model: resolvedModel,
            input: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
                ...(prefillSystemResponse && !outputFormat ? [{ role: 'assistant', content: prefillSystemResponse }] : []),
            ],
            systemPrompt,
            metadata: { batchFirst, cacheSystemPrompt, maxTokens, hasTools: Boolean(tools), hasDocument: Boolean(documentBase64) },
        });

        // Prepare request options with beta headers if needed, plus cancel signal
        const requestOptions: Anthropic.RequestOptions = {
            ...(outputFormat ? { headers: { 'anthropic-beta': 'structured-outputs-2025-11-13' } } : {}),
            ...(control ? { signal: control.cancel.signal } : {}),
        };

        // Stream with retry, fall back to Batches API if all retries exhausted.
        // Streaming is fast (seconds) but fragile on long requests. The Batches API
        // is slower (minutes of queue time) but immune to connection drops.
        // batchFirst: skip streaming entirely, go direct to Batches API (300K output limit).
        // A promoted task (llmMode 'streaming') skips the Batch API for the rest of its run.
        const llmMode = control?.llmMode ?? 'batch';
        const useBatch = batchFirst && llmMode === 'batch';
        let response: Anthropic.Messages.Message;
        let usedBatch = useBatch;
        if (useBatch) {
            try {
                response = await executeBatch(requestParams, requestOptions);
            } catch (e) {
                if (e instanceof BatchPromotedError) {
                    console.log(`Batch promoted: re-issuing request via streaming...`);
                    response = await withRetry(async () => {
                        const stream = anthropic.messages.stream(requestParams, requestOptions);
                        return stream.finalMessage();
                    });
                    usedBatch = false;
                } else {
                    throw e;
                }
            }
        } else {
            try {
                response = await withRetry(async () => {
                    const stream = anthropic.messages.stream(requestParams, requestOptions);
                    return stream.finalMessage();
                });
            } catch (e) {
                // After promotion, the batch fallback would re-enter the queue the
                // operator just escaped (and the aborted promote signal would bounce
                // it straight back out) — so only fall back while in batch mode.
                if (classifyTransientError(e) && llmMode === 'batch') {
                    console.log(`Streaming failed after retries, falling back to batch mode...`);
                    response = await executeBatch(requestParams, requestOptions);
                    usedBatch = true;
                } else {
                    throw e;
                }
            }
        }

        console.log(`Claude stop_reason: ${response.stop_reason}, tokens: ${response.usage.output_tokens}/${maxTokens}`);

        // When using tools, response can have multiple content blocks
        // Extract all text blocks
        const textBlocks = response.content.filter(block => block.type === "text");

        if (textBlocks.length === 0) {
            throw new Error("Expected at least one text response from claude, got " + response.content.map(c => c.type).join(", "));
        }

        // For backward compatibility, if there's only one content block and it's not text, throw error
        if (!tools && response.content.length === 1 && response.content[0].type !== "text") {
            throw new Error("Expected text response from claude, got " + response.content[0].type);
        }

        // Concatenate all text blocks
        let responseText = textBlocks.map(block => block.text).join("");

        generation.end({
            output: responseText,
            usage: response.usage,
            metadata: { batchMode: usedBatch, stopReason: response.stop_reason },
        });

        if (response.stop_reason === "max_tokens") {
            // Structured outputs are incompatible with the prefill-based continuation
            // strategy — prefill is disabled when outputFormat is set. Throw so callers
            // (e.g. batch retry logic) can handle it by reducing the request size.
            if (outputFormat) {
                throw new Error(
                    `Structured-output response hit max_tokens (${maxTokens}). ` +
                    `The request likely needs fewer items to fit within the output limit.`
                );
            }

            console.log(`Claude stopped because it reached the max tokens of ${maxTokens}`);
            console.log(`Attempting to continue with a longer response...`);
            // Cut the partial back to the last complete line: the model can't
            // resume mid-word byte-exactly, so a mid-line seam can drop
            // characters ("για τονδήμο") — it regenerates the cut line whole
            // instead. Falls back to a byte-exact stitch for single-line output.
            const partialSoFar = cutToLineBoundary((continueFromPartial ?? prefillSystemResponse ?? '') + responseText);
            const response2 = await aiChat<T>({
                model,
                systemPrompt,
                documentBase64,
                userPrompt,
                continueFromPartial: partialSoFar,
                prependToResponse: partialSoFar,
                parseJson,
                maxTokens: maxTokensParam,
                tools,
                cacheSystemPrompt,  // Preserve caching on continuation
                label: label ? `${label}:continuation` : undefined
            });
            return {
                usage: addUsage(response.usage, response2.usage),
                result: response2.result,
                maxTokens,
                resolvedModel,
                batchMode: usedBatch
            }
        }

        let responseContent = responseText;
        if (prependToResponse) {
            responseContent = prependToResponse + responseContent;
        }

        let responseJson: T;
        if (parseJson) {
            try {
                responseJson = JSON.parse(responseContent) as T;
            } catch (e) {
                console.error(`Error parsing Claude response (length: ${responseContent.length} chars)`);
                console.error(`First 200 chars: ${responseContent.slice(0, 200)}`);
                console.error(`Last 200 chars: ${responseContent.slice(-200)}`);
                await logToFile(`JSON Parse Error - Full response (${responseContent.length} chars)`, {
                    error: e,
                    responseStart: responseContent.slice(0, 500),
                    responseEnd: responseContent.slice(-500),
                    stopReason: response.stop_reason,
                    outputTokens: response.usage.output_tokens
                });
                throw e;
            }
        } else {
            responseJson = responseContent as T;
        }

        return {
            usage: response.usage,
            result: responseJson,
            maxTokens,
            response: response,
            resolvedModel,
            batchMode: usedBatch
        };
    } catch (e) {
        generation?.error(e instanceof Error ? e.message : String(e));
        console.error(`Error in aiChat: ${e}`);
        // Log full error details for stream terminations to aid reproduction
        // (see https://github.com/anthropics/anthropic-sdk-typescript/issues/774)
        if (e instanceof Error && (e as any).cause) {
            const cause = (e as any).cause;
            console.error(`  cause: ${cause}`);
            if (cause instanceof Error && cause.cause) {
                console.error(`  cause.cause: ${cause.cause}`);
            }
        }
        await logToFile("Error in aiChat", {
            message: e instanceof Error ? e.message : String(e),
            name: e instanceof Error ? e.name : undefined,
            cause: e instanceof Error ? (e as any).cause : undefined,
            stack: e instanceof Error ? e.stack : undefined,
        });
        throw formatApiError(e);
    }
}

