import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import path from 'path';
import { promises as fs } from 'fs';
import { fetchAdalineDeployment, submitAdalineLog } from './adaline.js';

dotenv.config();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
export type ResultWithUsage<T> = { result: T, usage: Anthropic.Messages.Usage };
const maxTokens = 8192;
const useDelay = 1000 * 60;
let lastUseTimestamp = 0;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function aiChat<T>(systemPrompt: string, userPrompt: string, prefillSystemResponse?: string, prependToResponse?: string): Promise<ResultWithUsage<T>> {
    lastUseTimestamp = Date.now();

    try {
        console.log(`Sending message to claude...`);
        let messages: Anthropic.Messages.MessageParam[] = [];
        messages.push({ "role": "user", "content": userPrompt });
        if (prefillSystemResponse) {
            messages.push({ "role": "assistant", "content": prefillSystemResponse });
        }

        let response: Anthropic.Messages.Message;
        try {
            response = await anthropic.messages.create({
                model: "claude-3-5-sonnet-20241022",
                max_tokens: maxTokens,
                system: systemPrompt,
                messages,
                temperature: 0,
            });
        } catch (e) {
            console.error(`Error in aiChat: ${e}`);
            throw e;
        }

        if (!response.content || response.content.length !== 1) {
            throw new Error("Expected 1 response from claude, got " + response.content?.length);
        }

        if (response.content[0].type !== "text") {
            throw new Error("Expected text response from claude, got " + response.content[0].type);
        }

        if (response.stop_reason === "max_tokens") {
            console.log(`Claude stopped because it reached the max tokens of ${maxTokens}`);
            console.log(`Attempting to continue with a longer response...`);
            const response2 = await aiChat<T>(systemPrompt, userPrompt, (prefillSystemResponse + response.content[0].text).trim(), (prependToResponse + response.content[0].text).trim());
            return {
                usage: {
                    input_tokens: response.usage.input_tokens + response2.usage.input_tokens,
                    output_tokens: response.usage.output_tokens + response2.usage.output_tokens,
                },
                result: response2.result
            }
        }

        let responseContent = response.content[0].text;
        if (prependToResponse) {
            responseContent = prependToResponse + responseContent;
        }

        let responseJson: T;
        try {
            responseJson = JSON.parse(responseContent) as T;
        } catch (e) {
            console.error(`Error in aiChat. Response started with ${responseContent.slice(0, 100)}`);
            throw e;
        }

        return {
            usage: response.usage,
            result: responseJson
        };
    } catch (e) {
        console.error(`Error in aiChat: ${e}`);
        throw e;
    }
}

export async function aiWithAdaline<T>({ projectId, deploymentId, variables }: { projectId: string, deploymentId?: string, variables: { [key: string]: string } }): Promise<ResultWithUsage<T>> {
    const deployment = await fetchAdalineDeployment(projectId, deploymentId);
    if (deployment.config.provider !== "anthropic") {
        throw new Error("Adaline deployment provider is not anthropic");
    }

    // Check that all message content modalities are "text"
    for (const message of deployment.messages) {
        for (const content of message.content) {
            if (content.modality !== "text") {
                throw new Error(`Expected text modality in message content, got ${content.modality}`);
            }
        }
    }

    // Check that all variable values have text modality
    for (const variable of deployment.variables) {
        if (variable.value.modality !== "text") {
            throw new Error(`Expected text modality in variable value, got ${variable.value.modality}`);
        }
    }
    const messages = deployment.messages.map(msg => ({
        role: msg.role as "user" | "assistant" | "system",
        content: msg.content.map(c => {
            let value = c.value;
            // Replace variables in the format {varname} with their values
            for (const [varName, varValue] of Object.entries(variables)) {
                value = value.replace(new RegExp(`{${varName}}`, 'g'), varValue);
            }
            return value;
        }).join('\n')
    }));

    const response = await anthropic.messages.create({
        model: deployment.config.model,
        messages: messages.filter((msg): msg is { role: "user" | "assistant"; content: string; } =>
            msg.role === "user" || msg.role === "assistant"),
        system: messages.find(msg => msg.role === "system")?.content,
        max_tokens: deployment.config.settings.maxTokens,
        temperature: deployment.config.settings.temperature,
    });

    if (!response.content || response.content.length !== 1) {
        throw new Error("Expected 1 response from claude, got " + response.content?.length);
    }

    if (response.content[0].type !== "text") {
        throw new Error("Expected text response from claude, got " + response.content[0].type);
    }

    const completion = response.content[0].text;

    // fire and forget
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
    try {
        responseJson = JSON.parse(completion) as T;
    } catch (e) {
        console.error(`Error parsing Claude response: ${completion.slice(0, 100)}`);
        throw e;
    }

    console.log(responseJson);
    return {
        usage: response.usage,
        result: responseJson
    };
}