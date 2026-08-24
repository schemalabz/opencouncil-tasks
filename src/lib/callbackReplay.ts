import { postCallback } from './callbackDelivery.js';
import { removeFailedCallback, type StoredCallback } from './failedCallbackStore.js';

export type GuardVerdict = { allowed: boolean; reason?: string };
export type RemoteTaskState = { status?: string; updatedAt?: string } | null;

/**
 * A failed callback never updated the row, so a task that has moved on since
 * the payload was saved has been re-run — replaying would overwrite it.
 */
export const guardReplay = (entry: StoredCallback, remote: RemoteTaskState, force: boolean): GuardVerdict => {
    if (force) return { allowed: true };

    if (!remote) {
        return { allowed: false, reason: 'could not read the current task state; use --force to post anyway' };
    }

    if (remote.status === 'succeeded') {
        return { allowed: false, reason: 'task already succeeded (re-run?); use --force to post anyway' };
    }

    // A missing or unparseable updatedAt is unknown state, not "untouched" — refuse rather than assume it's safe.
    const remoteUpdatedAt = remote.updatedAt ? Date.parse(remote.updatedAt) : NaN;
    if (Number.isNaN(remoteUpdatedAt)) {
        return { allowed: false, reason: 'could not read the task\'s last-updated time; use --force to post anyway' };
    }

    if (remoteUpdatedAt > Date.parse(entry.savedAt)) {
        return { allowed: false, reason: `task changed at ${remote.updatedAt}, after this payload was saved; use --force to post anyway` };
    }

    return { allowed: true };
};

export const fetchTaskState = async (callbackUrl: string): Promise<RemoteTaskState> => {
    try {
        const response = await fetch(callbackUrl, { method: 'GET' });
        if (!response.ok) return null;
        const body = await response.json() as { status?: string; updatedAt?: string };
        return { status: body.status, updatedAt: body.updatedAt };
    } catch {
        return null;
    }
};

export type ReplayDeps = {
    fetchState?: typeof fetchTaskState;
    post?: typeof postCallback;
    remove?: typeof removeFailedCallback;
};

export const replayStoredCallback = async (
    entry: StoredCallback,
    opts: { force: boolean },
    deps: ReplayDeps = {}
): Promise<{ replayed: boolean; reason?: string }> => {
    const fetchState = deps.fetchState ?? fetchTaskState;
    const post = deps.post ?? postCallback;
    const remove = deps.remove ?? removeFailedCallback;

    const verdict = guardReplay(entry, await fetchState(entry.callbackUrl), opts.force);
    if (!verdict.allowed) {
        return { replayed: false, reason: verdict.reason };
    }

    const result = await post(entry.callbackUrl, entry.payload);
    if (!result.ok) {
        return { replayed: false, reason: `delivery failed: ${result.status ?? result.error}` };
    }

    await remove(entry.taskStatusId);
    return { replayed: true };
};
