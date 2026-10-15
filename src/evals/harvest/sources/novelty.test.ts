import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fsStore } from '../../../lib/archive/store.js';
import type { CallRecord } from '../../../lib/llm/callRecord.js';
import type { ArchivedRun } from '../../../lib/telemetry/archiveSink.js';
import { writeCase } from '../../cases/caseStore.js';
import type { Case } from '../../types.js';
import { harvestNovelty, valueShape, type NoveltyStats } from './novelty.js';

const exp = (value: unknown) => ({ value, tier: 'adjudicated' as const, by: 'test', at: '2026-10-01', source: 'test' });
const readingCase = (ada: string, cluster: string, decisionNumber: string): Case => ({
    id: `decisions.reading/${ada}`, suite: 'decisions.reading', split: 'dev', input: { ada, pdfUrl: `u/${ada}` }, cluster, tags: [],
    expect: { decisionNumber: exp(decisionNumber) },
});
const summarizeCase = (suite: string, city: string): Case => ({ id: `${suite}/${city}-m`, suite, split: 'dev', input: { meeting: `${city}/m` }, replay: 'r', cluster: city, tags: [], expect: {} });

let n = 0;
function pollRun(city: string, body: string, docs: Array<{ ada: string; number: string; body?: string }>, startedAt: string): ArchivedRun {
    const calls: CallRecord[] = docs.map(d => ({
        v: 1, callId: `c${n++}`, label: 'decision-reading', cacheKey: 'k', startedAt, finishedAt: startedAt, request: { model: 'm', max_tokens: 1, messages: [] },
        response: { servedModel: 'm', stopReason: 'end_turn', text: JSON.stringify({ meetingDate: '2026-09-01', decisionNumber: d.number, body: d.body ?? body, notADecision: false }), usage: {}, latencyMs: 1, batchMode: false },
    }));
    const decisions = docs.map(d => ({ ada: d.ada, pdfUrl: `u/${d.ada}`, decisionNumber: d.number, meetingDate: '2026-09-01', body: d.body ?? body, fromKnown: false, readStatus: 'ok' }));
    return {
        run: { traceId: `t${n++}`, taskType: 'pollDecisions', taskVersion: 4, taskId: 'x', env: 'production', startedAt, meeting: `${city}/m`, input: { administrativeBodyName: body } },
        outcome: { status: 'success', endedAt: startedAt }, phases: [], calls, result: { decisions, matches: [] }, key: 'k',
    };
}
const summarizeRun = (city: string, startedAt: string): ArchivedRun => ({
    run: { traceId: `s${n++}`, taskType: 'summarize', taskVersion: 6, taskId: 'x', env: 'production', startedAt, meeting: `${city}/m1` },
    outcome: { status: 'success', endedAt: startedAt }, phases: [], calls: [], result: { subjects: [] }, key: 'k',
});
async function* each(runs: ArchivedRun[]) { yield* runs; }

describe('novelty harvest', () => {
    let dir: string;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novelty-'));
        for (const c of [
            readingCase('K1', 'sparta/Δημοτική Επιτροπή', '120/2026'),
            readingCase('K2', 'sparta/Δημοτική Επιτροπή', '7'),
            ...['summarize.contributions', 'summarize.context', 'summarize.e2e'].map(s => summarizeCase(s, 'zografou')),
        ]) writeCase(c, path.join(dir, 'cases'));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    const harvest = (runs: ArchivedRun[], suite?: string, stats: Record<string, NoveltyStats> = {}) =>
        harvestNovelty(fsStore(path.join(dir, 'archive')), { env: 'production', sinceDays: 30, suite, casesRoot: path.join(dir, 'cases'), runs: each(runs), now: new Date('2026-10-11T00:00:00Z'), stats });

    it('shapes values by digit and letter runs', () => {
        expect(['266/2026', '7', 'ΠΡΑΞΗ 95', '12/2026-Α'].map(valueShape)).toEqual(['9/9', '9', 'a 9', '9/9-a']);
    });

    it('flags a new city once, counting its calls and listing its bodies, with a case label-confirm can take', async () => {
        const got = await harvest([
            pollRun('thira', 'Δημοτικό Συμβούλιο', [{ ada: 'T1', number: '1/2026' }], '2026-10-02T00:00:00Z'),
            pollRun('thira', 'Δημοτική Επιτροπή', [{ ada: 'T2', number: '2/2026' }, { ada: 'T3', number: '3/2026' }], '2026-09-29T00:00:00Z'),
        ], 'decisions.reading');
        expect(got).toHaveLength(1);
        expect(got[0]).toMatchObject({
            suite: 'decisions.reading', source: 'novelty', signal: 'novelty:new-city', caseId: 'decisions.reading/T1',
            newCase: { cluster: 'thira/Δημοτικό Συμβούλιο' }, proposed: { decisionNumber: '1/2026' },
            evidence: '3 calls from thira between 2026-09-29 and 2026-10-02; no case has this city; bodies: Δημοτικό Συμβούλιο | Δημοτική Επιτροπή',
        });
    });

    it('flags a covered city\'s new body and a covered cluster\'s new number shape, and skips documents that already are cases', async () => {
        const stats: Record<string, NoveltyStats> = {};
        const got = await harvest([pollRun('sparta', 'Δημοτική Επιτροπή', [
            { ada: 'S1', number: '200/2026' },
            { ada: 'S2', number: '12/2026-Α' },
            { ada: 'K1', number: '120/2026' },
            { ada: 'S3', number: '5', body: 'ΔΗΜΟΤΙΚΗ ΚΟΙΝΟΤΗΤΑ ΧΡΥΣΑΦΩΝ' },
        ], '2026-09-26T00:00:00Z')], 'decisions.reading', stats);
        expect(got.map(c => [c.signal, c.caseId])).toEqual([
            ['novelty:new-shape:decisionNumber', 'decisions.reading/S2'],
            ['novelty:new-body', 'decisions.reading/S3'],
        ]);
        expect(got[0].evidence).toContain('decisionNumber shaped "9/9-a"; the cluster\'s cases have "9/9", "9"');
        expect(stats['decisions.reading']).toEqual({ seen: 4, placed: 4, known: 1 });
    });

    it('flags summarize cities without a case once across the phase suites that share them', async () => {
        const got = await harvest([summarizeRun('chania', '2026-10-05T00:00:00Z'), summarizeRun('chania', '2026-09-01T00:00:00Z'), summarizeRun('zografou', '2026-10-01T00:00:00Z')]);
        const summarize = got.filter(c => c.suite.startsWith('summarize.'));
        expect(summarize).toHaveLength(1);
        expect(summarize[0]).toMatchObject({ suite: 'summarize.contributions', signal: 'novelty:new-city' });
        expect(summarize[0].evidence).toBe('2 runs from chania between 2026-09-01 and 2026-10-05; no case has this city (nor in summarize.context, summarize.e2e)');
    });
});
