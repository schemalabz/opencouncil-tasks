import { summarize } from '../../tasks/summarize.js';
import type { SummarizeRequest } from '../../types.js';
import { withCallbackUrl } from '../taskRunner.js';
import { CONTEXT, CONTRIBUTIONS, subjectSuite, WHOLE_SUBJECT, type Slice } from './subjects.js';

function summarizeSuite(id: string, labels: string[], slice: Slice, replayLive?: string[]) {
    return subjectSuite({
        id, task: 'summarize', labels, slice, replayLive,
        run: async (c, ctx) => summarize(withCallbackUrl(ctx.request, c.input.meeting, `eval-${c.id}`) as SummarizeRequest, () => {}),
    });
}

export const summarizeContributions = summarizeSuite('summarize.contributions', ['contributions:*'], CONTRIBUTIONS, ['contributions:*']);
export const summarizeContext = summarizeSuite('summarize.context', ['subject-context-search:*'], CONTEXT, ['subject-context-search:*']);
/** Every phase live by default (~$1–5 a meeting); pass --replay --live <glob> to pay for one phase. */
export const summarizeE2e = summarizeSuite('summarize.e2e', ['batch-processing:*', 'subject-merge', 'contributions:*', 'subject-context-search:*'], WHOLE_SUBJECT);
