import { describe, it, expect, vi } from 'vitest';
import { guardReplay, replayStoredCallback } from './callbackReplay.js';
import type { StoredCallback } from './failedCallbackStore.js';
import type { PostResult } from './callbackDelivery.js';

const entry = {
    callbackUrl: 'https://opencouncil.gr/api/cities/chania/meetings/aug24_2026/taskStatuses/t1?token=abc',
    taskType: 'transcribe',
    taskStatusId: 't1',
    savedAt: '2026-08-24T10:00:00.000Z',
    attempts: 9,
    payload: { status: 'success' },
    filePath: '/tmp/failed-callbacks/t1.json',
} as StoredCallback;

describe('guardReplay', () => {
    it('allows replay when the task is untouched since the payload was saved', () => {
        const verdict = guardReplay(entry, { status: 'pending', updatedAt: '2026-08-24T09:00:00.000Z' }, false);
        expect(verdict.allowed).toBe(true);
    });

    it('refuses when the task already succeeded', () => {
        const verdict = guardReplay(entry, { status: 'succeeded', updatedAt: '2026-08-24T09:00:00.000Z' }, false);
        expect(verdict.allowed).toBe(false);
        expect(verdict.reason).toContain('succeeded');
    });

    it('refuses when the task changed after the payload was saved (a re-run)', () => {
        const verdict = guardReplay(entry, { status: 'pending', updatedAt: '2026-08-24T11:00:00.000Z' }, false);
        expect(verdict.allowed).toBe(false);
        expect(verdict.reason).toContain('changed');
    });

    it('refuses when the remote state is unknown', () => {
        const verdict = guardReplay(entry, null, false);
        expect(verdict.allowed).toBe(false);
    });

    it('refuses when the remote response omits updatedAt (unknown state, not "untouched")', () => {
        const verdict = guardReplay(entry, { status: 'pending' }, false);
        expect(verdict.allowed).toBe(false);
    });

    it('allows anything with force', () => {
        expect(guardReplay(entry, { status: 'succeeded', updatedAt: '2026-08-24T11:00:00.000Z' }, true).allowed).toBe(true);
        expect(guardReplay(entry, null, true).allowed).toBe(true);
    });
});

describe('replayStoredCallback', () => {
    const okResult: PostResult = { ok: true, status: 200 };

    it('never posts or deletes the file when the guard refuses', async () => {
        const fetchState = vi.fn().mockResolvedValue(null); // unknown remote state -> guard refuses
        const post = vi.fn();
        const remove = vi.fn();

        const outcome = await replayStoredCallback(entry, { force: false }, { fetchState, post, remove });

        expect(outcome.replayed).toBe(false);
        expect(post).not.toHaveBeenCalled();
        expect(remove).not.toHaveBeenCalled();
    });

    it('does not delete the file when delivery fails', async () => {
        const fetchState = vi.fn().mockResolvedValue({ status: 'pending', updatedAt: '2026-08-24T09:00:00.000Z' });
        const post = vi.fn().mockResolvedValue({ ok: false, status: 500 } satisfies PostResult);
        const remove = vi.fn();

        const outcome = await replayStoredCallback(entry, { force: false }, { fetchState, post, remove });

        expect(outcome.replayed).toBe(false);
        expect(post).toHaveBeenCalledTimes(1);
        expect(remove).not.toHaveBeenCalled();
    });

    it('deletes the file only after a successful post', async () => {
        const fetchState = vi.fn().mockResolvedValue({ status: 'pending', updatedAt: '2026-08-24T09:00:00.000Z' });
        const post = vi.fn().mockResolvedValue(okResult);
        const remove = vi.fn().mockResolvedValue(true);

        const outcome = await replayStoredCallback(entry, { force: false }, { fetchState, post, remove });

        expect(outcome.replayed).toBe(true);
        expect(post).toHaveBeenCalledWith(entry.callbackUrl, entry.payload);
        expect(remove).toHaveBeenCalledWith(entry.filePath);
        expect(remove).toHaveBeenCalledTimes(1);
        expect(post).toHaveBeenCalledTimes(1);
    });

    it('does not call remove when the entry carries no file path', async () => {
        const { filePath, ...entryWithoutPath } = entry;
        const fetchState = vi.fn().mockResolvedValue({ status: 'pending', updatedAt: '2026-08-24T09:00:00.000Z' });
        const post = vi.fn().mockResolvedValue(okResult);
        const remove = vi.fn();

        const outcome = await replayStoredCallback(entryWithoutPath as StoredCallback, { force: false }, { fetchState, post, remove });

        expect(outcome.replayed).toBe(true);
        expect(remove).not.toHaveBeenCalled();
    });
});
