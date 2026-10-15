import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fsStore } from '../archive/store.js';
import { archiveRun, makeCall } from './fixtures.js';
import { formatUsage, showRun } from './show.js';

describe('formatUsage', () => {
    it('renders every counter the API reports, and only when present', () => {
        expect(formatUsage({
            input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 500, cache_creation_input_tokens: 0,
            server_tool_use: { web_search_requests: 3, web_fetch_requests: 1 }, output_tokens_details: { thinking_tokens: 400 },
        })).toBe('1,200 in, 80 out, 500 cache-read, 3 searches, 1 fetches, 400 thinking');
        expect(formatUsage({ input_tokens: 1200, output_tokens: 80 })).toBe('1,200 in, 80 out');
    });
});

describe('showRun', () => {
    const prevData = process.env.DATA_DIR;
    afterEach(() => { vi.restoreAllMocks(); if (prevData === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prevData; });

    it('prints the run header, its phases with their calls, and calls outside any phase', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-show-'));
        process.env.DATA_DIR = path.join(dir, 'data');
        const store = fsStore(path.join(dir, 'archive'));
        const traceId = await archiveRun(store, { taskType: 'summarize', taskVersion: 3, meeting: 'chania/m1', env: 'staging', input: { cityId: 'chania', transcript: [1, 2] } }, {
            phases: { 'Phase 1': [makeCall('extract'), makeCall('reread', { cacheHit: true, replayed: true }), makeCall('broken', { error: 'overloaded' })] },
            calls: [makeCall('loose', { batchMode: true })],
            result: { subjects: [{}, {}], speakerSegmentSummaries: [] },
        });

        const lines: string[] = [];
        vi.spyOn(console, 'log').mockImplementation((...args) => { lines.push(...args.join(' ').split('\n')); });
        await showRun(traceId, store);
        const out = lines.join('\n');

        expect(out).toContain(`summarize  ${traceId}`);
        expect(out).toMatch(/chania\/m1/);
        expect(out).toMatch(/version: 3/);
        expect(out).toMatch(/env: staging/);
        expect(out).toMatch(/status: success/);
        expect(out).toContain('$0.225');
        expect(out).toContain('"cityId":"chania"');
        expect(out).toContain('transcriptCount');
        expect(out).toContain('subjects[2], speakerSegmentSummaries[0]');

        const phaseAt = lines.findIndex(l => l.startsWith('▸ Phase 1'));
        expect(phaseAt).toBeGreaterThan(-1);
        expect(lines[phaseAt + 1]).toMatch(/^ {4}extract \| 3\.0s \| claude-haiku-4-5 \| \$0\.150$/);
        expect(lines[phaseAt + 2]).toBe('      100,000 in, 10,000 out');
        expect(out).toMatch(/ {4}reread \| .*\[replayed\]/);
        expect(out).toMatch(/ {4}broken \| .*⚠ APIError: overloaded/);
        expect(out).toMatch(/^loose \| .*\[batch\] \| \$0\.075$/m);
    });

    it('fails clearly for an unknown trace id', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-show-'));
        await expect(showRun('f'.repeat(32), fsStore(dir))).rejects.toThrow(/not found in the archive/);
    });
});
