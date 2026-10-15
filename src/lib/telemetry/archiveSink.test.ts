import fs from 'fs';
import os from 'os';
import path from 'path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fsStore } from '../archive/store.js';
import { createArchiveSink, type ArchivedLine } from './archiveSink.js';
import { configureSinks, emitCall, runWithTelemetry, withPhase } from './telemetry.js';
import type { CallBlob, CallRecord } from '../llm/callRecord.js';

const call = (label: string): CallRecord => ({
    v: 1, callId: label, label, cacheKey: label.padEnd(64, '0'), startedAt: '2026-10-11T00:00:00Z', finishedAt: '2026-10-11T00:00:01Z',
    request: { model: 'claude-haiku-5-5', max_tokens: 10, system: { hash: 'aa'.repeat(32) }, messages: [] },
    response: { servedModel: 'claude-haiku-5-5', stopReason: 'end_turn', text: 'ok', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 }, latencyMs: 5, batchMode: false },
});
const pdf: CallBlob = { sha256: 'bb'.repeat(32), data: Buffer.from('%PDF'), mediaType: 'application/pdf' };

describe('archive sink', () => {
    let dir: string; const prevData = process.env.DATA_DIR;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archsink-'));
        process.env.DATA_DIR = path.join(dir, 'data');
    });
    afterEach(() => { configureSinks(null); vi.restoreAllMocks(); if (prevData === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prevData; });

    it('writes the run file, the trace index and each blob once', async () => {
        const store = fsStore(path.join(dir, 'archive'));
        const put = vi.spyOn(store, 'put');
        configureSinks([createArchiveSink(store)]);
        const traceId = 'c'.repeat(32);
        const result = await runWithTelemetry({ traceId, taskType: 'pollDecisions', taskVersion: 4, taskId: 't1', env: 'eval', input: { meetingDate: '2026-10-01' } }, async () => {
            await withPhase('Phase 0', async () => { emitCall(call('read-1'), { blobs: [pdf] }); });
            emitCall(call('read-2'), { blobs: [pdf] });
            return { linked: 2 };
        });
        expect(result).toEqual({ linked: 2 });

        const indexKey = `traces/${traceId}`;
        const callsKey = (await store.get(indexKey))!.toString();
        expect(callsKey).toMatch(new RegExp(`^eval/calls/\\d{4}/\\d{2}/\\d{2}/pollDecisions/${traceId}\\.jsonl\\.gz$`));
        const lines = gunzipSync((await store.get(callsKey))!).toString().trim().split('\n').map(l => JSON.parse(l) as ArchivedLine);
        expect(lines.map(l => l.type)).toEqual(['run', 'call', 'call', 'result']);
        expect(lines[0]).toMatchObject({ type: 'run', run: { traceId, taskType: 'pollDecisions', input: { meetingDate: '2026-10-01' } }, outcome: { status: 'success' } });
        expect(lines[1]).toMatchObject({ type: 'call', label: 'read-1', phase: 'Phase 0', traceId });
        expect(lines[3]).toEqual({ type: 'result', result: { linked: 2 } });
        expect(await store.exists(`blobs/sha256/bb/${'bb'.repeat(32)}`)).toBe(true);
        expect(put.mock.calls.filter(([k]) => k.startsWith('blobs/')).length).toBe(1);
    });

    it('spools a failed write and resends it on the next flush', async () => {
        const store = fsStore(path.join(dir, 'archive'));
        const realPut = store.put.bind(store);
        let fail = true;
        vi.spyOn(store, 'put').mockImplementation((k, b, c) => fail ? Promise.reject(new Error('down')) : realPut(k, b, c));
        const sink = createArchiveSink(store);
        configureSinks([sink]);
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const traceId = 'd'.repeat(32);
        await runWithTelemetry({ traceId, taskType: 'demo', taskVersion: null, taskId: 't', env: 'eval' }, async () => { emitCall(call('x')); });
        expect(await store.exists(`traces/${traceId}`)).toBe(false);
        fail = false;
        await sink.flush!();
        expect(await store.exists(`traces/${traceId}`)).toBe(true);
    });

    it('drops a write the spool cannot take either, with a log line and no unhandled rejection', async () => {
        // A data dir that is a file: the spool cannot create its directory.
        fs.writeFileSync(path.join(dir, 'data'), 'not a dir');
        const store = fsStore(path.join(dir, 'archive'));
        vi.spyOn(store, 'put').mockRejectedValue(new Error('down'));
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        const unhandled = vi.fn();
        process.on('unhandledRejection', unhandled);
        try {
            configureSinks([createArchiveSink(store)]);
            await expect(runWithTelemetry({ taskType: 'demo', taskVersion: null, taskId: 't', env: 'eval' }, async () => { emitCall(call('x')); return 7; })).resolves.toBe(7);
            await new Promise(r => setTimeout(r, 20));
            expect(unhandled).not.toHaveBeenCalled();
            expect(errors.mock.calls.some(c => String(c[0]).includes('dropping it'))).toBe(true);
        } finally {
            process.off('unhandledRejection', unhandled);
        }
    });
});
