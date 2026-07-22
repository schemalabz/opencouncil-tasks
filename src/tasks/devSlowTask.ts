import { Task } from './pipeline.js';
import { abortableSleep, getTaskControl, throwIfCancelled } from '../lib/taskControl.js';
import { HAIKU_MODEL, aiChat } from '../lib/ai.js';

export type DevSlowTaskArgs = {
    iterations?: number;   // default 30
    sleepMs?: number;      // default 2000
    llmBatchCall?: boolean; // make one real batch-first aiChat call at the end
};

export type DevSlowTaskResult = {
    completedIterations: number;
    llmResult?: string;
    llmMode?: string;
};

/**
 * Dev-only canary for exercising cancellation and batch promotion end-to-end
 * without real workloads: sleeps cooperatively, and optionally makes one tiny
 * real Batch API call that can be promoted to streaming mid-flight.
 */
export const devSlowTask: Task<DevSlowTaskArgs, DevSlowTaskResult> = async (args, onProgress) => {
    const iterations = args.iterations ?? 30;
    const sleepMs = args.sleepMs ?? 2000;

    for (let i = 0; i < iterations; i++) {
        onProgress('sleeping', Math.round((i / iterations) * 90));
        await abortableSleep(sleepMs, getTaskControl()?.cancel.signal);
        throwIfCancelled();
    }

    let llmResult: string | undefined;
    if (args.llmBatchCall) {
        onProgress('llm', 90);
        const response = await aiChat<string>({
            model: HAIKU_MODEL,
            systemPrompt: 'You are terse.',
            userPrompt: 'Say hello in Greek.',
            parseJson: false,
            maxTokens: 100,
            batchFirst: true,
            label: 'devSlowTask',
        });
        llmResult = response.result;
    }

    onProgress('finished', 100);
    return { completedIterations: iterations, llmResult, llmMode: getTaskControl()?.llmMode };
};
