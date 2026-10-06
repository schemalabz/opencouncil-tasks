import { toTaskTokenUsage } from '../lib/ai.js';
import type { ReadTranscriptFactsRequest, ReadTranscriptFactsResult } from '../types.js';
import type { Task } from './pipeline.js';
import { readTranscriptFacts as runPass } from './utils/transcriptFacts.js';

/**
 * Read what the transcript states about the meeting — the roll call, the
 * stated arrivals and departures, the votes and who presided — matched to the
 * roster. The same pass fixTranscript runs, on its own for a rerun after review.
 */
export const readTranscriptFacts: Task<ReadTranscriptFactsRequest, ReadTranscriptFactsResult> = async (request, onProgress) => {
    if (!request.people || request.people.length === 0) throw new Error('readTranscriptFacts needs the meeting\'s people to match the names');
    const { result, usage } = await runPass({ ...request, people: request.people }, onProgress);
    return { reading: result, usage: toTaskTokenUsage(usage) };
};
