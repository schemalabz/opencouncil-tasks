/**
 * One shared deadline and one shared AbortSignal are threaded into every
 * adapter — queue waits, HTTP requests, poll sleeps, and the python subprocess.
 * A provider that ignores the signal keeps billing after the caller has given
 * up, which is exactly the double-charge the failure contract forbids.
 */

export class DeadlineExceededError extends Error {
    constructor(message = "fusion deadline exceeded") {
        super(message);
        this.name = "DeadlineExceededError";
    }
}

export interface DeadlineHandle {
    signal: AbortSignal;
    deadlineAt: number;
    remainingMs(): number;
    /** Whether the abort came from the deadline rather than the caller. */
    timedOut(): boolean;
    dispose(): void;
}

export function createDeadline(deadlineAt: number, parentSignal?: AbortSignal, now: () => number = Date.now): DeadlineHandle {
    const controller = new AbortController();
    let timedOut = false;

    const onParentAbort = () => controller.abort(parentSignal?.reason);
    if (parentSignal) {
        if (parentSignal.aborted) {
            controller.abort(parentSignal.reason);
        } else {
            parentSignal.addEventListener("abort", onParentAbort, { once: true });
        }
    }

    const remaining = deadlineAt - now();
    let timer: NodeJS.Timeout | undefined;
    if (remaining <= 0) {
        timedOut = true;
        controller.abort(new DeadlineExceededError());
    } else {
        timer = setTimeout(() => {
            timedOut = true;
            controller.abort(new DeadlineExceededError());
        }, remaining);
        timer.unref?.();
    }

    return {
        signal: controller.signal,
        deadlineAt,
        remainingMs: () => Math.max(0, deadlineAt - now()),
        timedOut: () => timedOut,
        dispose: () => {
            if (timer) clearTimeout(timer);
            parentSignal?.removeEventListener("abort", onParentAbort);
        },
    };
}

/** Sleep that wakes immediately on abort. Used by every polling loop. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(abortReason(signal));
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(abortReason(signal!));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

export function abortReason(signal: AbortSignal): Error {
    const reason = signal.reason;
    return reason instanceof Error ? reason : new DeadlineExceededError(String(reason ?? "aborted"));
}

export function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw abortReason(signal);
}
