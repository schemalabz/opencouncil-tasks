import { anthropic } from '@ai-sdk/anthropic';
import { wrapLanguageModel } from 'ai';
import type { LanguageModelV2Middleware } from '@ai-sdk/provider';
import { z } from 'zod';
import dotenv from 'dotenv';
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
 * Wrapped model with retry middleware applied
 * This is the main export to use for all AI operations
 * 
 * Note: Logging/observability is handled by Langfuse via OpenTelemetry instrumentation
 * See docs/observability.md for details
 */
export const model = wrapLanguageModel({
  model: claudeModel,
  middleware: [retryMiddleware]
});
