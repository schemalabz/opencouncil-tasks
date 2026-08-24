import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { saveFailedCallback, listFailedCallbacks, removeFailedCallback } from './failedCallbackStore.js';

let tmp: string;

beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cbstore-'));
    process.env.DATA_DIR = tmp;
});

afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.DATA_DIR;
});

const entry = {
    callbackUrl: 'https://opencouncil.gr/api/cities/chania/meetings/aug24_2026/taskStatuses/cmt6vzim1?token=abc',
    taskType: 'transcribe',
    taskStatusId: 'cmt6vzim1',
    savedAt: '2026-08-24T10:12:52.611Z',
    attempts: 9,
    lastStatus: 500,
    payload: { status: 'success', result: { utterances: 3 } },
};

describe('failedCallbackStore', () => {
    it('round-trips a saved payload', async () => {
        await saveFailedCallback(entry);

        const all = await listFailedCallbacks();
        expect(all).toHaveLength(1);
        expect(all[0].taskStatusId).toBe('cmt6vzim1');
        expect(all[0].payload).toEqual({ status: 'success', result: { utterances: 3 } });
        expect(all[0].callbackUrl).toContain('token=abc');
    });

    it('removes by task status id', async () => {
        await saveFailedCallback(entry);

        expect(await removeFailedCallback('cmt6vzim1')).toBe(true);
        expect(await listFailedCallbacks()).toHaveLength(0);
        expect(await removeFailedCallback('cmt6vzim1')).toBe(false);
    });

    it('skips a malformed file instead of failing the listing', async () => {
        await saveFailedCallback(entry);
        fs.writeFileSync(path.join(tmp, 'failed-callbacks', 'broken.json'), '{not json');

        const all = await listFailedCallbacks();
        expect(all).toHaveLength(1);
    });

    it('writes a filename with no path separators from the meeting id', async () => {
        const filePath = await saveFailedCallback(entry);

        expect(path.basename(filePath)).toContain('chania-aug24_2026');
        expect(path.basename(filePath)).toContain('cmt6vzim1');
        expect(path.basename(filePath)).not.toContain('/');
        expect(path.basename(filePath)).not.toContain(':');
    });
});
