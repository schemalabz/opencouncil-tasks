import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getResponse, putResponse, responseKey, responsePrefix, type StoredResponse } from './responseStore.js';
import { fsStore } from '../archive/store.js';

const stored = (cacheKey: string): StoredResponse => ({
    v: 1, cacheKey, callId: 'c1', recordedAt: '2026-10-11T00:00:00Z',
    message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'hi', citations: null }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } as any,
});

describe('responseStore', () => {
    let dataDir: string; let archiveDir: string; const prev = process.env.DATA_DIR;
    beforeEach(() => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-data-'));
        archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-arch-'));
        process.env.DATA_DIR = dataDir;
    });
    afterEach(() => { if (prev === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prev; });

    it('writes to the archive and reads it back, even before the write lands', async () => {
        const archive = fsStore(archiveDir);
        const key = 'ab' + '1'.repeat(62);
        const writing = putResponse(stored(key), archive);
        expect((await getResponse(key, archive))?.message.model).toBe('claude-haiku-5-5');
        await writing;
        expect(await archive.exists(responseKey(key, '2026-10-11T00:00:00Z', 'c1'))).toBe(true);
        expect((await getResponse(key, archive))?.cacheKey).toBe(key);
    });

    // A server without ARCHIVE_URL must not accumulate every response on its own disk.
    it('stores and serves nothing without an archive', async () => {
        const key = 'cd' + '2'.repeat(62);
        await putResponse(stored(key), null);
        expect(await getResponse(key, null)).toBeNull();
        expect(fs.readdirSync(dataDir)).toEqual([]);
    });

    it('keeps every recording and serves the earliest', async () => {
        const archive = fsStore(archiveDir);
        const key = 'aa' + '4'.repeat(62);
        await archive.put(responseKey(key, '2026-10-12T00:00:00Z', 'late'), JSON.stringify({ ...stored(key), callId: 'late' }));
        await archive.put(responseKey(key, '2026-10-11T00:00:00Z', 'early'), JSON.stringify({ ...stored(key), callId: 'early' }));
        const keys: string[] = [];
        for await (const k of archive.list(responsePrefix(key))) keys.push(k);
        expect(keys).toHaveLength(2);
        expect((await getResponse(key, archive))?.callId).toBe('early');
    });

    it('returns null when nothing is recorded', async () => {
        expect(await getResponse('ef' + '3'.repeat(62), fsStore(archiveDir))).toBeNull();
    });
});
