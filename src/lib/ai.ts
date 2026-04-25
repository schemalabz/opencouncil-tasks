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
async function logToFile(message: string, data?: any) {
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
}

export type TransientErrorKind = 'connection' | 'server' | false;

export function classifyTransientError(e: unknown): TransientErrorKind {
    if (e instanceof Anthropic.APIConnectionError) return 'connection';
    if (e instanceof Anthropic.InternalServerError) return 'server';
    // The SDK doesn't have a dedicated class for 529 (overloaded), but it maps
    // to InternalServerError (>= 500). Check the inner type for completeness.
    if (e instanceof Anthropic.APIError) {
        const inner = (e.error as any)?.error?.type;
        if (inner === 'overloaded_error') return 'server';
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

export async function aiChat<T>({ model, systemPrompt, userPrompt, prefillSystemResponse, prependToResponse, documentBase64, parseJson = true, maxTokens: maxTokensParam, tools, outputFormat, cacheSystemPrompt = false }: AiChatOptions): Promise<ResultWithUsage<T>> {
    const maxTokens = maxTokensParam ?? 64000;
    try {
        console.log(`Sending message to claude...`);
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

        // Use .stream() helper for long requests (>10 minutes) - it handles accumulation automatically
        // Wrap in withRetry to handle transient connection errors (socket closures, etc.)
        const response = await withRetry(async () => {
            const stream = anthropic.messages.stream(requestParams, requestOptions);
            return stream.finalMessage();
        });

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
        await logToFile("Error in aiChat", e);
        throw formatApiError(e);
    }
}

