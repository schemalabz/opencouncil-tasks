import fs from 'fs';
import path from 'path';
import { ensureDataSubdir } from './dataDir.js';
import { extractMeetingId } from '../utils.js';

export type StoredCallback = {
    callbackUrl: string;
    taskType: string;
    taskStatusId: string;
    savedAt: string;
    attempts: number;
    lastStatus?: number;
    lastError?: string;
    payload: unknown;
    filePath?: string;
};

const SUBDIR = 'failed-callbacks';

/** The task status id is the last path segment of the callback URL. */
export const taskStatusIdFromUrl = (callbackUrl: string): string => {
    try {
        return new URL(callbackUrl).pathname.split('/').filter(Boolean).pop() || 'unknown';
    } catch {
        return 'unknown';
    }
};

const safe = (value: string): string => value.replace(/[^\w.-]/g, '-');

/**
 * Writes a fresh file unless `overwritePath` is given, in which case it rewrites that
 * file in place — used to update attempts/status on a payload already persisted for an
 * earlier retryable failure, without leaving two files behind for the same callback.
 */
export const saveFailedCallback = async (entry: Omit<StoredCallback, 'filePath'>, overwritePath?: string): Promise<string> => {
    const dir = ensureDataSubdir(SUBDIR);
    const name = [safe(entry.savedAt), safe(entry.taskType), safe(extractMeetingId(entry.callbackUrl)), safe(entry.taskStatusId)].join('_');
    const filePath = overwritePath ?? path.join(dir, `${name}.json`);
    // The payload carries the callback URL's auth token — keep the file readable only by us.
    await fs.promises.writeFile(filePath, JSON.stringify(entry, null, 2), { encoding: 'utf8', mode: 0o600 });
    return filePath;
};

export const listFailedCallbacks = async (): Promise<StoredCallback[]> => {
    const dir = ensureDataSubdir(SUBDIR);
    const files = (await fs.promises.readdir(dir)).filter(f => f.endsWith('.json'));
    const entries: StoredCallback[] = [];

    for (const file of files) {
        const filePath = path.join(dir, file);
        try {
            const parsed = JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as StoredCallback;
            entries.push({ ...parsed, filePath });
        } catch (error) {
            console.warn(`Skipping unreadable failed-callback file ${file}:`, error);
        }
    }

    return entries.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
};

/**
 * Takes the file path directly rather than a taskStatusId: re-deriving the path by listing
 * and matching on taskStatusId could pick the wrong file if two entries ever shared one, and
 * would delete an undelivered payload without ever having redelivered it. Idempotent so two
 * concurrent replays of the same entry don't throw on the second unlink.
 */
export const removeFailedCallback = async (filePath: string): Promise<void> => {
    await fs.promises.rm(filePath, { force: true });
};
