import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import path from 'path';
import { promises as fs } from 'fs';
import { fetchAdalineDeployment, submitAdalineLog } from './adaline.js';

dotenv.config();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
export type ResultWithUsage<T> = {
    result: T;
    usage: Anthropic.Messages.Usage;
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
const maxTokens = 64000;
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
    documentBase64?: string;
    systemPrompt: string;
    userPrompt: string;
    prefillSystemResponse?: string;
    prependToResponse?: string;
    parseJson?: boolean;
    tools?: Anthropic.Messages.Tool[];
    outputFormat?: Anthropic.Beta.Messages.MessageCreateParams['output_format'];
    cacheSystemPrompt?: boolean;  // Enable prompt caching for system prompt
}

async function withRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
    while (true) {
        try {
            return await fn();
        } catch (e: any) {
            if (e?.error?.error?.type === 'rate_limit_error' && e.headers?.['anthropic-ratelimit-tokens-reset']) {
                const resetTime = new Date(e.headers['anthropic-ratelimit-tokens-reset']);
                const now = new Date();
                const sleepTime = resetTime.getTime() - now.getTime() + 1000;
                console.log(`Rate limit hit, sleeping until ${resetTime.toISOString()} (${sleepTime}ms)`);
                await sleep(sleepTime);
                continue;
            }
            throw e;
        }
    }
}

export async function aiChat<T>({ systemPrompt, userPrompt, prefillSystemResponse, prependToResponse, documentBase64, parseJson = true, tools, outputFormat, cacheSystemPrompt = false }: AiChatOptions): Promise<ResultWithUsage<T>> {
    try {
        console.log(`Sending message to claude...`);
        if (outputFormat) {
            console.log(`Using structured outputs (JSON schema)`);
        }
        if (cacheSystemPrompt) {
            console.log(`Using prompt caching for system prompt`);
        }

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
            model: "claude-sonnet-4-5-20250929",
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

        let response = await withRateLimitRetry(() =>
            anthropic.messages.create(requestParams, requestOptions)
        );

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
            console.log(`Claude stopped because it reached the max tokens of ${maxTokens}`);
            console.log(`Attempting to continue with a longer response...`);
            const response2 = await aiChat<T>({
                systemPrompt,
                documentBase64,
                userPrompt,
                prefillSystemResponse: ((prefillSystemResponse || '') + responseText).trim(),
                prependToResponse: ((prependToResponse || '') + responseText).trim(),
                tools,
                cacheSystemPrompt  // Preserve caching on continuation
            });
            return {
                usage: addUsage(response.usage, response2.usage),
                result: response2.result
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
            response: response
        };
    } catch (e) {
        console.error(`Error in aiChat: ${e}`);
        await logToFile("Error in aiChat", e);
        throw e;
    }
}

export async function aiWithAdaline<T>({ projectId, deploymentId, variables, parseJson = true }: { projectId: string, deploymentId?: string, variables: { [key: string]: string }, parseJson?: boolean }): Promise<ResultWithUsage<T>> {
    const deployment = await fetchAdalineDeployment(projectId, deploymentId);
    if (deployment.config.provider !== "anthropic") {
        throw new Error("Adaline deployment provider is not anthropic");
    }

    for (const message of deployment.messages) {
        for (const content of message.content) {
            if (content.modality !== "text") {
                throw new Error(`Expected text modality in message content, got ${content.modality}`);
            }
        }
    }

    for (const variable of deployment.variables) {
        if (variable.value.modality !== "text") {
            throw new Error(`Expected text modality in variable value, got ${variable.value.modality}`);
        }
    }
    const messages = deployment.messages.map(msg => ({
        role: msg.role as "user" | "assistant" | "system",
        content: msg.content.map(c => {
            let value = c.value;
            for (const [varName, varValue] of Object.entries(variables)) {
                value = value.replace(new RegExp(`{${varName}}`, 'g'), varValue);
            }
            return value;
        }).join('\n')
    }));

    const requestParams = {
        model: deployment.config.model,
        messages: messages.filter((msg): msg is { role: "user" | "assistant"; content: string; } =>
            msg.role === "user" || msg.role === "assistant"),
        system: messages.find(msg => msg.role === "system")?.content,
        max_tokens: deployment.config.settings.maxTokens,
        temperature: deployment.config.settings.temperature,
    };

    await logToFile("Adaline Claude Request", requestParams);

    const response = await withRateLimitRetry(() =>
        anthropic.messages.create(requestParams)
    );

    await logToFile("Adaline Claude Response", response);

    if (!response.content || response.content.length !== 1) {
        throw new Error("Expected 1 response from claude, got " + response.content?.length);
    }

    if (response.content[0].type !== "text") {
        throw new Error("Expected text response from claude, got " + response.content[0].type);
    }

    const completion = response.content[0].text;

    submitAdalineLog({
        projectId: projectId,
        provider: deployment.config.provider,
        model: deployment.config.model,
        completion: completion,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        variables
    });

    let responseJson: T;
    if (parseJson) {
        try {
            responseJson = JSON.parse(completion) as T;
        } catch (e) {
            console.error(`Error parsing Claude response: ${completion.slice(0, 100)}`);
            await logToFile(`Error parsing Claude response: ${completion.slice(0, 100)}`, e);
            throw e;
        }
    } else {
        responseJson = completion as T;
    }

    await logToFile("Adaline Parsed Result", responseJson);
    return {
        usage: response.usage,
        result: responseJson
    };
}