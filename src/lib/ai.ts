import { generateText, generateObject } from 'ai';
import type { ModelMessage } from 'ai';
import { model } from './aiClient.js';
import { z } from 'zod';
import dotenv from 'dotenv';
import { fetchAdalineDeployment, submitAdalineLog } from './adaline.js';

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

export const NO_USAGE: Usage = { 
    input_tokens: 0, 
    output_tokens: 0, 
    cache_creation_input_tokens: 0, 
    cache_read_input_tokens: 0 
};

export const addUsage = (usage: Usage, otherUsage: Usage): Usage => ({
    input_tokens: usage.input_tokens + otherUsage.input_tokens,
    output_tokens: usage.output_tokens + otherUsage.output_tokens,
    cache_creation_input_tokens: (usage.cache_creation_input_tokens || 0) + (otherUsage.cache_creation_input_tokens || 0),
    cache_read_input_tokens: (usage.cache_read_input_tokens || 0) + (otherUsage.cache_read_input_tokens || 0),
});

const maxTokens = 64000;

type AiChatOptions = {
    documentBase64?: string;
    systemPrompt: string;
    userPrompt: string;
    prefillSystemResponse?: string;
    prependToResponse?: string;
    parseJson?: boolean;
    schema?: z.ZodType; // Optional Zod schema for structured output
}

export async function aiChat<T>({ 
    systemPrompt, 
    userPrompt, 
    prefillSystemResponse, 
    prependToResponse, 
    documentBase64, 
    parseJson = true,
    schema
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

        // Enable telemetry if CAPTURE_PAYLOADS is enabled
        const telemetryEnabled = process.env.CAPTURE_PAYLOADS === 'true';
        
        // Get sessionId from context for Langfuse grouping
        const sessionId = getSessionId();
        const context = getTelemetryContext();
        
        // Build telemetry metadata (filter out undefined values)
        const telemetryMetadata: Record<string, string> = Object.fromEntries(
            Object.entries({
                sessionId: sessionId,
                taskType: context?.taskType,
                taskId: context?.taskId
            }).filter(([_, value]) => value !== undefined)
        ) as Record<string, string>;

        // Build descriptive functionId with task type prefix
        const baseFunctionId = schema && parseJson ? 'aiChat-generateObject' : 'aiChat-generateText';
        const functionId = context?.taskType ? `${context.taskType}.${baseFunctionId}` : baseFunctionId;

        // Use generateObject if schema provided and parseJson is true
        if (schema && parseJson) {
            const result = await generateObject({
                model,
                system: systemPrompt,
                messages,
                schema,
                temperature: 0,
                maxOutputTokens: maxTokens,
                mode: 'json',
                experimental_telemetry: telemetryEnabled ? {
                    isEnabled: true,
                    functionId: functionId,
                    metadata: telemetryMetadata
                } : undefined
            });

            // Handle prependToResponse for partial results
            let finalObject = result.object;
            if (prependToResponse && Array.isArray(result.object)) {
                // The prepend logic is already handled by prefillSystemResponse
                // which makes the model continue an existing JSON array
            }

            return {
                result: finalObject as T,
                usage: {
                    input_tokens: result.usage.inputTokens ?? 0,
                    output_tokens: result.usage.outputTokens ?? 0,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0
                }
            };
        } else {
            // Use generateText for non-schema responses
            const result = await generateText({
                model,
                system: systemPrompt,
                messages,
                temperature: 0,
                maxOutputTokens: maxTokens,
                experimental_telemetry: telemetryEnabled ? {
                    isEnabled: true,
                    functionId: functionId,
                    metadata: telemetryMetadata
                } : undefined
            });

            // Handle max_tokens continuation
            if (result.finishReason === 'length') {
                console.log(`Claude stopped because it reached the max tokens of ${maxTokens}`);
                console.log(`Attempting to continue with a longer response...`);
                
                const continuedPrefill = (prefillSystemResponse || '') + result.text;
                const continuedPrepend = (prependToResponse || '') + result.text;
                
                const response2 = await aiChat<T>({ 
                    systemPrompt, 
                    documentBase64, 
                    userPrompt, 
                    prefillSystemResponse: continuedPrefill.trim(), 
                    prependToResponse: continuedPrepend.trim(),
                    parseJson,
                    schema
                });
                
                return {
                    usage: {
                        input_tokens: (result.usage.inputTokens ?? 0) + response2.usage.input_tokens,
                        output_tokens: (result.usage.outputTokens ?? 0) + response2.usage.output_tokens,
                        cache_creation_input_tokens: 0,
                        cache_read_input_tokens: 0,
                    },
                    result: response2.result
                };
            }

            let responseContent = result.text;
            if (prependToResponse) {
                responseContent = prependToResponse + responseContent;
            }

            let responseJson: T;
            if (parseJson) {
                try {
                    responseJson = JSON.parse(responseContent) as T;
                } catch (e) {
                    console.error(`Error parsing Claude response: ${responseContent.slice(0, 100)}`);
                    throw e;
                }
            } else {
                responseJson = responseContent as T;
            }

            return {
                usage: {
                    input_tokens: result.usage.inputTokens ?? 0,
                    output_tokens: result.usage.outputTokens ?? 0,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0
                },
                result: responseJson
            };
        }
    } catch (e) {
        console.error(`Error in aiChat: ${e}`);
        throw e;
    }
}

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

    // Get sessionId from context for Langfuse grouping
    const sessionId = getSessionId();
    const context = getTelemetryContext();
    
    // Build telemetry metadata (filter out undefined values)
    const telemetryMetadata: Record<string, string> = Object.fromEntries(
        Object.entries({
            sessionId: sessionId,
            taskType: context?.taskType,
            taskId: context?.taskId,
            adalineProjectId: projectId
        }).filter(([_, value]) => value !== undefined)
    ) as Record<string, string>;

    // Build descriptive functionId with task type prefix
    const functionId = context?.taskType ? `${context.taskType}.aiWithAdaline` : 'aiWithAdaline';

    // Use AI SDK (automatically benefits from retry and logging middleware!)
    const result = await generateText({
        model,
        system: systemMessage,
        messages,
        maxOutputTokens: deployment.config.settings.maxTokens,
        temperature: deployment.config.settings.temperature,
        experimental_telemetry: process.env.CAPTURE_PAYLOADS === 'true' ? {
            isEnabled: true,
            functionId: functionId,
            metadata: telemetryMetadata
        } : undefined
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
        usage: {
            input_tokens: result.usage.inputTokens ?? 0,
            output_tokens: result.usage.outputTokens ?? 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0
        },
        result: responseJson
    };
}