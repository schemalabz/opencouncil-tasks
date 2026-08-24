import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { taskManager } from './TaskManager.js';

// serveTask is the funnel every task endpoint goes through, so the callback
// URL check belongs to it rather than to any one route.
const buildRequest = (body: unknown) =>
    ({ path: '/someTask', body } as express.Request<{}, {}, any>);

const buildResponse = () => {
    const res = { statusCode: 0, body: undefined as unknown } as any;
    res.status = (code: number) => { res.statusCode = code; return res; };
    res.json = (payload: unknown) => { res.body = payload; return res; };
    return res;
};

describe('serveTask callback URL validation', () => {
    const neverRuns = vi.fn(async () => ({}));
    const handler = taskManager.serveTask(neverRuns as any);

    it.each([
        ['missing', {}],
        ['empty', { callbackUrl: '' }],
        ['not a URL', { callbackUrl: 'not-a-url' }],
        ['wrong scheme', { callbackUrl: 'ftp://example.com/cb' }],
    ])('rejects a %s callback URL without starting the task', (_label, body) => {
        const res = buildResponse();

        handler(buildRequest(body), res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ error: 'Invalid callback URL' });
        expect(neverRuns).not.toHaveBeenCalled();
    });

    it('accepts a callback URL carrying an authentication token', () => {
        const runTask = vi.spyOn(taskManager, 'runTaskWithCallback').mockResolvedValue(undefined);
        const res = buildResponse();
        const callbackUrl = 'https://opencouncil.gr/api/cities/athens/meetings/m1/taskStatuses/t1?token=abc123';

        handler(buildRequest({ callbackUrl }), res);

        expect(res.statusCode).toBe(202);
        expect(runTask).toHaveBeenCalledWith(expect.anything(), { callbackUrl }, callbackUrl, 'someTask', undefined);
        runTask.mockRestore();
    });
});
