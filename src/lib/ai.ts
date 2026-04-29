import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import path from 'path';
import { promises as fs } from 'fs';

dotenv.config();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
export type ResultWithUsage<T> = {
    result: T;
    usage: Anthropic.Messages.Usage;
    maxTokens?: number;
    response?: Anthropic.Messages.Message;  // Full response for accessing citations, etc.
};
export const NO_USAGE: Anthropic.Messages.Usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    cache_creation: null,
    server_tool_use: null,
    service_tier: null
};
export const addUsage = (usage: Anthropic.Messages.Usage, otherUsage: Anthropic.Messages.Usage): Anthropic.Messages.Usage => ({
    input_tokens: usage.input_tokens + otherUsage.input_tokens,
    output_tokens: usage.output_tokens + otherUsage.output_tokens,
    cache_creation_input_tokens: (usage.cache_creation_input_tokens || 0) + (otherUsage.cache_creation_input_tokens || 0),
    cache_read_input_tokens: (usage.cache_read_input_tokens || 0) + (otherUsage.cache_read_input_tokens || 0),
    cache_creation: null,  // Don't aggregate cache_creation details
    server_tool_use: null, // Don't aggregate server_tool_use details
    service_tier: usage.service_tier || otherUsage.service_tier  // Take the first non-null tier
});

export function formatUsage(usage: Anthropic.Messages.Usage): string {
    const parts = [`${usage.input_tokens.toLocaleString()} in, ${usage.output_tokens.toLocaleString()} out`];
    if (usage.cache_creation_input_tokens) parts.push(`${usage.cache_creation_input_tokens.toLocaleString()} cache-write`);
    if (usage.cache_read_input_tokens) parts.push(`${usage.cache_read_input_tokens.toLocaleString()} cache-read`);
    return parts.join(', ');
}

export const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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
    prefillSystemResponse?: string;
    prependToResponse?: string;
    parseJson?: boolean;
    maxTokens?: number;
    tools?: Anthropic.Messages.Tool[];
    outputFormat?: Anthropic.Beta.Messages.MessageCreateParams['output_format'];
    cacheSystemPrompt?: boolean;  // Enable prompt caching for system prompt
    batchFirst?: boolean;  // Skip streaming, go directly to Batches API (300K output limit)
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
                    await sleep(sleepTime);
                    continue;
                }
            }
            // Transient errors: retry with category-specific backoff
            const errorKind = classifyTransientError(e);
            if (errorKind && transientRetries < MAX_TRANSIENT_RETRIES) {
                transientRetries++;
                const backoffMs = transientRetries * BACKOFF_BASE_MS[errorKind];
                console.log(`Transient ${errorKind} error (attempt ${transientRetries}/${MAX_TRANSIENT_RETRIES}), retrying in ${backoffMs}ms...`);
                await sleep(backoffMs);
                continue;
            }
            throw e;
        }
    }
}

const BATCH_POLL_INTERVAL_MS = 60_000; // 60s between polls

async function executeBatch(requestParams: Anthropic.Messages.MessageCreateParamsNonStreaming, requestOptions: Anthropic.RequestOptions): Promise<Anthropic.Messages.Message> {
    const batch = await anthropic.messages.batches.create({
        requests: [{
            custom_id: 'request-1',
            params: requestParams,
        }],
    }, requestOptions);

    console.log(`Batch created: ${batch.id}, polling for result...`);

    while (true) {
        await sleep(BATCH_POLL_INTERVAL_MS);

        const status = await anthropic.messages.batches.retrieve(batch.id);
        const elapsed = Math.round((Date.now() - new Date(status.created_at).getTime()) / 1000);
        console.log(`Batch ${batch.id}: ${status.processing_status} (${elapsed}s elapsed, ${status.request_counts.processing} processing, ${status.request_counts.succeeded} succeeded)`);

        if (status.processing_status === 'ended') {
            const results = await anthropic.messages.batches.results(batch.id);
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

export async function aiChat<T>({ model, systemPrompt, userPrompt, prefillSystemResponse, prependToResponse, documentBase64, parseJson = true, maxTokens: maxTokensParam, tools, outputFormat, cacheSystemPrompt = false, batchFirst = false }: AiChatOptions): Promise<ResultWithUsage<T>> {
    const maxTokens = maxTokensParam ?? 64000;
    try {
        console.log(`Sending message to claude${batchFirst ? ' (batch-first)' : ''}...`);
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

        // Convert system prompt to array format with cache control if caching is enabled
        const systemPromptParam: string | Anthropic.Messages.TextBlockParam[] =
            cacheSystemPrompt
                ? [{
                    type: "text",
                    text: systemPrompt,
                    cache_control: { type: "ephemeral" }
                  }]
                : systemPrompt;

        const requestParams: Anthropic.Messages.MessageCreateParamsNonStreaming = {
            model: model || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929",
            max_tokens: maxTokens,
            system: systemPromptParam,
            messages,
            temperature: 0,
            ...(tools && { tools }),
            ...(outputFormat && {
                output_format: outputFormat
            })
        };

        await logToFile("Claude Request", requestParams);

        // Prepare request options with beta headers if needed
        const requestOptions: Anthropic.RequestOptions = outputFormat ? {
            headers: {
                'anthropic-beta': 'structured-outputs-2025-11-13'
            }
        } : {};

        // Stream with retry, fall back to Batches API if all retries exhausted.
        // Streaming is fast (seconds) but fragile on long requests. The Batches API
        // is slower (minutes of queue time) but immune to connection drops.
        // batchFirst: skip streaming entirely, go direct to Batches API (300K output limit).
        let response: Anthropic.Messages.Message;
        if (batchFirst) {
            response = await executeBatch(requestParams, requestOptions);
        } else {
            try {
                response = await withRetry(async () => {
                    const stream = anthropic.messages.stream(requestParams, requestOptions);
                    return stream.finalMessage();
                });
            } catch (e) {
                if (classifyTransientError(e)) {
                    console.log(`Streaming failed after retries, falling back to batch mode...`);
                    response = await executeBatch(requestParams, requestOptions);
                } else {
                    throw e;
                }
            }
        }

        await logToFile("Claude Response", response);

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
            const response2 = await aiChat<T>({
                model,
                systemPrompt,
                documentBase64,
                userPrompt,
                prefillSystemResponse: ((prefillSystemResponse || '') + responseText).trim(),
                prependToResponse: ((prependToResponse || '') + responseText).trim(),
                parseJson,
                maxTokens: maxTokensParam,
                tools,
                cacheSystemPrompt  // Preserve caching on continuation
            });
            return {
                usage: addUsage(response.usage, response2.usage),
                result: response2.result,
                maxTokens
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

        await logToFile("Parsed Result", responseJson);

        return {
            usage: response.usage,
            result: responseJson,
            maxTokens,
            response: response
        };
    } catch (e) {
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

