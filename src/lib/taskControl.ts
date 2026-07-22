import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Cooperative cancellation & LLM-mode control for a running task.
 *
 * TaskManager creates one TaskControl per task and establishes it via
 * AsyncLocalStorage (same pattern as runWithTaskTrace), so shared primitives
 * (ai.ts poll loops, SDK calls) can observe cancellation without any
 * parameter threading. Outside a managed task run (CLI, tests) there is no
 * store and every accessor degrades to a no-op.
 */

export class TaskCancelledError extends Error {
    constructor(message = 'Task cancelled') {
        super(message);
        this.name = 'TaskCancelledError';
    }
}

export type LlmMode = 'batch' | 'streaming';

export type TaskControl = {
    taskId: string;
    /** Aborted when the task is cancelled — terminal. */
    cancel: AbortController;
    /** Aborted when the task is promoted out of the Batch API — wakes the poll loop. */
    promote: AbortController;
    /** Once 'streaming', aiChat skips the Batch API for the rest of the task. */
    llmMode: LlmMode;
};

const storage = new AsyncLocalStorage<TaskControl>();

export function newTaskControl(taskId: string): TaskControl {
    return { taskId, cancel: new AbortController(), promote: new AbortController(), llmMode: 'batch' };
}

export function runWithTaskControl<R>(control: TaskControl, fn: () => Promise<R>): Promise<R> {
    return storage.run(control, fn);
}

export function getTaskControl(): TaskControl | undefined {
    return storage.getStore();
}

export function throwIfCancelled(): void {
    const control = getTaskControl();
    if (control?.cancel.signal.aborted) {
        throw new TaskCancelledError(`Task ${control.taskId} cancelled`);
    }
}

/**
 * Sleep that wakes early (resolves, does not reject) when the signal aborts.
 * Callers decide what an early wake means — see executeBatch.
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise(resolve => {
        if (signal?.aborted) return resolve();
        const done = () => {
            signal?.removeEventListener('abort', done);
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(done, ms);
        signal?.addEventListener('abort', done, { once: true });
    });
}
