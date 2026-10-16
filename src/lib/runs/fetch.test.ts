import fs from 'fs';
import os from 'os';
import path from 'path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fsStore, type ArchiveStore } from '../archive/store.js';
import { fetchRun, listRuns } from './fetch.js';
import { archiveRun, makeCall } from './fixtures.js';

const summarizeResult = { speakerSegmentSummaries: [], subjects: [], utteranceDiscussionStatuses: [] };
const NOW = '2026-10-11T12:00:00Z';

describe('runs from the archive', () => {
    let dir: string; let store: ArchiveStore;
    const ids: Record<string, string> = {};
    const prevData = process.env.DATA_DIR;

    beforeAll(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-fetch-'));
        process.env.DATA_DIR = path.join(dir, 'data');
        store = fsStore(path.join(dir, 'archive'));
        vi.useFakeTimers({ toFake: ['Date'] });
        const at = async (iso: string, name: string, run: Parameters<typeof archiveRun>[1], body: Parameters<typeof archiveRun>[2]) => {
            vi.setSystemTime(new Date(iso));
            ids[name] = await archiveRun(store, run, body);
        };
        await at('2026-10-10T09:00:00Z', 'A', { taskType: 'summarize', taskVersion: 3, meeting: 'chania/m1', env: 'production' },
            { phases: { 'Phase 1': [makeCall('a1'), makeCall('a2', { cacheHit: true })] }, result: summarizeResult });
        await at('2026-10-11T08:00:00Z', 'B', { taskType: 'summarize', taskVersion: 3, meeting: 'chania/m1', env: 'staging' },
            { phases: { 'Phase 1': [makeCall('b1'), makeCall('b2', { batchMode: true })] }, result: summarizeResult });
        await at('2026-10-09T10:00:00Z', 'C', { taskType: 'pollDecisions', taskVersion: null, meeting: 'athens/m2', env: 'production' },
            { calls: [makeCall('c1', { systemHash: 'cc'.repeat(32) })], result: { linked: 2 } });
        await at('2026-08-01T10:00:00Z', 'D', { taskType: 'summarize', taskVersion: 2, meeting: 'chania/m1', env: 'production' },
            { result: summarizeResult });
        await at('2026-10-08T10:00:00Z', 'E', { taskType: 'summarize', taskVersion: 3, meeting: 'athens/m2', env: 'production' },
            { calls: [makeCall('e1')], error: 'boom' });
        // Calls made outside any run share the calls tree but are not runs.
        await store.put('production/calls/2026/10/11/adhoc/adhoc-x.jsonl.gz', gzipSync(`${JSON.stringify({ type: 'call', ...makeCall('adhoc') })}\n`));
        vi.setSystemTime(new Date(NOW));
    });
    afterAll(() => {
        vi.useRealTimers();
        if (prevData === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prevData;
    });

    const traceIds = (runs: { traceId: string }[]) => runs.map(r => Object.keys(ids).find(k => ids[k] === r.traceId));

    it('lists runs from the last 30 days across environments, newest first', async () => {
        expect(traceIds(await listRuns({}, store))).toEqual(['B', 'A', 'C', 'E']);
    });

    it('filters by task, meeting, environment, age and limit', async () => {
        expect(traceIds(await listRuns({ task: 'summarize' }, store))).toEqual(['B', 'A', 'E']);
        expect(traceIds(await listRuns({ meeting: 'chania/m1' }, store))).toEqual(['B', 'A']);
        expect(traceIds(await listRuns({ meeting: 'chania/m1', sinceDays: 100 }, store))).toEqual(['B', 'A', 'D']);
        expect(traceIds(await listRuns({ env: 'production' }, store))).toEqual(['A', 'C', 'E']);
        expect(traceIds(await listRuns({ sinceDays: 1 }, store))).toEqual(['B', 'A']);
        expect(traceIds(await listRuns({ limit: 1 }, store))).toEqual(['B']);
    });

    it('describes each run from its archived record', async () => {
        const runs = await listRuns({}, store);
        const a = runs.find(r => r.traceId === ids.A)!;
        expect(a).toMatchObject({
            timestamp: '2026-10-10T09:00:00.000Z', name: 'summarize', meeting: 'chania/m1', version: '3', env: 'production',
            isError: false, isCancelled: false, latencySeconds: 0,
        });
        // The cache hit cost nothing; the batch call is half price.
        expect(a.totalCost).toBeCloseTo(0.15, 6);
        expect(runs.find(r => r.traceId === ids.B)!.totalCost).toBeCloseTo(0.225, 6);
        expect(runs.find(r => r.traceId === ids.C)!.version).toBeNull();
        expect(runs.find(r => r.traceId === ids.E)!.isError).toBe(true);
    });

    it('fingerprints the prompts a run used', async () => {
        const runs = await listRuns({}, store);
        const hash = (k: string) => runs.find(r => r.traceId === ids[k])!.promptsHash;
        expect(hash('A')).toMatch(/^[0-9a-f]{12}$/);
        expect(hash('A')).toBe(hash('B'));
        expect(hash('C')).not.toBe(hash('A'));
    });

    it('fetches a summarize run with its result', async () => {
        const run = await fetchRun(ids.B, store);
        expect(run.info).toMatchObject({ traceId: ids.B, meeting: 'chania/m1', env: 'staging' });
        expect(run.result).toEqual(summarizeResult);
    });

    it('refuses runs that cannot be compared', async () => {
        await expect(fetchRun(ids.C, store)).rejects.toThrow(/not a summarize result/);
        await expect(fetchRun(ids.E, store)).rejects.toThrow(/failed run: boom/);
        await expect(fetchRun('f'.repeat(32), store)).rejects.toThrow(/not found/);
    });

    it('fingerprints prompts independently of call order and repeats', async () => {
        const store = fsStore(path.join(dir, 'archive-hash'));
        const x = 'aa'.repeat(32); const y = 'bb'.repeat(32);
        await archiveRun(store, { taskType: 'demo', taskVersion: 1, env: 'eval' }, { calls: [makeCall('1', { systemHash: x }), makeCall('2', { systemHash: y })] });
        await archiveRun(store, { taskType: 'demo', taskVersion: 1, env: 'eval' }, { calls: [makeCall('1', { systemHash: y }), makeCall('2', { systemHash: x }), makeCall('3', { systemHash: y })] });
        const [first, second] = await listRuns({ env: 'eval' }, store);
        expect(first.promptsHash).toBe(second.promptsHash);
    });
});
