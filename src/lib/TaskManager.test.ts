import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TaskManager } from './TaskManager.js';
import { Task } from '../tasks/pipeline.js';
import { abortableSleep, getTaskControl, throwIfCancelled } from './taskControl.js';

// Collects the JSON bodies of every callback the manager sends.
function stubCallbacks(): { payloads: any[] } {
    const collected = { payloads: [] as any[] };
    vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => {
        collected.payloads.push(JSON.parse(init.body));
        return new Response('ok');
    }));
    return collected;
}

// A task that sleeps cooperatively in small steps, observing cancellation.
const slowTask: Task<{ steps: number }, string> = async (args, onProgress) => {
    for (let i = 0; i < args.steps; i++) {
        onProgress(`step-${i}`, (i / args.steps) * 100);
        await abortableSleep(50, getTaskControl()?.cancel.signal);
        throwIfCancelled();
    }
    return 'done';
};

describe('TaskManager cancellation', () => {

    beforeEach(() => vi.unstubAllGlobals());

    it('returns a taskId at submission and reports it in updates', async () => {
        stubCallbacks();
        const manager = new TaskManager(2);
        const { taskId, completion } = manager.runTaskWithCallback(slowTask, { steps: 1 }, 'http://cb', 'test');
        expect(taskId).toMatch(/^task_\d+$/);
        expect(manager.getTaskUpdates()[0].taskId).toBe(taskId);
        await completion;
    });

    it('cancelling a running task sends a cancelled callback and frees the slot', async () => {
        const callbacks = stubCallbacks();
        const manager = new TaskManager(2);
        const { taskId, completion } = manager.runTaskWithCallback(slowTask, { steps: 100 }, 'http://cb', 'test');

        await new Promise(resolve => setTimeout(resolve, 60)); // let it start
        expect(manager.cancelTask(taskId)).toBe('cancelling');
        await completion;

        const terminal = callbacks.payloads.at(-1);
        expect(terminal.status).toBe('cancelled');
        expect(manager.getTaskUpdates()).toHaveLength(0);
    });

    it('cancelling a queued task dequeues it and sends a cancelled callback', async () => {
        const callbacks = stubCallbacks();
        const manager = new TaskManager(1); // capacity 1 → second task queues
        const first = manager.runTaskWithCallback(slowTask, { steps: 5 }, 'http://cb1', 'test');
        const second = manager.runTaskWithCallback(slowTask, { steps: 5 }, 'http://cb2', 'test');

        expect(manager.getQueuedTasksCount()).toBe(1);
        expect(manager.cancelTask(second.taskId)).toBe('cancelled');
        expect(manager.getQueuedTasksCount()).toBe(0);

        const cancelledCallback = callbacks.payloads.find(p => p.status === 'cancelled');
        expect(cancelledCallback).toBeDefined();

        manager.cancelTask(first.taskId);
        await Promise.all([first.completion, second.completion]);
    });

    it('cancelTask returns null for unknown ids', () => {
        stubCallbacks();
        const manager = new TaskManager(2);
        expect(manager.cancelTask('task_999')).toBeNull();
    });

    it('promoteTask flips llmMode to streaming and aborts the promote signal', async () => {
        stubCallbacks();
        const manager = new TaskManager(2);
        let observedMode: string | undefined;
        let observedPromoteAborted: boolean | undefined;
        const probeTask: Task<{}, string> = async (_args, _onProgress) => {
            await abortableSleep(100, getTaskControl()?.promote.signal);
            observedMode = getTaskControl()?.llmMode;
            observedPromoteAborted = getTaskControl()?.promote.signal.aborted;
            return 'ok';
        };
        const { taskId, completion } = manager.runTaskWithCallback(probeTask, {}, 'http://cb', 'test');
        expect(manager.promoteTask(taskId)).toBe(true);
        await completion;
        expect(observedMode).toBe('streaming');
        expect(observedPromoteAborted).toBe(true);
        expect(manager.promoteTask('task_999')).toBe(false);
    });

    it('a non-cancellation error still reports status error', async () => {
        const callbacks = stubCallbacks();
        const manager = new TaskManager(2);
        const failingTask: Task<{}, string> = async () => { throw new Error('boom'); };
        const { completion } = manager.runTaskWithCallback(failingTask, {}, 'http://cb', 'test');
        await completion;
        expect(callbacks.payloads.at(-1).status).toBe('error');
        expect(callbacks.payloads.at(-1).error).toBe('boom');
    });
});
