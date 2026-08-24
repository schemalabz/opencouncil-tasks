import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deliverTerminalCallback, RETRY_DELAYS_MS } from './callbackDelivery.js';
import type { saveFailedCallback } from './failedCallbackStore.js';

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

    it('retries a 5xx and persists nothing once it succeeds', async () => {
        const post = vi.fn()
            .mockResolvedValueOnce({ ok: false, status: 500 })
            .mockResolvedValueOnce({ ok: false, status: 502 })
            .mockResolvedValue({ ok: true, status: 200 });
        const save = vi.fn<typeof saveFailedCallback>(async () => '/tmp/x.json');

        await deliverTerminalCallback(url, payload, 'transcribe', { post, sleep: spySleep(), save });

        expect(post).toHaveBeenCalledTimes(3);
        expect(save).not.toHaveBeenCalled();
    });

    it('retries a network error', async () => {
        const post = vi.fn()
            .mockResolvedValueOnce({ ok: false, error: 'fetch failed' })
            .mockResolvedValue({ ok: true, status: 200 });
        const save = vi.fn<typeof saveFailedCallback>(async () => '/tmp/x.json');

        await deliverTerminalCallback(url, payload, 'transcribe', { post, sleep: spySleep(), save });

        expect(post).toHaveBeenCalledTimes(2);
        expect(save).not.toHaveBeenCalled();
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

    it('persists after exhausting every retry, having waited the full literal schedule', async () => {
        const post = vi.fn(async () => ({ ok: false, status: 500 }));
        const save = vi.fn<typeof saveFailedCallback>(async () => '/tmp/x.json');
        const sleep = spySleep();

        await deliverTerminalCallback(url, payload, 'transcribe', { post, sleep, save });

        expect(post).toHaveBeenCalledTimes(RETRY_DELAYS_MS.length + 1);
        expect(sleep.mock.calls.map(call => call[0])).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000]);
        expect(save).toHaveBeenCalledTimes(1);
        expect(save.mock.calls[0][0]).toMatchObject({ attempts: RETRY_DELAYS_MS.length + 1 });
    });

    it('never throws when persistence itself fails', async () => {
        const post = vi.fn(async () => ({ ok: false, status: 500 }));
        const save = vi.fn(async () => { throw new Error('disk full'); });

        await expect(
            deliverTerminalCallback(url, payload, 'transcribe', { post, sleep: spySleep(), save })
        ).resolves.toBeUndefined();
    });
});
