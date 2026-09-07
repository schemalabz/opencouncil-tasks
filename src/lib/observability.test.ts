import { describe, it, expect, vi, beforeEach } from 'vitest';

// The only real obstacle to testing runWithTaskTrace is the Langfuse client
// construction; the trace object it hands back is a plain recorder.
const trace = { update: vi.fn(), event: vi.fn() };
const traceFactory = vi.fn(() => trace);
vi.mock('langfuse', () => ({
    Langfuse: class {
        trace = traceFactory;
        on = vi.fn();
        flushAsync = vi.fn(async () => {});
    },
}));

const { runWithTaskTrace } = await import('./observability.js');
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
