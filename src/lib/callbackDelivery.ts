import { saveFailedCallback, taskStatusIdFromUrl } from './failedCallbackStore.js';

export type PostResult = { ok: boolean; status?: number; error?: string };

export type DeliveryDeps = {
    post?: typeof postCallback;
    sleep?: (ms: number) => Promise<void>;
    save?: typeof saveFailedCallback;
};

/** One immediate attempt, then these waits between retries: ~4m15s in total. */
export const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000] as const;

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export const postCallback = async (callbackUrl: string, payload: unknown): Promise<PostResult> => {
    try {
        const response = await fetch(callbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        return { ok: response.ok, status: response.status };
    } catch (error: any) {
        return { ok: false, error: error?.message ?? String(error) };
    }
};

/** A 4xx will never succeed on retry; a 5xx or a network error might. */
const isRetryable = (result: PostResult): boolean =>
    result.error !== undefined || result.status === undefined || result.status >= 500;

export const deliverTerminalCallback = async (
    callbackUrl: string,
    payload: unknown,
    taskType: string,
    deps: DeliveryDeps = {}
): Promise<void> => {
    const post = deps.post ?? postCallback;
    const sleep = deps.sleep ?? defaultSleep;
    const save = deps.save ?? saveFailedCallback;

    let attempts = 0;
    let last: PostResult = { ok: false };

    for (let i = 0; i <= RETRY_DELAYS_MS.length; i++) {
        last = await post(callbackUrl, payload);
        attempts++;

        if (last.ok) {
            if (attempts > 1) {
                console.log(`Callback for ${taskType} delivered after ${attempts} attempts`);
            }
            return;
        }

        if (!isRetryable(last)) break;

        if (i < RETRY_DELAYS_MS.length) {
            console.warn(`Callback for ${taskType} failed (${last.status ?? last.error}), retrying in ${RETRY_DELAYS_MS[i] / 1000}s`);
            await sleep(RETRY_DELAYS_MS[i]);
        }
    }

    console.error(`Callback for ${taskType} undeliverable after ${attempts} attempt(s): ${last.status ?? last.error}`);

    const taskStatusId = taskStatusIdFromUrl(callbackUrl);

    try {
        const filePath = await save({
            callbackUrl,
            taskType,
            taskStatusId,
            savedAt: new Date().toISOString(),
            attempts,
            lastStatus: last.status,
            lastError: last.error,
            payload,
        });
        console.error(`Saved undelivered payload to ${filePath} — replay with: npm run cli -- callbacks replay ${taskStatusId}`);
    } catch (error) {
        console.error('Failed to persist the undelivered callback payload:', error);
    }
};
