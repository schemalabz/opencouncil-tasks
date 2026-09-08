import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import { DuplicateTaskIdError, TaskManager, taskManager } from './TaskManager.js';
import { Task } from '../tasks/pipeline.js';
import { abortableSleep, getTaskControl, throwIfCancelled } from './taskControl.js';

// serveTask is the funnel every task endpoint goes through, so the callback
// URL check belongs to it rather than to any one route.
const buildRequest = (body: unknown) =>
    ({ path: '/someTask', body } as express.Request<{}, {}, any>);

const buildResponse = () => {
    const res = { statusCode: 0, body: undefined as unknown } as any;
    res.status = (code: number) => { res.statusCode = code; return res; };
    res.json = (payload: unknown) => { res.body = payload; return res; };
    return res;
};

describe('serveTask callback URL validation', () => {
    const neverRuns = vi.fn(async () => ({}));
    const handler = taskManager.serveTask(neverRuns as any);

    it.each([
        ['missing', {}],
        ['empty', { callbackUrl: '' }],
        ['not a URL', { callbackUrl: 'not-a-url' }],
        ['wrong scheme', { callbackUrl: 'ftp://example.com/cb' }],
    ])('rejects a %s callback URL without starting the task', (_label, body) => {
        const res = buildResponse();

        handler(buildRequest(body), res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ error: 'Invalid callback URL' });
        expect(neverRuns).not.toHaveBeenCalled();
    });

    it('accepts a callback URL carrying an authentication token', () => {
        const runTask = vi.spyOn(taskManager, 'runTaskWithCallback')
            .mockReturnValue({ taskId: 'task_test_1', completion: Promise.resolve() });
        const res = buildResponse();
        const callbackUrl = 'https://opencouncil.gr/api/cities/athens/meetings/m1/taskStatuses/t1?token=abc123';

        handler(buildRequest({ callbackUrl }), res);

        expect(res.statusCode).toBe(202);
        expect(res.body.taskId).toBe('task_test_1');
        expect(runTask).toHaveBeenCalledWith(expect.anything(), { callbackUrl }, callbackUrl, 'someTask', undefined);
        runTask.mockRestore();
    });
});

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
        expect(taskId).toMatch(/^task_[0-9a-f]{8}_\d+$/);
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
        expect(manager.promoteTask(taskId)).toBe('promoted');
        await completion;
        expect(observedMode).toBe('streaming');
        expect(observedPromoteAborted).toBe(true);
        expect(manager.promoteTask('task_999')).toBeNull();
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

    it('a task that only reports progress is cancelled at the onProgress checkpoint', async () => {
        const callbacks = stubCallbacks();
        const manager = new TaskManager(2);
        const progressOnlyTask: Task<{}, string> = async (_args, onProgress) => {
            for (let i = 0; i < 100; i++) {
                onProgress(`step-${i}`, i);
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            return 'done';
        };
        const { taskId, completion } = manager.runTaskWithCallback(progressOnlyTask, {}, 'http://cb', 'test');
        await new Promise(resolve => setTimeout(resolve, 30));
        manager.cancelTask(taskId);
        await completion;
        expect(callbacks.payloads.at(-1).status).toBe('cancelled');
    });

    it('two queued tasks both complete with success callbacks', async () => {
        const callbacks = stubCallbacks();
        const manager = new TaskManager(1); // capacity 1 → second task queues
        const shortTask: Task<{}, string> = async (_args, onProgress) => {
            onProgress('working', 50);
            await new Promise(resolve => setTimeout(resolve, 20));
            return 'done';
        };
        const first = manager.runTaskWithCallback(shortTask, {}, 'http://cb1', 'test');
        const second = manager.runTaskWithCallback(shortTask, {}, 'http://cb2', 'test');
        await Promise.all([first.completion, second.completion]);
        const successes = callbacks.payloads.filter(p => p.status === 'success');
        expect(successes).toHaveLength(2);
    });

    it('classifies a cancel that surfaces as a wrapped SDK error as cancelled', async () => {
        const callbacks = stubCallbacks();
        const manager = new TaskManager(2);
        const sdkLikeTask: Task<{}, string> = async () => {
            const signal = getTaskControl()!.cancel.signal;
            await abortableSleep(5_000, signal);
            // Simulates the SDK's APIUserAbortError: a plain Error, not TaskCancelledError
            throw new Error('Request was aborted.');
        };
        const { taskId, completion } = manager.runTaskWithCallback(sdkLikeTask, {}, 'http://cb', 'test');
        await new Promise(resolve => setTimeout(resolve, 20));
        manager.cancelTask(taskId);
        await completion;
        expect(callbacks.payloads.at(-1).status).toBe('cancelled');
    });
});

// ---------------------------------------------------------------------------
// PROPOSED
// ---------------------------------------------------------------------------

describe('TaskManager cancellation (proposed)', () => {

    beforeEach(() => vi.unstubAllGlobals());

    it('a cancel landing during the initial callback stops the task before its body runs', async () => {
        const manager = new TaskManager(2);
        const payloads: any[] = [];
        const body = vi.fn(async () => 'done');
        // The initial "initializing" callback is a deterministic hook into the window
        // between the task being registered and its body being entered — no sleeps.
        vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => {
            const payload = JSON.parse(init.body);
            payloads.push(payload);
            if (payload.stage === 'initializing') {
                expect(manager.cancelTask(payload.taskId)).toBe('cancelling');
            }
            return new Response('ok');
        }));

        const { completion } = manager.runTaskWithCallback(body as any, {}, 'http://cb', 'test');
        await completion;

        expect(body).not.toHaveBeenCalled();
        expect(payloads.at(-1)).toMatchObject({ status: 'cancelled', stage: 'cancelled' });
    });

    it('a cancelled task reports no error and the /tasks view empties', async () => {
        const callbacks = stubCallbacks();
        const manager = new TaskManager(2);
        const { taskId, completion } = manager.runTaskWithCallback(slowTask, { steps: 100 }, 'http://cb', 'test');

        expect(manager.cancelTask(taskId)).toBe('cancelling');
        await completion;

        const terminal = callbacks.payloads.at(-1);
        expect(terminal).toMatchObject({ status: 'cancelled', stage: 'cancelled', taskId });
        // A cancellation is not a failure: an error string here would show up as one downstream.
        expect(terminal.error).toBeUndefined();
        expect(manager.getTaskUpdates()).toHaveLength(0);
    });

    it('cancelling a queued task cancels that task, not the running one', async () => {
        const callbacks = stubCallbacks();
        const manager = new TaskManager(1);
        const first = manager.runTaskWithCallback(slowTask, { steps: 5 }, 'http://cb1', 'test');
        const second = manager.runTaskWithCallback(slowTask, { steps: 5 }, 'http://cb2', 'test');

        expect(manager.cancelTask(second.taskId)).toBe('cancelled');

        const cancelled = callbacks.payloads.filter(p => p.status === 'cancelled');
        expect(cancelled).toHaveLength(1);
        expect(cancelled[0]).toMatchObject({ taskId: second.taskId, taskType: 'test', stage: 'cancelled' });
        expect(manager.getTaskUpdates().map(t => t.taskId)).toEqual([first.taskId]);

        manager.cancelTask(first.taskId);
        await Promise.all([first.completion, second.completion]);
    });

    it('promotion is visible on the /tasks view, not just inside the task', async () => {
        stubCallbacks();
        const manager = new TaskManager(2);
        const probe: Task<{}, string> = async () => {
            await abortableSleep(5_000, getTaskControl()?.promote.signal);
            return 'ok';
        };
        const { taskId, completion } = manager.runTaskWithCallback(probe, {}, 'http://cb', 'test');

        expect(manager.getTaskUpdates()[0].llmMode).toBe('batch');
        manager.promoteTask(taskId);
        expect(manager.getTaskUpdates()[0].llmMode).toBe('streaming');

        await completion;
    });
});

describe('task ids derived from the callback URL', () => {

    beforeEach(() => vi.unstubAllGlobals());

    const callbackUrl = 'https://opencouncil.gr/api/cities/athens/meetings/m1/taskStatuses/clx123?token=abc';

    // Resolves only when the test lets it, so a submission is provably still
    // running when the duplicate arrives — no reliance on timing.
    const gatedTask = (): { task: Task<{}, string>; release: () => void } => {
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        return { task: async () => { await gate; return 'ok'; }, release };
    };

    it('addresses the task by the caller task status id', async () => {
        stubCallbacks();
        const manager = new TaskManager(2);
        const { taskId, completion } = manager.runTaskWithCallback(slowTask, { steps: 1 }, callbackUrl, 'test');

        expect(taskId).toBe('clx123');
        expect(manager.getTaskUpdates()[0].taskId).toBe('clx123');
        await completion;
    });

    it('generates an id when the callback URL carries no task status', async () => {
        stubCallbacks();
        const manager = new TaskManager(2);
        const local = 'http://localhost:3000/callback/cities/dev/meetings/observability-check';
        const { taskId, completion } = manager.runTaskWithCallback(slowTask, { steps: 1 }, local, 'test');

        expect(taskId).toMatch(/^task_[0-9a-f]{8}_\d+$/);
        await completion;
    });

    it('refuses to run a second task under an id already in flight', async () => {
        stubCallbacks();
        const manager = new TaskManager(2);
        const { task, release } = gatedTask();
        manager.runTaskWithCallback(task, {}, callbackUrl, 'test');

        expect(() => manager.runTaskWithCallback(task, {}, callbackUrl, 'test')).toThrow(DuplicateTaskIdError);

        release();
        await new Promise(resolve => setTimeout(resolve, 10));
    });

    it('answers a duplicate submission with 409 and starts nothing', async () => {
        stubCallbacks();
        const manager = new TaskManager(2);
        const { task, release } = gatedTask();
        const handler = manager.serveTask(task);

        const first = buildResponse();
        handler(buildRequest({ callbackUrl }), first);
        const second = buildResponse();
        handler(buildRequest({ callbackUrl }), second);

        expect(first.statusCode).toBe(202);
        expect(first.body.taskId).toBe('clx123');
        expect(second.statusCode).toBe(409);
        expect(manager.getTaskUpdates()).toHaveLength(1);

        release();
        await new Promise(resolve => setTimeout(resolve, 10));
    });

    it('frees the id once the task finishes', async () => {
        stubCallbacks();
        const manager = new TaskManager(2);
        await manager.runTaskWithCallback(slowTask, { steps: 1 }, callbackUrl, 'test').completion;

        const { taskId, completion } = manager.runTaskWithCallback(slowTask, { steps: 1 }, callbackUrl, 'test');
        expect(taskId).toBe('clx123');
        await completion;
    });
});
