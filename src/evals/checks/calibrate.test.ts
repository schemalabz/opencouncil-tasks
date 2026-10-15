import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fsStore, type ArchiveStore } from '../../lib/archive/store.js';
import { saveBatch, type ReviewBatch } from '../review/batch.js';
import { archiveKeys } from '../../lib/archive/store.js';
import type { DetectorCase, FailureMode } from '../registry/schema.js';
import { calibrate, formatCalibration } from './calibrate.js';
import { callCheck, fail, pass } from './check.js';

const mode = (over: Partial<FailureMode> = {}): FailureMode => ({
    id: 'FM-9990', slug: 'says_sorry', title: 't', definition: 'd', suite: 'summarize.context', scope: 'call', severity: 'minor', impact: 'visible',
    status: 'candidate', detector: { kind: 'code', module: 'unused.ts' }, ...over,
});
const check = callCheck('says_sorry', ['ctx:*'], c => (c.response.text.startsWith('Sorry') ? fail('sorry') : pass()));
const call = (text: string, ids: { traceId?: string; callId?: string } = {}) => ({
    ...ids, label: 'ctx:x', request: { model: 'm', max_tokens: 1, messages: [] }, response: { text, stopReason: 'end_turn' },
});
const dc = (kind: DetectorCase['kind'], text: string, ids?: { traceId?: string; callId?: string }): DetectorCase => ({ kind, input: call(text, ids), file: `/x/${kind}.json` });

describe('calibrate', () => {
    let dir: string;
    let store: ArchiveStore;
    const env = { ...process.env };
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calibrate-'));
        store = fsStore(path.join(dir, 'archive'));
        process.env.ARCHIVE_URL = `file://${dir}/archive`;
        process.env.DATA_DIR = `${dir}/data`;
    });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); process.env = { ...env }; });

    it('counts known misses as occurrences and known false alarms as non-occurrences', async () => {
        const c = await calibrate(mode(), {
            check,
            cases: [dc('must-fire', 'Sorry, none'), dc('known-miss', 'Unfortunately none'), dc('must-not-fire', 'Context.'), dc('known-false-alarm', 'Sorry-sounding but fine')],
        });
        expect(c.total).toEqual({ tp: 1, fn: 1, tn: 1, fp: 1, unknown: 0 });
        expect([c.tpr, c.tnr]).toEqual([0.5, 0.5]);
        expect(c.disagreements.map(d => d.ref)).toEqual(['known-miss.json', 'known-false-alarm.json']);
        expect(formatCalibration(c)).toContain('TPR 50.0% (1/2)   TNR 50.0% (1/2)');
    });

    it("adds people's mode-examples answers, skipping can't-tell and calls already kept as detector cases", async () => {
        const batch: ReviewBatch = {
            id: 'rv-1', kind: 'mode-examples', suite: 'summarize.context', modeId: 'FM-9990', createdBy: 'agent', createdAt: '2026-10-10T00:00:00Z', status: 'submitted', history: [],
            items: [
                { id: 'i1', evidence: { call: call('Sorry, nothing', { traceId: 't', callId: 'c1' }) as never } },
                { id: 'i2', evidence: { call: call('Sorry about the format', { traceId: 't', callId: 'c2' }) as never } },
                { id: 'i3', evidence: { call: call('Sorry', { traceId: 't', callId: 'c3' }) as never } },
                { id: 'i4', evidence: { call: call('Sorry again', { traceId: 't', callId: 'dup' }) as never } },
            ],
        };
        await saveBatch(store, batch);
        await saveBatch(store, { ...batch, id: 'rv-other', modeId: 'FM-0001' });
        await store.put(archiveKeys.review('rv-1', 'results.json'), JSON.stringify({ batchId: 'rv-1', reviewer: 'p', submittedAt: '2026-10-10', results: [
            { itemId: 'i1', decision: 'confirm' }, { itemId: 'i2', decision: 'reject' }, { itemId: 'i3', decision: 'cant-tell' }, { itemId: 'i4', decision: 'confirm' },
        ] }));
        const c = await calibrate(mode(), { check, store, cases: [dc('must-fire', 'Sorry', { traceId: 't', callId: 'dup' })] });
        expect(c.sources[1]).toEqual({ source: 'mode-examples reviews', confusion: { tp: 1, fn: 0, tn: 0, fp: 1, unknown: 0 }, note: "1 batch(es); 1 already detector cases, 1 can't tell" });
        expect(c.total).toMatchObject({ tp: 2, fp: 1 });
        expect(c.notes.some(n => n.startsWith('pairwise: 0 preference file(s)'))).toBe(true);
    });

    it('reads a judge only from recordings: no recording is "no recorded judge outputs", never a model call', async () => {
        const prompt = path.join(dir, 'judge.md');
        fs.writeFileSync(prompt, 'Judge it.');
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network used'));
        try {
            const judge = mode({ detector: { kind: 'judge', prompt, model: 'claude-haiku-4-5', sample: 0.01 } });
            const c = await calibrate(judge, { cases: [dc('must-fire', 'Sorry'), dc('must-not-fire', 'Fine')] });
            expect(c.total).toEqual({ tp: 0, fn: 0, tn: 0, fp: 0, unknown: 2 });
            expect(c.tpr).toBeNull();
            expect(c.notes[0]).toMatch(/^no recorded judge outputs/);
            expect(fetchSpy).not.toHaveBeenCalled();
        } finally {
            fetchSpy.mockRestore();
        }
    });
});
