import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Configured Anthropic model for Claude Sonnet 4
 * Uses ANTHROPIC_API_KEY from environment variables
 */
export const claudeModel = anthropic('claude-sonnet-4-20250514');

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
