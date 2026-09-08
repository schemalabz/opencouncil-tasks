import { describe, it, expect, vi, beforeEach } from 'vitest';

// The only real obstacle to testing runWithTaskTrace is the Langfuse client
// construction; the trace object it hands back is a plain recorder.
const generation = { end: vi.fn() };
const trace = { update: vi.fn(), event: vi.fn(), generation: vi.fn(() => generation) };
const traceFactory = vi.fn(() => trace);
vi.mock('langfuse', () => ({
    Langfuse: class {
        trace = traceFactory;
        on = vi.fn();
        flushAsync = vi.fn(async () => {});
    },
}));

const { runWithTaskTrace, observeGeneration } = await import('./observability.js');
const { NO_USAGE } = await import('./ai.js');
const { TaskCancelledError, newTaskControl, runWithTaskControl } = await import('./taskControl.js');

const OPTS = { taskType: 'test', version: 1, input: {}, callbackUrl: 'http://cb' };
const tagsOf = () => trace.update.mock.calls.at(-1)![0].tags as string[];

describe('runWithTaskTrace failure tagging', () => {
    beforeEach(() => {
        vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk');
        vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'pk');
        trace.update.mockClear();
        trace.event.mockClear();
    });

    it('tags a genuine failure as an error', async () => {
        await expect(runWithTaskTrace(OPTS, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
        expect(tagsOf()).toContain('status:error');
        expect(tagsOf()).not.toContain('status:cancelled');
        expect(trace.event).toHaveBeenCalledWith(expect.objectContaining({ name: 'task-error', level: 'ERROR' }));
    });

    it('tags a TaskCancelledError as cancelled, not an error', async () => {
        await expect(runWithTaskTrace(OPTS, async () => { throw new TaskCancelledError('nope'); })).rejects.toThrow();
        expect(tagsOf()).toContain('status:cancelled');
        expect(tagsOf()).not.toContain('status:error');
        expect(trace.event).toHaveBeenCalledWith(expect.objectContaining({ name: 'task-cancelled', level: 'WARNING' }));
    });

    it('tags a cancel that surfaced as a wrapped SDK abort as cancelled', async () => {
        const control = newTaskControl('task_1');
        control.cancel.abort();
        await expect(runWithTaskControl(control, () =>
            runWithTaskTrace(OPTS, async () => { throw new Error('Request was aborted.'); })
        )).rejects.toThrow();
        expect(tagsOf()).toContain('status:cancelled');
        expect(tagsOf()).not.toContain('status:error');
    });
});

describe('observeGeneration on a call that fails after its response arrived', () => {
    beforeEach(() => {
        vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk');
        vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'pk');
        generation.end.mockClear();
    });

    it('keeps the usage on a generation closed with an error', async () => {
        // A refusal after partial text or a context-window stop is billed; closing
        // the generation as an error must not drop those tokens from the trace.
        await runWithTaskTrace(OPTS, async () => {
            observeGeneration({ name: 'g', model: 'm', input: [], systemPrompt: 's' })
                .error('Claude declined this request.', { ...NO_USAGE, input_tokens: 12, output_tokens: 3 });
        });

        expect(generation.end).toHaveBeenCalledWith(expect.objectContaining({
            level: 'ERROR',
            statusMessage: 'Claude declined this request.',
            usageDetails: expect.objectContaining({ input: 12, output: 3 }),
        }));
    });
});
