import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CallRecord } from '../lib/llm/callRecord.js';

describe('runTask', () => {
    const env = { ...process.env };
    let dir: string;
    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskrunner-'));
        process.env.DATA_DIR = path.join(dir, 'data');
        process.env.ARCHIVE_URL = `file://${path.join(dir, 'archive')}`;
        process.env.TELEMETRY_SINKS = 'archive';
    });
    afterAll(() => { process.env = env; vi.resetModules(); });

    it('runs a registered task in one telemetry run and archives its calls under the returned trace id', async () => {
        const { runTask, liveCost } = await import('./taskRunner.js');
        const { emitCall, configureSinks } = await import('../lib/telemetry/telemetry.js');
        const { createArchiveSink, readArchivedRun } = await import('../lib/telemetry/archiveSink.js');
        const { fsStore } = await import('../lib/archive/store.js');
        const store = fsStore(path.join(dir, 'archive'));
        configureSinks([createArchiveSink(store)]);

        const record: CallRecord = {
            v: 1, callId: 'c1', label: 'demo', cacheKey: 'e'.repeat(64), startedAt: 't0', finishedAt: 't1',
            request: { model: 'claude-haiku-5-5', max_tokens: 10, messages: [] },
            response: { servedModel: 'claude-haiku-5-5', stopReason: 'end_turn', text: 'x', content: [], usage: { input_tokens: 50_000, output_tokens: 0 }, latencyMs: 1, batchMode: false },
        };
        const tasks = { devSlowTask: { task: async () => { emitCall(record); return { done: true }; }, metadata: { version: 7 } } };

        const out = await runTask('devSlowTask', { iterations: 1 }, { env: 'eval' }, tasks);
        expect(out.result).toEqual({ done: true });
        expect(out.calls).toHaveLength(1);
        expect(out.costUsd).toBeCloseTo(0.005, 6);
        expect(liveCost([{ ...record, response: { ...record.response!, cacheHit: true } }]).usd).toBe(0);

        const archived = await readArchivedRun(out.traceId, store);
        expect(archived?.run).toMatchObject({ taskType: 'devSlowTask', taskVersion: 7, env: 'eval', input: { iterations: 1 } });
        expect(archived?.calls.map(c => c.callId)).toEqual(['c1']);
        expect(archived?.result).toEqual({ done: true });
    });

    it('fails the run when a task swallowed a replay miss or budget error', async () => {
        const { runTask, PolicyErrorsInRunError } = await import('./taskRunner.js');
        const { emitCall } = await import('../lib/telemetry/telemetry.js');
        const failed = (callId: string, cls: string): CallRecord => ({
            v: 1, callId, label: 'decision-reading', cacheKey: 'f'.repeat(64), startedAt: 't0', finishedAt: 't1',
            request: { model: 'claude-haiku-5-5', max_tokens: 10, messages: [] },
            error: { class: cls, message: `${cls} happened` },
        });
        // Tasks that read documents one by one catch each failure and carry on.
        const tasks = { devSlowTask: { task: async () => {
            emitCall(failed('a', 'ReplayMissError')); emitCall(failed('b', 'ReplayMissError')); emitCall(failed('c', 'RateLimitError'));
            return { decisions: [] };
        }, metadata: {} } };
        const err = await runTask('devSlowTask', {}, { env: 'eval' }, tasks).catch(e => e);
        expect(err).toBeInstanceOf(PolicyErrorsInRunError);
        expect(err.message).toMatch(/2 of 3 calls failed .*ReplayMissError happened/);
        expect(err.traceId).toMatch(/^[0-9a-f]{32}$/);
    });
});
