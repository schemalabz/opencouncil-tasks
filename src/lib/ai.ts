
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import path from 'path';
import { promises as fs } from 'fs';

dotenv.config();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
export type ResultWithUsage<T> = { result: T, usage: Anthropic.Messages.Usage };
const maxTokens = 8192;
const useDelay = 1000 * 60;
let lastUseTimestamp = 0;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function aiChat<T>(systemPrompt: string, userPrompt: string, prefillSystemResponse?: string, prependToResponse?: string): Promise<ResultWithUsage<T>> {
    if (Date.now() - lastUseTimestamp < useDelay) {
        await sleep(useDelay);
    }
    lastUseTimestamp = Date.now();

    try {
        console.log(`Sending message to claude...`);
        let messages: Anthropic.Messages.MessageParam[] = [];
        messages.push({ "role": "user", "content": userPrompt });
        if (prefillSystemResponse) {
            messages.push({ "role": "assistant", "content": prefillSystemResponse });
        }

        const response = await anthropic.messages.create({
            model: "claude-3-5-sonnet-20240620",
            max_tokens: maxTokens,
            system: systemPrompt,
            messages,
            temperature: 0,
        });

        if (!response.content || response.content.length !== 1) {
            throw new Error("Expected 1 response from claude, got " + response.content?.length);
        }

        if (response.content[0].type !== "text") {
            throw new Error("Expected text response from claude, got " + response.content[0].type);
        }

        let responseContent = response.content[0].text;
        if (prependToResponse) {
            responseContent = prependToResponse + responseContent;
        }

        await fs.writeFile(
            path.join(process.cwd(), 'lastClaudeResponse.json'),
            JSON.stringify(responseContent, null, 2),
        );
        console.log('Response saved to ./lastClaudeResponse.json');

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