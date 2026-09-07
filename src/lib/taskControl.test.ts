import { describe, it, expect } from 'vitest';
import {
    TaskCancelledError,
    abortableSleep,
    getTaskControl,
    newTaskControl,
    runWithTaskControl,
    throwIfCancelled,
} from './taskControl.js';

describe('taskControl context', () => {

    it('getTaskControl returns undefined outside a task run (CLI/test behavior)', () => {
        expect(getTaskControl()).toBeUndefined();
    });

    it('propagates the control through async boundaries', async () => {
        const control = newTaskControl('task_1');
        await runWithTaskControl(control, async () => {
            await new Promise(resolve => setTimeout(resolve, 1));
            expect(getTaskControl()).toBe(control);
            expect(getTaskControl()!.taskId).toBe('task_1');
        });
    });

    it('throwIfCancelled is a no-op when not cancelled or outside a task', () => {
        expect(() => throwIfCancelled()).not.toThrow();
    });

    it('throwIfCancelled throws TaskCancelledError after cancel aborts', async () => {
        const control = newTaskControl('task_2');
        control.cancel.abort();
        await runWithTaskControl(control, async () => {
            expect(() => throwIfCancelled()).toThrow(TaskCancelledError);
        });
    });

    it('throwIfCancelled is a no-op inside a run that has not been cancelled', async () => {
        const control = newTaskControl('task_3');
        await runWithTaskControl(control, async () => {
            expect(() => throwIfCancelled()).not.toThrow();
        });
    });
});

describe('abortableSleep', () => {

    it('resolves early when the signal aborts mid-sleep', async () => {
        const controller = new AbortController();
        const start = Date.now();
        const sleep = abortableSleep(10_000, controller.signal);
        controller.abort();
        await sleep;
        expect(Date.now() - start).toBeLessThan(1000);
    });

    it('resolves immediately for an already-aborted signal', async () => {
        const controller = new AbortController();
        controller.abort();
        await abortableSleep(10_000, controller.signal); // must not hang
    });

    it('sleeps normally without a signal', async () => {
        const start = Date.now();
        await abortableSleep(20);
        expect(Date.now() - start).toBeGreaterThanOrEqual(15);
    });
});
