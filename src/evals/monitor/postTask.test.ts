import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureSinks, emitCall, runWithTelemetry } from '../../lib/telemetry/telemetry.js';
import { openArchive } from '../../lib/archive/store.js';
import { loadModes } from '../registry/registry.js';
import { recordChecks, settleMonitoring, startMonitoring } from './postTask.js';
import type { CallRecord } from '../../lib/llm/callRecord.js';

describe('post-task monitoring', () => {
    const env = { ...process.env };
    let stop: () => void = () => {};
    beforeEach(() => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-'));
        process.env.ARCHIVE_URL = `file://${dir}/archive`;
        process.env.DATA_DIR = `${dir}/data`;
        process.env.TELEMETRY_SINKS = 'archive';
        delete process.env.POSTHOG_PROJECT_TOKEN;
        delete process.env.LANGFUSE_PUBLIC_KEY;
        configureSinks([]);
    });
    afterEach(() => { stop(); configureSinks(null); process.env = { ...env }; });
    const call: CallRecord = {
        v: 1, callId: 'c1', label: 'subject-context-search:Θέμα', cacheKey: 'f'.repeat(64), startedAt: 't', finishedAt: 't',
        request: { model: 'm', max_tokens: 1, messages: [] },
        response: { servedModel: 'm', stopReason: 'end_turn', text: 'Δυστυχώς δεν βρέθηκαν πληροφορίες.', content: [], usage: {}, latencyMs: 1, batchMode: false },
    };

    it('checks a finished run off the task path and archives the results', async () => {
        stop = startMonitoring({ modes: loadModes().filter(m => m.slug === 'context_disclaimer_preamble') });
        const traceId = 'b'.repeat(32);
        const result = await runWithTelemetry({ traceId, taskType: 'summarize', taskVersion: 6, taskId: 't', env: 'production' }, async () => { emitCall(call); return { ok: true }; });
        expect(result).toEqual({ ok: true });
        await settleMonitoring();

        const store = openArchive();
        const keys: string[] = [];
        for await (const k of store.list('production/checks/')) keys.push(k);
        expect(keys).toHaveLength(1);
        const lines = (await store.get(keys[0]))!.toString().trim().split('\n').map(l => JSON.parse(l));
        expect(lines).toEqual([expect.objectContaining({ traceId, slug: 'context_disclaimer_preamble', callId: 'c1', result: 'fail' })]);
    }, 30_000);

    it('writes nothing to local disk without ARCHIVE_URL', async () => {
        delete process.env.ARCHIVE_URL;
        stop = startMonitoring({ modes: loadModes().filter(m => m.slug === 'context_disclaimer_preamble') });
        await runWithTelemetry({ taskType: 'summarize', taskVersion: 6, taskId: 't', env: 'production' }, async () => { emitCall(call); return {}; });
        await settleMonitoring();
        expect(fs.existsSync(process.env.DATA_DIR!) ? fs.readdirSync(process.env.DATA_DIR!, { recursive: true }) : []).toEqual([]);
    });

    it('leaves eval runs to the runner', async () => {
        stop = startMonitoring({ modes: loadModes().filter(m => m.slug === 'context_disclaimer_preamble') });
        await runWithTelemetry({ taskType: 'summarize', taskVersion: 6, taskId: 't', env: 'eval' }, async () => 1);
        await settleMonitoring();
        const keys: string[] = [];
        for await (const k of openArchive().list('eval/checks/')) keys.push(k);
        expect(keys).toEqual([]);
    });

    it('sends verdicts to a platform only when TELEMETRY_SINKS names it', async () => {
        process.env.POSTHOG_PROJECT_TOKEN = 'phc_test';
        process.env.LANGFUSE_PUBLIC_KEY = 'pk';
        process.env.LANGFUSE_SECRET_KEY = 'sk';
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in tests'));
        try {
            const run = { traceId: 'c'.repeat(32), taskType: 'summarize', taskVersion: 6, taskId: 't', env: 'production' as const, startedAt: '2026-10-10T00:00:00Z' };
            await recordChecks({ run, calls: [] }, [{ traceId: run.traceId, modeId: 'FM-0001', slug: 'context_disclaimer_preamble', scope: 'call', result: 'fail', at: run.startedAt }], openArchive());
            expect(fetchSpy).not.toHaveBeenCalled();
            const keys: string[] = [];
            for await (const k of openArchive().list('production/checks/')) keys.push(k);
            expect(keys).toHaveLength(1);
        } finally {
            fetchSpy.mockRestore();
        }
    });
});
