import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archiveKeys, fsStore, type ArchiveStore } from '../../lib/archive/store.js';
import type { CheckRecord } from '../monitor/runChecks.js';
import type { FailureMode } from '../registry/schema.js';
import type { Case, ResultRow } from '../types.js';
import { listCandidates, writeCandidates } from './candidate.js';
import { decisionsReading } from '../suites/decisionsReading.js';
import { disagreementCandidates } from './sources/disagreement.js';
import { harvestMonitoring } from './sources/monitoring.js';
import { encodeRunFile } from '../../lib/telemetry/archiveSink.js';
import type { CallRecord } from '../../lib/llm/callRecord.js';
import { buildBatch } from '../review/build.js';

const mode = (id: string, slug: string, suite = 'summarize.context'): FailureMode => ({
    id, slug, suite, title: slug, definition: slug, scope: 'call', severity: 'degraded', impact: 'visible', status: 'guarded',
});

const record = (over: Partial<CheckRecord>): CheckRecord => ({
    traceId: 't1', modeId: 'FM-0001', slug: 'context_disclaimer_preamble', scope: 'call', callId: 'call-1', label: 'subject-context-search:X',
    result: 'fail', evidence: 'Δυστυχώς', at: '2026-10-10T22:40:29.411Z', ...over,
});

async function putChecks(store: ArchiveStore, day: Date, traceId: string, records: CheckRecord[]) {
    await store.put(archiveKeys.checks('development', day, traceId), records.map(r => JSON.stringify(r)).join('\n') + '\n');
}

describe('monitoring harvest', () => {
    let dir: string;
    let store: ArchiveStore;
    const now = new Date('2026-10-11T08:00:00Z');
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harvest-')); store = fsStore(dir); });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('turns fired checks of the given modes into one candidate per run, call and mode', async () => {
        await putChecks(store, new Date('2026-10-10T22:00:00Z'), 't1', [
            record({}),
            record({ result: 'pass', callId: 'call-2' }),
            record({ modeId: 'FM-0099', slug: 'unmonitored' }),
        ]);
        await putChecks(store, new Date('2026-09-01T00:00:00Z'), 'old', [record({ traceId: 'old' })]);

        const got = await harvestMonitoring(store, { env: 'development', sinceDays: 14, modes: [mode('FM-0001', 'context_disclaimer_preamble')], now });
        expect(got).toHaveLength(1);
        expect(got[0]).toMatchObject({
            suite: 'summarize.context', source: 'monitoring', signal: 'check:context_disclaimer_preamble',
            traceId: 't1', callId: 'call-1', modeId: 'FM-0001', label: 'subject-context-search:X', env: 'development',
        });

        expect((await writeCandidates(store, got)).written).toHaveLength(1);
        const again = await harvestMonitoring(store, { env: 'development', sinceDays: 14, modes: [mode('FM-0001', 'context_disclaimer_preamble')], now });
        expect(await writeCandidates(store, again)).toMatchObject({ written: [], existing: [{ id: got[0].id }] });
        expect(await listCandidates(store, 'summarize.context')).toHaveLength(1);
    });

    it('filters by suite', async () => {
        await putChecks(store, now, 't1', [record({})]);
        const got = await harvestMonitoring(store, { env: 'development', sinceDays: 1, modes: [mode('FM-0001', 'context_disclaimer_preamble')], suite: 'decisions.reading', now });
        expect(got).toEqual([]);
    });
});

describe('monitoring harvest of decision calls', () => {
    let dir: string;
    let store: ArchiveStore;
    const now = new Date('2026-10-11T08:00:00Z');
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harvest-')); store = fsStore(dir); });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    const reading: CallRecord = {
        v: 1, callId: 'r1', label: 'decision-reading', cacheKey: 'k', startedAt: '', finishedAt: '', request: { model: 'm', max_tokens: 1, messages: [] },
        response: { servedModel: 'm', stopReason: 'end_turn', text: JSON.stringify({ meetingDate: '2026-09-23', decisionNumber: '266/2026', body: 'Δημοτική Επιτροπή', notADecision: true }), usage: {}, latencyMs: 1, batchMode: false },
    };

    it('turns a fired decision-reading call into a proposed case that label-confirm can take', async () => {
        const run = { traceId: 'p1', taskType: 'pollDecisions', taskVersion: 4, taskId: 'x', env: 'development' as const, startedAt: '2026-10-10T10:00:00.000Z', meeting: 'vrilissia/sep23_2026', input: { administrativeBodyName: 'Δημοτική Επιτροπή' } };
        const result = { decisions: [{ ada: 'ΑΔΑ-1', pdfUrl: 'https://diavgeia.gov.gr/doc/ΑΔΑ-1', decisionNumber: '266/2026', meetingDate: '2026-09-23', fromKnown: false, body: 'Δημοτική Επιτροπή' }], matches: [] };
        const key = archiveKeys.calls('development', new Date(run.startedAt), run.taskType, run.traceId);
        await store.put(key, encodeRunFile({ run, phases: [], calls: [reading] }, { status: 'success', endedAt: run.startedAt, result }));
        await store.put(archiveKeys.traceIndex(run.traceId), key);
        await putChecks(store, now, 'p1', [record({ traceId: 'p1', modeId: 'FM-0010', slug: 'not_a_decision_with_number', callId: 'r1', label: 'decision-reading' })]);

        const [cand] = await harvestMonitoring(store, { env: 'development', sinceDays: 1, modes: [mode('FM-0010', 'not_a_decision_with_number', 'decisions.reading')], now });
        expect(cand).toMatchObject({
            suite: 'decisions.reading', caseId: 'decisions.reading/ΑΔΑ-1', fields: ['meetingDate', 'decisionNumber', 'body'],
            newCase: { input: { ada: 'ΑΔΑ-1', pdfUrl: 'https://diavgeia.gov.gr/doc/ΑΔΑ-1' }, cluster: 'vrilissia/Δημοτική Επιτροπή' },
            // notADecision normalizes the reading's fields away: what production kept is what is proposed.
            proposed: { meetingDate: null, decisionNumber: null, body: null },
        });

        const batch = await buildBatch('label-confirm', [cand], { store, casesRoot: path.join(dir, 'cases'), now });
        expect(batch.items.map(i => [i.caseId, i.field, i.proposed, i.newCase?.cluster])).toEqual([
            ['decisions.reading/ΑΔΑ-1', 'meetingDate', null, 'vrilissia/Δημοτική Επιτροπή'],
            ['decisions.reading/ΑΔΑ-1', 'decisionNumber', null, 'vrilissia/Δημοτική Επιτροπή'],
            ['decisions.reading/ΑΔΑ-1', 'body', null, 'vrilissia/Δημοτική Επιτροπή'],
        ]);
    });

    it('leaves a candidate whose run is not archived as an occurrence only', async () => {
        await putChecks(store, now, 'gone', [record({ traceId: 'gone', modeId: 'FM-0010', slug: 'not_a_decision_with_number', callId: 'r1', label: 'decision-reading' })]);
        const [cand] = await harvestMonitoring(store, { env: 'development', sinceDays: 1, modes: [mode('FM-0010', 'not_a_decision_with_number', 'decisions.reading')], now });
        expect(cand.caseId).toBeUndefined();
        expect(cand.proposed).toBeUndefined();
    });
});

describe('disagreement candidates', () => {
    const exp = (value: unknown, tier: 'drafted' | 'contested' | 'adjudicated') => ({ value, tier, by: 'fixture', at: '2026-09-02', source: 'fixture:x' });
    const c: Case = {
        id: 'decisions.reading/A', suite: 'decisions.reading', split: 'dev', input: {}, cluster: 'x/y', tags: [],
        expect: { meetingDate: exp('2026-01-01', 'drafted'), decisionNumber: exp('12', 'contested'), body: exp('ΔΣ', 'adjudicated') },
    };
    const read = (o: unknown, f: string) => decisionsReading.labelValue!(o as never, f);
    const row = (rep: number, fields: ResultRow['fields'], output: unknown): ResultRow => ({
        caseId: c.id, rep, fields, output, checks: {}, usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0, latencyMs: 0, servedModels: [], status: 'ok', traceId: `trace-${rep}`,
    });

    it('proposes the run\'s value for drafted disagreements and contested values, never for human tiers', () => {
        const got = disagreementCandidates('decisions.reading', 'run-1', [
            row(0, { meetingDate: 'disagree', decisionNumber: 'unscorable', body: 'disagree' }, { meetingDate: '2026-01-02', decisionNumber: '13', body: 'ΔΕ' }),
            row(1, { meetingDate: 'agree', decisionNumber: 'unscorable', body: 'agree' }, { meetingDate: '2026-01-01', decisionNumber: '13', body: 'ΔΣ' }),
        ], [c], read, new Date('2026-10-11T00:00:00Z'));
        expect(got).toHaveLength(1);
        expect(got[0]).toMatchObject({
            suite: 'decisions.reading', source: 'disagreement', signal: 'disagreement:run-1', caseId: c.id, traceId: 'trace-0',
            fields: ['meetingDate', 'decisionNumber'], proposed: { meetingDate: '2026-01-02', decisionNumber: '13' },
        });
    });

    it('yields nothing when the run agrees with every drafted value', () => {
        expect(disagreementCandidates('decisions.reading', 'run-1', [row(0, { meetingDate: 'agree', body: 'agree' }, { meetingDate: '2026-01-01' })], [{ ...c, expect: { meetingDate: c.expect.meetingDate } }], read)).toEqual([]);
    });

    it('proposes nothing a suite cannot state in the case\'s shape, and skips contested values then', () => {
        const got = disagreementCandidates('decisions.extraction', 'run-1', [row(0, { meetingDate: 'disagree', decisionNumber: 'unscorable' }, { meetingDate: 'x', decisionNumber: '13' })], [c], () => undefined);
        expect(got).toHaveLength(1);
        expect(got[0].fields).toEqual(['meetingDate']);
        expect(got[0].proposed).toBeUndefined();
    });
});
