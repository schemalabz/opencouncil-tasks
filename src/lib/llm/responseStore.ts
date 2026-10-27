import type Anthropic from '@anthropic-ai/sdk';
import { archiveKeys, configuredArchive, type ArchiveStore } from '../archive/store.js';

/** The full API message is kept, not just its text: replay must return citations and server tool results too. */
export type StoredResponse = {
    v: 1;
    cacheKey: string;
    message: Anthropic.Messages.Message;
    callId: string;
    recordedAt: string;
};

export const responsePrefix = archiveKeys.responsePrefix;
export const responseKey = archiveKeys.response;

function archiveOrNull(): ArchiveStore | null {
    try {
        return configuredArchive();
    } catch (e) {
        console.error('Response store: archive unavailable:', e instanceof Error ? e.message : e);
        return null;
    }
}

// Responses whose archive write is still in flight, so a call made right after a recording
// reads it back. Each entry leaves when its write settles.
const inflight = new Map<string, StoredResponse>();

/** The earliest recording for this key; none without a configured archive. */
export async function getResponse(cacheKey: string, archive: ArchiveStore | null = archiveOrNull()): Promise<StoredResponse | null> {
    if (!archive) return null;
    const pending = inflight.get(cacheKey);
    if (pending) return pending;
    try {
        let first: string | undefined;
        for await (const key of archive.list(responsePrefix(cacheKey))) { first = key; break; }
        if (!first) return null;
        const body = await archive.get(first);
        if (!body) return null;
        return JSON.parse(body.toString('utf8')) as StoredResponse;
    } catch (e) {
        console.error(`Response store: archive read failed for ${cacheKey.slice(0, 12)}:`, e instanceof Error ? e.message : e);
        return null;
    }
}

/** The archive write is the caller's to await or spool. */
export async function putResponse(stored: StoredResponse, archive: ArchiveStore | null = archiveOrNull()): Promise<void> {
    if (!archive) return;
    if (!inflight.has(stored.cacheKey)) inflight.set(stored.cacheKey, stored);
    try {
        await archive.put(responseKey(stored.cacheKey, stored.recordedAt, stored.callId), JSON.stringify(stored), 'application/json');
    } finally {
        if (inflight.get(stored.cacheKey) === stored) inflight.delete(stored.cacheKey);
    }
}
