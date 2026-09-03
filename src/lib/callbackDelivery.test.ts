import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { deliverTerminalCallback, RETRY_DELAYS_MS } from './callbackDelivery.js';
import { saveFailedCallback, listFailedCallbacks } from './failedCallbackStore.js';

const url = 'https://opencouncil.gr/api/cities/chania/meetings/aug24_2026/taskStatuses/t1?token=abc';
const payload = { status: 'success', result: { ok: true } };

/** Records the delay it was called with instead of actually waiting, so tests run instantly. */
const spySleep = () => vi.fn(async (_ms: number) => { });

describe('deliverTerminalCallback', () => {
    // The implementation logs on every retry/failure path; these are expected
    // noise from the scenarios under test, not signs of a broken test.
    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => { });
        vi.spyOn(console, 'warn').mockImplementation(() => { });
        vi.spyOn(console, 'error').mockImplementation(() => { });
    });

    it('is the documented exponential backoff schedule', () => {
        expect(RETRY_DELAYS_MS).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000]);
    });

    it('does not persist when the first attempt succeeds', async () => {
        const post = vi.fn(async () => ({ ok: true, status: 200 }));
        const save = vi.fn<typeof saveFailedCallback>(async () => '/tmp/x.json');

        await deliverTerminalCallback(url, payload, 'transcribe', { post, sleep: spySleep(), save });

        expect(post).toHaveBeenCalledTimes(1);
        expect(save).not.toHaveBeenCalled();
    });

    it('persists on the first retryable failure, ahead of exhausting the schedule', async () => {
        const post = vi.fn()
            .mockResolvedValueOnce({ ok: false, status: 500 })
            .mockResolvedValueOnce({ ok: false, status: 502 })
            .mockResolvedValue({ ok: true, status: 200 });
        const save = vi.fn<typeof saveFailedCallback>(async () => '/tmp/x.json');

        await deliverTerminalCallback(url, payload, 'transcribe', { post, sleep: spySleep(), save });

        expect(post).toHaveBeenCalledTimes(3);
        // Persisted once, right after the first 500 — not held back until the retries ran out.
        expect(save).toHaveBeenCalledTimes(1);
        expect(save.mock.calls[0][0]).toMatchObject({ attempts: 1, lastStatus: 500 });
    });

    it('retries a network error, persisting after the first one', async () => {
        const post = vi.fn()
            .mockResolvedValueOnce({ ok: false, error: 'fetch failed' })
            .mockResolvedValue({ ok: true, status: 200 });
        const save = vi.fn<typeof saveFailedCallback>(async () => '/tmp/x.json');

        await deliverTerminalCallback(url, payload, 'transcribe', { post, sleep: spySleep(), save });

        expect(post).toHaveBeenCalledTimes(2);
        expect(save).toHaveBeenCalledTimes(1);
        expect(save.mock.calls[0][0]).toMatchObject({ attempts: 1, lastError: 'fetch failed' });
    });

    it('persists a 4xx immediately without retrying', async () => {
        const post = vi.fn(async () => ({ ok: false, status: 401 }));
        const save = vi.fn<typeof saveFailedCallback>(async () => '/tmp/x.json');

        await deliverTerminalCallback(url, payload, 'transcribe', { post, sleep: spySleep(), save });

        expect(post).toHaveBeenCalledTimes(1);
        expect(save).toHaveBeenCalledTimes(1);
        expect(save.mock.calls[0][0]).toMatchObject({
            taskStatusId: 't1',
            taskType: 'transcribe',
            lastStatus: 401,
            attempts: 1,
            payload,
        });
    });

    it('persists after exhausting every retry, having waited the full literal schedule, with the final attempt count', async () => {
        const post = vi.fn(async () => ({ ok: false, status: 500 }));
        const save = vi.fn<typeof saveFailedCallback>(async () => '/tmp/x.json');
        const sleep = spySleep();

        await deliverTerminalCallback(url, payload, 'transcribe', { post, sleep, save });

        expect(post).toHaveBeenCalledTimes(RETRY_DELAYS_MS.length + 1);
        expect(sleep.mock.calls.map(call => call[0])).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000]);

        // Saved once on the first failure, then overwritten once more at exhaustion —
        // never a fresh file, and the stored state must be the final attempt count, not the first.
        expect(save).toHaveBeenCalledTimes(2);
        expect(save.mock.calls[0][0]).toMatchObject({ attempts: 1, lastStatus: 500 });
        expect(save.mock.calls[0][1]).toBeUndefined();
        expect(save.mock.calls[1][0]).toMatchObject({ attempts: RETRY_DELAYS_MS.length + 1, lastStatus: 500 });
        expect(save.mock.calls[1][1]).toBe('/tmp/x.json');
    });

    it('never throws when persistence itself fails', async () => {
        const post = vi.fn(async () => ({ ok: false, status: 500 }));
        const save = vi.fn(async () => { throw new Error('disk full'); });

        await expect(
            deliverTerminalCallback(url, payload, 'transcribe', { post, sleep: spySleep(), save })
        ).resolves.toBeUndefined();
    });
});

describe('deliverTerminalCallback — disk persistence lifecycle', () => {
    let tmp: string;

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cbdelivery-'));
        process.env.DATA_DIR = tmp;
        vi.spyOn(console, 'log').mockImplementation(() => { });
        vi.spyOn(console, 'warn').mockImplementation(() => { });
        vi.spyOn(console, 'error').mockImplementation(() => { });
    });

    afterEach(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
        delete process.env.DATA_DIR;
    });

    it('writes the payload to disk and removes it once a later attempt succeeds', async () => {
        const post = vi.fn()
            .mockResolvedValueOnce({ ok: false, status: 500 })
            .mockResolvedValueOnce({ ok: false, status: 500 })
            .mockResolvedValue({ ok: true, status: 200 });
        const save = vi.fn(saveFailedCallback); // real implementation, spied

        await deliverTerminalCallback(url, payload, 'transcribe', { post, sleep: spySleep(), save });

        // Only one save call for two failures — persisted once, right after the first — and
        // nothing left on disk once delivery went through.
        expect(save).toHaveBeenCalledTimes(1);
        expect(await listFailedCallbacks()).toHaveLength(0);
    });

    it('leaves exactly one file on disk, carrying the final attempt count, once retries are exhausted', async () => {
        const post = vi.fn(async () => ({ ok: false, status: 500 }));
        const save = vi.fn(saveFailedCallback); // real implementation, spied

        await deliverTerminalCallback(url, payload, 'transcribe', { post, sleep: spySleep(), save });

        const entries = await listFailedCallbacks();
        expect(entries).toHaveLength(1);
        expect(entries[0].attempts).toBe(RETRY_DELAYS_MS.length + 1);
        expect(entries[0].lastStatus).toBe(500);
    });

    it('keeps savedAt at the first persist, so a re-run mid-retry still trips the replay guard', async () => {
        const post = vi.fn(async () => ({ ok: false, status: 500 }));
        const save = vi.fn(saveFailedCallback); // real implementation, spied

        await deliverTerminalCallback(url, payload, 'transcribe', { post, sleep: spySleep(), save });

        // savedAt is the watermark the replay guard compares the task's updatedAt against.
        // Refreshing it on the final write would move it past a re-run that started during the
        // retry window, and the guard would allow the stale payload over the fresh result.
        const written = save.mock.calls.map(call => call[0].savedAt);
        expect(written.length).toBeGreaterThan(1);
        expect(new Set(written).size).toBe(1);
        expect((await listFailedCallbacks())[0].savedAt).toBe(written[0]);
    });
});
