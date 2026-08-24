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

export const saveFailedCallback = async (entry: Omit<StoredCallback, 'filePath'>): Promise<string> => {
    const dir = ensureDataSubdir(SUBDIR);
    const name = [safe(entry.savedAt), safe(entry.taskType), safe(extractMeetingId(entry.callbackUrl)), safe(entry.taskStatusId)].join('_');
    const filePath = path.join(dir, `${name}.json`);
    await fs.promises.writeFile(filePath, JSON.stringify(entry, null, 2), 'utf8');
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

export const removeFailedCallback = async (taskStatusId: string): Promise<boolean> => {
    const entries = await listFailedCallbacks();
    const match = entries.find(e => e.taskStatusId === taskStatusId);
    if (!match?.filePath) return false;
    await fs.promises.unlink(match.filePath);
    return true;
};
