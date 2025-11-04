import { generateText, generateObject } from 'ai';
import type { ModelMessage } from 'ai';
import { model } from './aiClient.js';
import { z } from 'zod';
import dotenv from 'dotenv';
import { fetchAdalineDeployment, submitAdalineLog } from './adaline.js';
import { getSessionId, getTelemetryContext } from './telemetryContext.js';

dotenv.config();

/**
 * Usage metrics from AI operations
 * Supports both AI SDK v5 format (null) and legacy format (undefined) for cache tokens
 */
export type Usage = {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
};

/**
 * Result with usage metrics from AI operations
 */
export type ResultWithUsage<T> = { 
    result: T;
    usage: Usage;
};

/**
 * Zero usage constant for initializing usage accumulation.
 * Use as starting point when tracking usage across multiple AI calls.
 */
export const NO_USAGE: Usage = { 
    input_tokens: 0, 
    output_tokens: 0, 
    cache_creation_input_tokens: 0, 
    cache_read_input_tokens: 0 
};

/**
 * Accumulate token usage across multiple AI calls.
 * Essential for tracking total costs within a task that makes multiple AI calls.
 * 
 * @example
 * let totalUsage = NO_USAGE;
 * const result1 = await aiChat(...);
 * totalUsage = addUsage(totalUsage, result1.usage);
 */
export const addUsage = (usage: Usage, otherUsage: Usage): Usage => ({
    input_tokens: usage.input_tokens + otherUsage.input_tokens,
    output_tokens: usage.output_tokens + otherUsage.output_tokens,
    cache_creation_input_tokens: (usage.cache_creation_input_tokens || 0) + (otherUsage.cache_creation_input_tokens || 0),
    cache_read_input_tokens: (usage.cache_read_input_tokens || 0) + (otherUsage.cache_read_input_tokens || 0),
});

// Maximum output tokens per AI call. When exceeded, automatic continuation is triggered.
// See docs/ai-client.md for details on continuation logic, quality, and cost implications.
const maxTokens = 64000;

type AiChatOptions = {
    documentBase64?: string;
    systemPrompt: string;
    userPrompt: string;
    prefillSystemResponse?: string;
    prependToResponse?: string;
    parseJson?: boolean;
    schema?: z.ZodType; // Optional Zod schema for structured output
    output?: 'object' | 'array'; // Output type when using schema
}

/**
 * Convert AI SDK usage format to our Usage type.
 * Centralizes usage conversion to avoid duplication and inconsistencies.
 */
function convertUsage(sdkUsage: { inputTokens?: number; outputTokens?: number }): Usage {
    return {
        input_tokens: sdkUsage.inputTokens ?? 0,
        output_tokens: sdkUsage.outputTokens ?? 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
    };
}

/**
 * Build telemetry configuration for AI SDK calls.
 * Centralizes telemetry setup to ensure consistent tracking across all AI operations.
 */
function buildTelemetryConfig(functionId: string, additionalMetadata?: Record<string, string>) {
    const telemetryEnabled = process.env.CAPTURE_PAYLOADS === 'true';
    if (!telemetryEnabled) return undefined;

    const sessionId = getSessionId();
    const context = getTelemetryContext();
    
    // Build telemetry metadata (filter out undefined values)
    const telemetryMetadata: Record<string, string> = Object.fromEntries(
        Object.entries({
            sessionId: sessionId,
            taskType: context?.taskType,
            taskId: context?.taskId,
            ...additionalMetadata
        }).filter(([_, value]) => value !== undefined)
    ) as Record<string, string>;

    // Build descriptive functionId with task type prefix
    const fullFunctionId = context?.taskType ? `${context.taskType}.${functionId}` : functionId;

    return {
        isEnabled: true,
        functionId: fullFunctionId,
        metadata: telemetryMetadata
    };
}

/**
 * Handle token limit continuation for AI responses.
 * When a response hits maxTokens, recursively continues generation using partial result as prefill.
 * 
 * @returns ResultWithUsage if continuation occurred, null if no continuation needed
 */
async function handleContinuation<T, R extends { finishReason: string; usage: any }>(
    result: R,
    getPartialContent: (result: R) => string,
    options: AiChatOptions
): Promise<ResultWithUsage<T> | null> {
    if (result.finishReason !== 'length') {
        return null; // No continuation needed
    }

    console.log(`Claude stopped because it reached the max tokens of ${maxTokens}`);
    console.log(`Attempting to continue with a longer response...`);
    
    const partialContent = getPartialContent(result);
    const continuedPrefill = (options.prefillSystemResponse || '') + partialContent;
    const continuedPrepend = (options.prependToResponse || '') + partialContent;
    
    const response2 = await aiChat<T>({ 
        ...options,
        prefillSystemResponse: continuedPrefill.trim(), 
        prependToResponse: continuedPrepend.trim()
    });
    
    return {
        usage: addUsage(convertUsage(result.usage), response2.usage),
        result: response2.result
    };
}

/**
 * Process text response: handle prepending and optional JSON parsing.
 */
function processTextResponse<T>(text: string, prependToResponse: string | undefined, parseJson: boolean): T {
    let responseContent = text;
    if (prependToResponse) {
        responseContent = prependToResponse + responseContent;
    }

    if (parseJson) {
        try {
            return JSON.parse(responseContent) as T;
        } catch (e) {
            console.error(`Error parsing Claude response: ${responseContent.slice(0, 100)}`);
            throw e;
        }
    } else {
        return responseContent as T;
    }
}

/**
 * Primary interface for AI operations with automatic continuation, retry, and observability.
 * 
 * Supports both unstructured text and schema-validated structured outputs. When responses
 * exceed maxTokens (64K), automatic continuation preserves output quality while increasing
 * token costs (partial response becomes input for next call).
 * 
 * @see docs/ai-client.md for architecture, continuation logic, and best practices
 */
export async function aiChat<T>({ 
    systemPrompt, 
    userPrompt, 
    prefillSystemResponse, 
    prependToResponse, 
    documentBase64, 
    parseJson = true,
    schema,
    output = 'object'
}: AiChatOptions): Promise<ResultWithUsage<T>> {
    try {
        console.log(`Sending message to claude via AI SDK...`);
        
        // Build messages array - AI SDK expects ModelMessage format
        const messages: ModelMessage[] = [];
        
        // Handle document attachments if provided
        if (documentBase64) {
            // Use AI SDK's file part format for PDF attachments
            messages.push({
                role: 'user',
                content: [
                    {
                        type: 'file',
                        data: documentBase64,  // Base64-encoded PDF data
                        mediaType: 'application/pdf'
                    },
                    {
                        type: 'text',
                        text: userPrompt
                    }
                ]
            });
        } else {
            messages.push({
                role: 'user',
                content: userPrompt
            });
        }
        
        // Handle prefill for assistant response (used for JSON array continuation)
        if (prefillSystemResponse) {
            messages.push({
                role: 'assistant',
                content: prefillSystemResponse
            });
        }

        // Build telemetry configuration
        const baseFunctionId = schema && parseJson ? 'aiChat-generateObject' : 'aiChat-generateText';
        const telemetryConfig = buildTelemetryConfig(baseFunctionId);

        // Use generateObject if schema provided and parseJson is true
        if (schema && parseJson) {
            const result = await generateObject({
                model,
                system: systemPrompt,
                messages,
                schema,
                output,  // 'object' or 'array' - tells SDK how to structure the response
                temperature: 0,
                maxOutputTokens: maxTokens,
                mode: 'json',
                experimental_telemetry: telemetryConfig
            });

            // Handle max_tokens continuation for structured outputs
            const continued = await handleContinuation<T, typeof result>(
                result,
                r => JSON.stringify(r.object), // Convert object to JSON for continuation
                { systemPrompt, documentBase64, userPrompt, prefillSystemResponse, prependToResponse, parseJson, schema, output }
            );
            if (continued) return continued;

            // Handle prependToResponse for partial results
            let finalObject = result.object;
            if (prependToResponse && Array.isArray(result.object)) {
                // The prepend logic is already handled by prefillSystemResponse
                // which makes the model continue an existing JSON array
            }

            return {
                result: finalObject as T,
                usage: convertUsage(result.usage)
            };
        } else {
            // Use generateText for non-schema responses
            const result = await generateText({
                model,
                system: systemPrompt,
                messages,
                temperature: 0,
                maxOutputTokens: maxTokens,
                experimental_telemetry: telemetryConfig
            });

            // Handle max_tokens continuation for text outputs
            const continued = await handleContinuation<T, typeof result>(
                result,
                r => r.text, // Use text directly for continuation
                { systemPrompt, documentBase64, userPrompt, prefillSystemResponse, prependToResponse, parseJson, schema }
            );
            if (continued) return continued;

            // Process text response (prepend and parse if needed)
            const responseJson = processTextResponse<T>(result.text, prependToResponse, parseJson);

            return {
                usage: convertUsage(result.usage),
                result: responseJson
            };
        }
    } catch (e) {
        console.error(`Error in aiChat: ${e}`);
        throw e;
    }
}

/**
 * Execute AI calls using versioned prompts from Adaline platform.
 * 
 * Enables external prompt management, A/B testing, and version control. Automatically
 * benefits from retry and logging middleware. Does not support continuation (use aiChat for that).
 * 
 * @see docs/ai-client.md for usage examples and best practices
 */
export async function aiWithAdaline<T>({ projectId, deploymentId, variables, parseJson = true }: { projectId: string, deploymentId?: string, variables: { [key: string]: string }, parseJson?: boolean }): Promise<ResultWithUsage<T>> {
    const deployment = await fetchAdalineDeployment(projectId, deploymentId);
    if (deployment.config.provider !== "anthropic") {
        throw new Error("Adaline deployment provider is not anthropic");
    }

    // Validate message content modality
    for (const message of deployment.messages) {
        for (const content of message.content) {
            if (content.modality !== "text") {
                throw new Error(`Expected text modality in message content, got ${content.modality}`);
            }
        }
    }

    // Validate variable modality
    for (const variable of deployment.variables) {
        if (variable.value.modality !== "text") {
            throw new Error(`Expected text modality in variable value, got ${variable.value.modality}`);
        }
    }
    
    // Process messages with variable substitution
    const processedMessages = deployment.messages.map(msg => ({
        role: msg.role as "user" | "assistant" | "system",
        content: msg.content.map(c => {
            let value = c.value;
            for (const [varName, varValue] of Object.entries(variables)) {
                value = value.replace(new RegExp(`{${varName}}`, 'g'), varValue);
            }
            return value;
        }).join('\n')
    }));

    // Build ModelMessage array for AI SDK
    const messages: ModelMessage[] = processedMessages
        .filter((msg): msg is { role: "user" | "assistant"; content: string; } =>
            msg.role === "user" || msg.role === "assistant")
        .map(msg => ({
            role: msg.role,
            content: msg.content
        }));
    
    const systemMessage = processedMessages.find(msg => msg.role === "system")?.content;

    // Build telemetry configuration with Adaline project metadata
    const telemetryConfig = buildTelemetryConfig('aiWithAdaline', { adalineProjectId: projectId });

    // Use AI SDK (automatically benefits from retry and logging middleware!)
    const result = await generateText({
        model,
        system: systemMessage,
        messages,
        maxOutputTokens: deployment.config.settings.maxTokens,
        temperature: deployment.config.settings.temperature,
        experimental_telemetry: telemetryConfig
    });

    const completion = result.text;

    // Submit usage to Adaline
    submitAdalineLog({
        projectId: projectId,
        provider: deployment.config.provider,
        model: deployment.config.model,
        completion: completion,
        inputTokens: result.usage.inputTokens ?? 0,
        outputTokens: result.usage.outputTokens ?? 0,
        variables
    });

    // Parse response if requested
    let responseJson: T;
    if (parseJson) {
        try {
            responseJson = JSON.parse(completion) as T;
        } catch (e) {
            console.error(`Error parsing Adaline response: ${completion.slice(0, 100)}`);
            throw e;
        }
    } else {
        responseJson = completion as T;
    }

    return {
        usage: convertUsage(result.usage),
        result: responseJson
    };
}