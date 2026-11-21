import { summarize } from '../../tasks/summarize.js';
import { processBatchesWithState } from '../../tasks/summarize/batchProcessing.js';
import { compressIds, decompressIds } from '../../tasks/summarize/compression.js';
import { mergeSubjects } from '../../tasks/summarize/mergeSubjects.js';
import type { SummarizeRequest, SummarizeResult } from '../../types.js';
import { IdCompressor } from '../../utils.js';
import { withCallbackUrl } from '../taskRunner.js';
import { CONTEXT, CONTRIBUTIONS, subjectSuite, WHOLE_SUBJECT, type Slice } from './subjects.js';

function summarizeSuite(id: string, labels: string[], slice: Slice, replayLive?: string[]) {
    return subjectSuite({
        id, task: 'summarize', labels, slice, replayLive,
        run: async (c, ctx) => summarize(withCallbackUrl(ctx.request, c.input.meeting, `eval-${c.id}`) as SummarizeRequest, () => {}),
    });
}

// The description step is live in both phase suites: its request holds the contributions, so it
// never matches a recording once they change, and a recording older than the step has no such call.
export const summarizeContributions = summarizeSuite('summarize.contributions', ['contributions:*'], CONTRIBUTIONS, ['contributions:*', 'subject-description:*']);
export const summarizeContext = summarizeSuite('summarize.context', ['subject-context-search:*'], CONTEXT, ['subject-context-search:*', 'subject-description:*']);
/** Every phase live by default (~$1–5 a meeting); pass --replay --live <glob> to pay for one phase. */
export const summarizeE2e = summarizeSuite('summarize.e2e', ['batch-processing:*', 'subject-merge', 'contributions:*', 'subject-context-search:*'], WHOLE_SUBJECT);

/**
 * Phase 1 and the subject merge alone, as the task runs them: the subjects, their descriptions and
 * the utterance tags, with no contributions and no context. A change to the batch prompt or model
 * makes every later recording miss, so this is how such a change is tried without paying for the
 * later phases. A variant's `params.additionalInstructions` is appended to the request's own, which
 * the batch prompt carries at its end: a prompt experiment with no code change.
 */
async function batchesOnly(request: SummarizeRequest, extraInstructions?: unknown): Promise<SummarizeResult> {
    const withExtra = typeof extraInstructions === 'string' && extraInstructions.trim()
        ? { ...request, additionalInstructions: [request.additionalInstructions, extraInstructions].filter(Boolean).join('\n\n') }
        : request;
    const idCompressor = new IdCompressor();
    const compressed = compressIds(withExtra, idCompressor);
    const batches = await processBatchesWithState(compressed, idCompressor, () => {});
    const merged = await mergeSubjects(batches.subjects, batches.allUtteranceStatuses);
    return decompressIds({
        speakerSegmentSummaries: batches.speakerSegmentSummaries,
        subjects: merged.subjects.map(({ locationText, ...subject }) => ({ ...subject, location: null, context: null })),
        utteranceDiscussionStatuses: merged.allUtteranceStatuses,
    } as unknown as Parameters<typeof decompressIds>[0], idCompressor);
}

export const summarizeBatches = subjectSuite({
    id: 'summarize.batches', task: 'summarize', labels: ['batch-processing:*', 'subject-merge'], slice: WHOLE_SUBJECT,
    expected: v => ({ ...v, contributions: [], context: null, contextCitationUrls: [] }),
    run: async (c, ctx) => batchesOnly(withCallbackUrl(ctx.request, c.input.meeting, `eval-${c.id}`) as SummarizeRequest, ctx.variant.params?.additionalInstructions),
});
