import { anthropic } from '@ai-sdk/anthropic';
import { wrapLanguageModel } from 'ai';
import type { LanguageModelV2Middleware } from '@ai-sdk/provider';
import { z } from 'zod';
import dotenv from 'dotenv';
import { promises as fs } from 'fs';
import path from 'path';
import { Langfuse } from 'langfuse';

dotenv.config();

/**
 * Langfuse client for AI observability
 * Only initialized if Langfuse credentials are available
 */
export const langfuse = process.env.LANGFUSE_SECRET_KEY && process.env.LANGFUSE_PUBLIC_KEY
  ? new Langfuse({
      secretKey: process.env.LANGFUSE_SECRET_KEY,
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      baseUrl: process.env.LANGFUSE_BASEURL || 'https://cloud.langfuse.com'
    })
  : null;

const logFilePath = path.join(process.env.LOG_DIR || process.cwd(), 'ai.log');

/**
 * Logging middleware that maintains existing log file behavior
 * Logs both requests and responses to ai.log
 */
const loggingMiddleware: LanguageModelV2Middleware = {
  wrapGenerate: async ({ doGenerate, params }) => {
    const timestamp = new Date().toISOString();
    try {
      await fs.appendFile(logFilePath, `${timestamp} - AI SDK Request:\n${JSON.stringify(params, null, 2)}\n---\n`);
    } catch (err) {
      console.error('Failed to write request to log file:', err);
    }
    
    const result = await doGenerate();
    
    try {
      await fs.appendFile(logFilePath, `${timestamp} - AI SDK Response:\n${JSON.stringify(result, null, 2)}\n---\n`);
    } catch (err) {
      console.error('Failed to write response to log file:', err);
    }
    
    return result;
  }
};

/**
 * Retry middleware for handling rate limits
 * Replaces the manual withRateLimitRetry logic
 */
const retryMiddleware: LanguageModelV2Middleware = {
  wrapGenerate: async ({ doGenerate }) => {
    let retries = 0;
    const maxRetries = 3;
    
    while (true) {
      try {
        return await doGenerate();
      } catch (error: any) {
        // Check for Anthropic rate limit error
        if (error?.statusCode === 429 && retries < maxRetries) {
          const retryAfter = error.headers?.['retry-after'] 
            ? parseInt(error.headers['retry-after']) * 1000 
            : 5000 * Math.pow(2, retries);
          
          console.log(`Rate limit hit, retrying after ${retryAfter}ms (attempt ${retries + 1}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, retryAfter));
          retries++;
          continue;
        }
        throw error;
      }
    }
  }
};

/**
 * Base Anthropic model instance
 */
const claudeModel = anthropic('claude-sonnet-4-20250514');

/**
 * Wrapped model with retry and logging middleware applied
 * This is the main export to use for all AI operations
 */
export const model = wrapLanguageModel({
  model: claudeModel,
  middleware: [retryMiddleware, loggingMiddleware]
});

/**
 * Zod schema for speaker segment summaries
 * Matches the AiSummarizeResponse type from summarize.ts
 */
export const speakerSegmentSummarySchema = z.object({
  speakerSegmentId: z.string(),
  summary: z.string(),
  topicLabels: z.array(z.string()),
  type: z.enum(["SUBSTANTIAL", "PROCEDURAL"])
});

/**
 * Zod schema for extracted subjects
 * Matches the ExtractedSubject type from processAgenda.ts
 */
export const extractedSubjectSchema = z.object({
  name: z.string(),
  description: z.string(),
  speakerSegments: z.array(z.object({
    speakerSegmentId: z.string(),
    summary: z.string().nullable()
  })),
  highlightedUtteranceIds: z.array(z.string()),
  locationText: z.string().nullable(),
  introducedByPersonId: z.string().nullable(),
  topicLabel: z.string().nullable()
});

/**
 * Type inference from schemas for type-safe AI responses
 */
export type AiSummarizeResponse = z.infer<typeof speakerSegmentSummarySchema>;
export type ExtractedSubjectResponse = z.infer<typeof extractedSubjectSchema>;
