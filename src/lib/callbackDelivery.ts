import { saveFailedCallback, removeFailedCallback } from './failedCallbackStore.js';
import { extractMeetingId, taskStatusIdFromUrl } from '../utils.js';

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
            // Without this, an endpoint that accepts the connection but never responds costs
            // undici's 300s default headers timeout per attempt — across 9 attempts that turns
            // a multi-minute retry window into the better part of an hour.
            signal: AbortSignal.timeout(30_000),
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

    const taskStatusId = taskStatusIdFromUrl(callbackUrl) ?? 'unknown';
    let attempts = 0;
    let last: PostResult = { ok: false };
    // Once set, the payload is on disk; further persists overwrite this same file instead
    // of deriving a new one, so exactly one file ever exists for this callback.
    let savedPath: string | undefined;
    // Frozen at the first persist. The replay guard treats savedAt as the watermark after which
    // any remote change means a re-run; refreshing it on the final persist would push the
    // watermark past a re-run that started mid-retry, and the guard would wave the stale result through.
    let savedAt: string | undefined;

    // Docker gives the process ~10s to exit on redeploy, and a redeploy is most likely to
    // land precisely during the outage that triggered these retries — so the payload must
    // hit disk on the FIRST retryable failure, not only after every attempt is exhausted.
    const persist = async (): Promise<void> => {
        savedAt ??= new Date().toISOString();
        try {
            savedPath = await save(
                {
                    callbackUrl,
                    taskType,
                    taskStatusId,
                    savedAt,
                    attempts,
                    lastStatus: last.status,
                    lastError: last.error,
                    payload,
                },
                savedPath
            );
            console.error(`Saved undelivered payload to ${savedPath} — replay with: npm run cli -- callbacks replay ${taskStatusId}`);
        } catch (error) {
            console.error('Failed to persist the undelivered callback payload:', error);
        }
    };

    // Both ways out of the loop end the same way: say why, try to keep the payload, and if
    // even that failed put it in the log — the last copy of the result, in the only place
    // that still ships off the box.
    //
    // The URL goes in token and all, because that is the whole point: re-delivering by hand
    // means POSTing the payload back, and a result with no destination is only half a
    // recovery. It widens nothing — TaskManager logs the same URL on every attempt, so any
    // log that reaches this line already carries the token nine times over.
    const giveUp = async (): Promise<void> => {
        console.error(`Callback for ${taskType} undeliverable after ${attempts} attempt(s): ${last.status ?? last.error}`);
        await persist();
        if (savedPath) return;
        console.error(
            `UNRECOVERABLE ${taskType} callback for ${extractMeetingId(callbackUrl)} (${taskStatusId}): neither ` +
            `delivered nor persisted. Re-deliver by POSTing the payload below to its callbackUrl. ` +
            JSON.stringify({ callbackUrl, payload })
        );
    };

    for (let i = 0; i <= RETRY_DELAYS_MS.length; i++) {
        last = await post(callbackUrl, payload);
        attempts++;

        if (last.ok) {
            if (savedPath) {
                await removeFailedCallback(savedPath).catch(error =>
                    console.error(`Failed to remove persisted payload at ${savedPath}:`, error)
                );
                console.log(`Callback for ${taskType} delivered after ${attempts} attempts (payload had been persisted to disk, now removed)`);
            } else if (attempts > 1) {
                console.log(`Callback for ${taskType} delivered after ${attempts} attempts`);
            }
            return;
        }

        if (!isRetryable(last)) {
            await giveUp();
            return;
        }

        if (!savedPath) {
            await persist();
        }

        if (i < RETRY_DELAYS_MS.length) {
            console.warn(`Callback for ${taskType} failed (${last.status ?? last.error}), retrying in ${RETRY_DELAYS_MS[i] / 1000}s`);
            await sleep(RETRY_DELAYS_MS[i]);
        }
    }

    // giveUp's persist overwrites the file saved on the first retryable failure, so it ends up
    // with the final attempt count and status rather than the stale values from that failure.
    await giveUp();
};
