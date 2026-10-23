import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configureSinks, emitCall } from '../../lib/telemetry/telemetry.js';
import { archiveKeys, fsStore } from '../../lib/archive/store.js';
import { encodeRunFile } from '../../lib/telemetry/archiveSink.js';
import { BudgetExceededError, getCallPolicy } from '../../lib/llm/callPolicy.js';
import type { CallRecord } from '../../lib/llm/callRecord.js';
import type { Suite } from '../suites/suite.js';
import type { Case, Variant } from '../types.js';
import { loadRun, outputTruncated, runSuite, servedModelMismatch } from './runner.js';

const record = (served: string, label = 'decision-reading', costTokens = 1000): CallRecord => ({
    v: 1, callId: Math.random().toString(36).slice(2), label, cacheKey: 'k'.repeat(64), startedAt: 't', finishedAt: 't',
    request: { model: served, max_tokens: 10, messages: [] },
    response: { servedModel: served, stopReason: 'end_turn', text: '', content: [], usage: { input_tokens: costTokens, output_tokens: 0 }, latencyMs: 1, batchMode: false },
});
const cases: Case[] = ['a', 'b', 'c'].map(id => ({
    id: `demo/${id}`, suite: 'demo', split: id === 'c' ? 'holdout' : 'dev', input: { id }, cluster: 'x', tags: [],
    expect: { answer: { value: 'yes', tier: 'adjudicated', by: 't', at: 't', source: 't' } },
}));
const variant: Variant = { name: 'v', overrides: { 'decision-reading': { model: 'claude-haiku-5-5' } } };

function fakeSuite(behave: (c: Case) => { answer: string; served?: string; throws?: Error }): Suite<{ id: string }, { answer: string }> {
    return {
        id: 'demo', task: 'pollDecisions', labels: ['decision-reading'],
        run: async c => {
            const b = behave(c);
            const budget = getCallPolicy().budget;
            if (budget && budget.spentUsd >= budget.limitUsd) throw new BudgetExceededError(budget.limitUsd, budget.spentUsd);
            if (b.throws) throw b.throws;
            emitCall(record(b.served ?? 'claude-haiku-5-5'));
            if (budget) budget.spentUsd += 0.01;
            return { answer: b.answer };
        },
        score: (o, c) => ({ answer: o.answer === c.expect.answer.value ? 'agree' : 'disagree' }),
    };
}

describe('runSuite', () => {
    let out: string;
    beforeEach(() => { out = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-')); configureSinks([]); });
    afterEach(() => configureSinks(null));

    it('runs every case × repeat, scores it, and writes the run files', async () => {
        const r = await runSuite({ suite: 'demo', variant, split: 'all', reps: 2, concurrency: 2, budgetUsd: 1, cases, suiteImpl: fakeSuite(c => ({ answer: c.id === 'demo/b' ? 'no' : 'yes' })), outDir: out, archive: null });
        expect(r.rows).toHaveLength(6);
        expect(r.manifest).toMatchObject({ status: 'complete', reps: 2, cases: 3 });
        expect(r.rows.filter(x => x.fields.answer === 'disagree').map(x => x.caseId)).toEqual(['demo/b', 'demo/b']);
        const loaded = await loadRun('demo', r.runId, out, null);
        expect(loaded.rows).toHaveLength(6);
    });

    it('resumes a run without redoing finished rows', async () => {
        const calls: string[] = [];
        const suite = fakeSuite(c => { calls.push(c.id); return { answer: 'yes' }; });
        const first = await runSuite({ suite: 'demo', variant, split: 'dev', reps: 1, concurrency: 1, budgetUsd: 0.005, cases, suiteImpl: suite, outDir: out, archive: null });
        expect(first.rows).toHaveLength(1);
        const again = await runSuite({ suite: 'demo', variant, split: 'dev', reps: 1, concurrency: 1, budgetUsd: 1, cases, suiteImpl: suite, outDir: out, archive: null, runId: first.runId });
        // demo/b's first attempt hit the spend ceiling; demo/a is not run again.
        expect(calls).toEqual(['demo/a', 'demo/b', 'demo/b']);
        expect(again.rows).toHaveLength(2);
    });

    it('refuses to resume a run with different settings, and leaves its manifest alone', async () => {
        const suite = fakeSuite(() => ({ answer: 'yes' }));
        const base = { suite: 'demo', variant, split: 'dev' as const, reps: 1, concurrency: 1, budgetUsd: 0.005, cases, suiteImpl: suite, outDir: out, archive: null };
        const first = await runSuite(base);
        const resume = (over: Partial<Parameters<typeof runSuite>[0]>) => runSuite({ ...base, budgetUsd: 1, runId: first.runId, ...over });
        await expect(resume({ variant: { ...variant, overrides: { 'decision-reading': { model: 'claude-opus-5-5' } } } })).rejects.toThrow(/variant/);
        await expect(resume({ reps: 2 })).rejects.toThrow(/reps \(was 1, now 2\)/);
        await expect(resume({ split: 'all' })).rejects.toThrow(/split.*caseSetSha/);
        await expect(resume({ replay: true, live: [] })).rejects.toThrow(/replay/);
        expect((await loadRun('demo', first.runId, out, null)).manifest).toEqual(first.manifest);
        // Key order is not a setting.
        const reordered: Variant = { overrides: variant.overrides, name: variant.name };
        expect((await resume({ variant: reordered })).rows).toHaveLength(2);
    });

    it('drops the old error of an attempt a resume retried', async () => {
        let fail = true;
        const suite = fakeSuite(() => (fail ? { answer: 'yes', throws: new Error('boom') } : { answer: 'yes' }));
        const first = await runSuite({ suite: 'demo', variant, split: 'dev', reps: 1, concurrency: 1, budgetUsd: 1, cases, suiteImpl: suite, outDir: out, archive: null });
        expect(first.errors).toHaveLength(2);
        fail = false;
        const again = await runSuite({ suite: 'demo', variant, split: 'dev', reps: 1, concurrency: 1, budgetUsd: 1, cases, suiteImpl: suite, outDir: out, archive: null, runId: first.runId });
        expect([again.rows.length, again.errors.length]).toEqual([2, 0]);
        expect((await loadRun('demo', first.runId, out, null)).errors).toEqual([]);
    });

    it('stops at the spend ceiling and marks the run incomplete', async () => {
        const r = await runSuite({ suite: 'demo', variant, split: 'all', reps: 3, concurrency: 1, budgetUsd: 0.025, cases, suiteImpl: fakeSuite(() => ({ answer: 'yes' })), outDir: out, archive: null });
        expect(r.manifest.status).toBe('incomplete');
        expect(r.manifest.incompleteReason).toMatch(/Spend ceiling/);
        expect(r.rows).toHaveLength(3);
    });

    it('stops at the ceiling when a task swallowed the per-item BudgetExceededError', async () => {
        const suite: Suite<{ id: string }, { answer: string }> = {
            ...fakeSuite(() => ({ answer: 'yes' })),
            run: async () => {
                const budget = getCallPolicy().budget!;
                if (budget.spentUsd >= budget.limitUsd) {
                    emitCall({ ...record('claude-haiku-5-5'), response: undefined, error: { class: 'BudgetExceededError', message: 'Spend ceiling reached' } });
                } else {
                    emitCall(record('claude-haiku-5-5'));
                    budget.spentUsd += 0.01;
                }
                return { answer: 'yes' };
            },
        };
        const r = await runSuite({ suite: 'demo', variant, split: 'all', reps: 2, concurrency: 1, budgetUsd: 0.015, cases, suiteImpl: suite, outDir: out, archive: null });
        expect(r.manifest.status).toBe('incomplete');
        expect(r.manifest.incompleteReason).toMatch(/Spend ceiling/);
        expect(r.errors).toEqual([]);
        expect(r.rows).toHaveLength(2);
    });

    it('resumes against what the run already spent', async () => {
        const suite = fakeSuite(() => ({ answer: 'yes' }));
        const first = await runSuite({ suite: 'demo', variant, split: 'all', reps: 2, concurrency: 1, budgetUsd: 0.025, cases, suiteImpl: suite, outDir: out, archive: null });
        expect(first.manifest.spentUsd).toBeCloseTo(0.03);
        const again = await runSuite({ suite: 'demo', variant, split: 'all', reps: 2, concurrency: 1, budgetUsd: 0.045, cases, suiteImpl: suite, outDir: out, archive: null, runId: first.runId });
        expect(again.manifest.status).toBe('incomplete');
        expect(again.rows).toHaveLength(5);
        expect(again.manifest.spentUsd).toBeCloseTo(0.05);
    });

    it('marks a row whose structured output hit max_tokens truncated', async () => {
        const truncated = (): CallRecord => {
            const r = record('claude-haiku-5-5');
            return { ...r, request: { ...r.request, output_config: { format: { type: 'json_schema' } } }, response: { ...r.response!, stopReason: 'max_tokens' } };
        };
        const suite: Suite<{ id: string }, { answer: string }> = {
            ...fakeSuite(() => ({ answer: 'yes' })),
            run: async c => { emitCall(c.id === 'demo/a' ? truncated() : record('claude-haiku-5-5')); return { answer: 'yes' }; },
        };
        const r = await runSuite({ suite: 'demo', variant, split: 'all', reps: 1, concurrency: 1, budgetUsd: 1, cases, suiteImpl: suite, outDir: out, archive: null });
        expect(Object.fromEntries(r.rows.map(x => [x.caseId, x.status]))).toEqual({ 'demo/a': 'truncated', 'demo/b': 'ok', 'demo/c': 'ok' });
    });

    it('charges an attempt that failed after paid calls, and keeps its trace', async () => {
        const r = await runSuite({ suite: 'demo', variant, split: 'all', reps: 1, concurrency: 1, budgetUsd: 1, cases: cases.slice(0, 1), outDir: out, archive: null,
            suiteImpl: { ...fakeSuite(() => ({ answer: 'yes' })), run: async () => { emitCall(record('claude-haiku-5-5')); throw new Error('boom'); } } });
        expect(r.errors).toHaveLength(1);
        expect(r.errors[0].costUsd).toBeGreaterThan(0);
        expect(r.errors[0].traceId).toMatch(/^[0-9a-f]{32}$/);
    });

    it('records failures and substituted models as errors, never as wrong answers', async () => {
        const r = await runSuite({ suite: 'demo', variant, split: 'all', reps: 1, concurrency: 1, budgetUsd: 1, cases, outDir: out, archive: null,
            suiteImpl: fakeSuite(c => c.id === 'demo/a' ? { answer: 'yes', throws: new Error('boom') } : c.id === 'demo/b' ? { answer: 'yes', served: 'claude-sonnet-5-5' } : { answer: 'yes' }) });
        expect(r.rows.map(x => x.caseId)).toEqual(['demo/c']);
        expect(r.errors.map(e => e.errorClass).sort()).toEqual(['Error', 'served-model-mismatch']);
    });
});

describe('runSuite on a phase suite (cases are recorded runs)', () => {
    let out: string;
    beforeEach(() => { out = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-phase-')); configureSinks([]); });
    afterEach(() => { configureSinks(null); fs.rmSync(out, { recursive: true, force: true }); });

    it('replays the recording with only the suite\'s labels live, and fails a run that swallowed a replay miss', async () => {
        const store = fsStore(path.join(out, 'archive'));
        const trace = 'b'.repeat(32);
        const run = { traceId: trace, taskType: 'summarize', taskVersion: 6, taskId: 'x', env: 'development' as const, input: { date: '2026-10-05' }, startedAt: '2026-10-10T10:00:00.000Z' };
        const key = archiveKeys.calls('development', new Date(run.startedAt), 'summarize', trace);
        await store.put(key, encodeRunFile({ run, phases: [], calls: [record('claude-opus-4-6', 'batch-processing:1/1')] }, { status: 'success', endedAt: run.startedAt }));
        await store.put(archiveKeys.traceIndex(trace), key);
        const phaseCases: Case[] = ['ok', 'miss'].map(id => ({ id: `phase/${id}`, suite: 'phase', split: 'dev', input: { meeting: 'x/y' }, replay: trace, expect: {}, cluster: 'x', tags: [] }));
        const seen: unknown[] = [];
        const suite: Suite<{ meeting: string }, { ok: boolean }> = {
            id: 'phase', task: 'summarize', labels: ['contributions:*'], replay: { live: ['contributions:*'] },
            request: (_c, recorded) => recorded!.run.input,
            run: async (c, ctx) => {
                const p = getCallPolicy();
                seen.push({ mode: p.mode, live: p.live, cassette: Boolean(p.cassette), cacheRead: p.cacheRead, request: ctx.request });
                if (c.id === 'phase/miss') emitCall({ ...record('claude-opus-4-6', 'contributions:x'), response: undefined, error: { class: 'ReplayMissError', message: 'No recorded response' } });
                return { ok: true };
            },
            score: () => ({}),
        };
        const r = await runSuite({ suite: 'phase', variant: { ...variant, overrides: {} }, split: 'all', reps: 1, concurrency: 1, budgetUsd: 1, cases: phaseCases, suiteImpl: suite, outDir: out, archive: store });
        expect(seen[0]).toEqual({ mode: 'replay', live: ['contributions:*'], cassette: true, cacheRead: false, request: { date: '2026-10-05' } });
        expect(r.manifest.replay).toEqual({ live: ['contributions:*'] });
        expect(r.rows.map(x => x.caseId)).toEqual(['phase/ok']);
        expect(r.errors.map(e => e.errorClass)).toEqual(['PolicyErrorsInRunError']);

        seen.length = 0;
        const all = await runSuite({ suite: 'phase', variant: { ...variant, overrides: {} }, split: 'all', reps: 1, concurrency: 1, budgetUsd: 1, cases: phaseCases.slice(0, 1), suiteImpl: suite, outDir: out, archive: store, live: [] });
        expect(seen[0]).toMatchObject({ mode: 'replay', live: [] });
        expect(all.manifest.replay).toEqual({ live: [] });
    });
});

describe('servedModelMismatch', () => {
    it('accepts a dated snapshot of the requested alias', () => {
        expect(servedModelMismatch([record('claude-haiku-4-5-20251001')], { ...variant, overrides: { 'decision-reading': { model: 'claude-haiku-4-5' } } })).toBeNull();
        expect(servedModelMismatch([record('claude-opus-5-5')], variant)).toMatch(/asked for claude-haiku-5-5/);
    });
});

describe('outputTruncated', () => {
    const hit = (structured: boolean): CallRecord => {
        const r = record('claude-haiku-5-5');
        return { ...r, request: { ...r.request, ...(structured && { output_config: { format: { type: 'json_schema' } } }) }, response: { ...r.response!, stopReason: 'max_tokens' } };
    };
    it('ignores a plain-text response that aiChat continued, not a structured one it could not', () => {
        expect(outputTruncated([hit(false), record('claude-haiku-5-5', 'decision-reading:continuation')])).toBe(false);
        expect(outputTruncated([hit(true)])).toBe(true);
    });
});

describe('runSuite on a suite that records what it has not recorded yet', () => {
    let out: string;
    beforeEach(() => { out = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-')); configureSinks([]); });
    afterEach(() => configureSinks(null));

    it('lets an unrecorded call go live only while the suite\'s own live set is used', async () => {
        const seen: unknown[] = [];
        const suite: Suite<{ id: string }, { answer: string }> = {
            ...fakeSuite(() => ({ answer: 'yes' })),
            replay: { live: ['decision-resolver'], onMiss: 'live' },
            run: async () => { seen.push(getCallPolicy().onMiss); return { answer: 'yes' }; },
        };
        const run = (live?: string[]) => runSuite({ suite: 'demo', variant, split: 'all', reps: 1, concurrency: 1, budgetUsd: 1, cases: cases.slice(0, 1), suiteImpl: suite, outDir: out, archive: null, live });
        const own = await run();
        expect(own.manifest.replay).toEqual({ live: ['decision-resolver'], onMiss: 'live' });
        const strict = await run([]);
        expect(strict.manifest.replay).toEqual({ live: [] });
        expect(seen).toEqual(['live', undefined]);
    });
});
