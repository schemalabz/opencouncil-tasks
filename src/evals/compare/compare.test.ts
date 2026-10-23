import path from 'path';
import { describe, expect, it } from 'vitest';
import type { Case, FieldOutcome, ResultRow, RunManifest, Split, Tier } from '../types.js';
import { compareRuns, formatComparison, type ComparableRun, type FieldComparison } from './compare.js';
import { DEFAULT_GATE, evaluateGate } from './gate.js';
import { loadSpikeRun, spikeCases, spikeRunsDir } from './spikeFixture.js';

function manifest(name: string, reps: number): RunManifest {
    return {
        runId: `run-${name}`, suite: 'demo', variant: { name, overrides: {} }, split: 'all', reps,
        cases: 0, caseSetSha: 'sha', gitRef: 'abc', gitDirty: false, startedAt: 't0', spentUsd: 0, status: 'complete',
    };
}

function mkCase(id: string, cluster: string, split: Split, tiers: Record<string, Tier>): Case {
    const expect: Case['expect'] = {};
    for (const [f, tier] of Object.entries(tiers)) expect[f] = { value: 1, tier, by: 't', at: 't', source: 't' };
    return { id, suite: 'demo', split, input: null, expect, cluster, tags: [] };
}

/** outcomes: caseId → per-rep field outcomes */
function mkRun(name: string, outcomes: Record<string, Array<Record<string, FieldOutcome>>>, costUsd = 0.01): ComparableRun {
    const rows: ResultRow[] = Object.entries(outcomes).flatMap(([caseId, reps]) => reps.map((fields, rep) => ({
        caseId, rep, fields, checks: {}, usage: { input_tokens: 0, output_tokens: 0 }, costUsd, latencyMs: 1,
        servedModels: [name], status: 'ok' as const, traceId: '', output: null,
    })));
    const maxReps = Math.max(...Object.values(outcomes).map(r => r.length));
    return { manifest: manifest(name, maxReps), rows, errors: [] };
}

const find = (fs: FieldComparison[], field: string, tierGroup: string, split: string) =>
    fs.find(f => f.field === field && f.tierGroup === tierGroup && f.split === split);

describe('compareRuns', () => {
    const cases = [
        mkCase('h1', 'bodyX', 'holdout', { date: 'adjudicated' }),
        mkCase('h2', 'bodyX', 'holdout', { date: 'imported' }),
        mkCase('h3', 'bodyY', 'holdout', { date: 'adjudicated' }),
        mkCase('d1', 'bodyY', 'dev', { date: 'drafted' }),
        mkCase('d2', 'bodyZ', 'dev', { date: 'adjudicated' }),
        mkCase('c1', 'bodyZ', 'dev', { date: 'contested' }),
    ];
    const ok = { date: 'agree' as const };
    const bad = { date: 'disagree' as const };
    const a = mkRun('A', { h1: [ok, ok], h2: [ok, ok], h3: [ok, bad], d1: [ok, ok], d2: [bad, bad], c1: [ok, ok] });
    const b = mkRun('B', { h1: [bad, bad], h2: [bad, { date: 'missing' }], h3: [ok, ok], d1: [bad, bad], d2: [ok, ok], c1: [bad, bad] }, 0.02);
    const cmp = compareRuns(a, b, cases);

    it('splits by tier group and split, excluding contested values', () => {
        const humanHoldout = find(cmp.fields, 'date', 'human', 'holdout')!;
        expect(humanHoldout.n).toBe(3);
        expect(humanHoldout.accA).toBeCloseTo((1 + 1 + 0.5) / 3);
        expect(humanHoldout.accB).toBeCloseTo(1 / 3);
        expect(find(cmp.fields, 'date', 'human', 'dev')!.n).toBe(1);
        expect(find(cmp.fields, 'date', 'human', 'all')!.n).toBe(4);
        expect(find(cmp.fields, 'date', 'drafted', 'dev')!.n).toBe(1);
        expect(find(cmp.fields, 'date', 'drafted', 'holdout')).toBeUndefined();
        expect(cmp.fields.every(f => !f.regressedCases.includes('c1'))).toBe(true);
    });

    it('groups regressions by cluster and counts discordant majorities', () => {
        const humanHoldout = find(cmp.fields, 'date', 'human', 'holdout')!;
        // h3's A majority is a 0.5 tie, so it is neither a regression nor a B-only win.
        expect(humanHoldout.regressedCases).toEqual(['h1', 'h2']);
        expect(humanHoldout.regressionsByCluster).toEqual([{ cluster: 'bodyX', count: 2 }]);
        expect([humanHoldout.aOnlyRight, humanHoldout.bOnlyRight]).toEqual([2, 0]);
        const humanAll = find(cmp.fields, 'date', 'human', 'all')!;
        expect([humanAll.aOnlyRight, humanAll.bOnlyRight]).toEqual([2, 1]);
        expect(humanAll.p).toBe(1);
    });

    it('counts rep-to-rep flips per run', () => {
        expect(find(cmp.fields, 'date', 'human', 'holdout')!.flipsA).toEqual([1, 3]);
        expect(find(cmp.fields, 'date', 'human', 'holdout')!.flipsB).toEqual([0, 3]);
        // human/all: h3 flips among the 4 cases with repeats
        expect(cmp.noiseFloorPp).toBe(25);
    });

    it('reports cost per attempt, errors and cases', () => {
        expect(cmp.costA).toBeCloseTo(0.01);
        expect(cmp.costB).toBeCloseTo(0.02);
        expect([cmp.casesA, cmp.casesB, cmp.errorsA, cmp.errorsB]).toEqual([6, 6, 0, 0]);
    });

    it('Holm-adjusts within a tier group and split across fields', () => {
        const multi = [mkCase('x1', 'k', 'dev', { f1: 'adjudicated', f2: 'adjudicated' })];
        const ra = mkRun('A', { x1: [{ f1: 'agree', f2: 'agree' }] });
        const rb = mkRun('B', { x1: [{ f1: 'disagree', f2: 'agree' }] });
        const c = compareRuns(ra, rb, multi);
        expect(find(c.fields, 'f1', 'human', 'dev')!.pAdj).toBe(1);
        expect(find(c.fields, 'f2', 'human', 'dev')!.pAdj).toBe(1);
    });

    it('computes guarded failure-mode fire rates', () => {
        const withChecks = (run: ComparableRun, fail: string[]) => ({
            ...run, rows: run.rows.map(r => ({ ...r, checks: { 'FM-1': fail.includes(r.caseId) ? 'fail' as const : 'pass' as const } })),
        });
        const c = compareRuns(withChecks(a, []), withChecks(b, ['h1', 'h2', 'h3', 'd1', 'd2', 'c1']), cases);
        const fm = c.checkFireRates?.['FM-1'];
        expect([fm?.a, fm?.b]).toEqual([0, 1]);
        expect(fm?.p).toBeCloseTo(2 / 2 ** 6, 10);
        expect(cmp.checkFireRates).toBeUndefined();
    });

    it('formats a report that hides holdout case ids unless asked', () => {
        const text = formatComparison(cmp);
        expect(text).toContain('## date');
        expect(text).toContain('labels=human');
        expect(text).toContain('regressions by cluster: bodyX 2');
        expect(text).not.toContain('regressed: h1');
        expect(formatComparison(cmp, { showHoldoutCases: true })).toContain('regressed: h1, h2');
    });
});

const spikeDir = spikeRunsDir();

describe.skipIf(!spikeDir)('parity with the spike compare.py', () => {
    it('reading: haiku-4-5 vs haiku-5-5 and sonnet-5-5 match reading-compare.txt', () => {
        const load = (v: string) => loadSpikeRun(path.join(spikeDir!, 'reading', v), 'decisions.reading');
        const a = load('haiku-4-5');
        const b = load('haiku-5-5');
        const s = load('sonnet-5-5');
        const cases = spikeCases('decisions.reading', [...a.spikeRows, ...b.spikeRows, ...s.spikeRows], tags => tags[0]);
        const cmp = compareRuns(a.run, b.run, cases);
        const expected = { date: [1, 0.973, 282], number: [1, 0.971, 267], body: [1, 0.971, 266] } as const;
        for (const [field, [accA, accB, n]] of Object.entries(expected)) {
            const f = find(cmp.fields, field, 'human', 'all')!;
            expect(f.n).toBe(n);
            expect(+f.accA.toFixed(3)).toBe(accA);
            expect(+f.accB.toFixed(3)).toBe(accB);
            expect([f.aOnlyRight, f.bOnlyRight]).toEqual([8, 0]);
            expect(f.p).toBeCloseTo(0.0078125, 7);
            expect(f.flipsB).toEqual([1, n]);
            expect(f.flipsA).toEqual([0, n]);
        }
        expect(cmp.errorsB).toBe(3);
        expect(cmp.noiseFloorPp).toBe(0);

        const cs = compareRuns(a.run, s.run, cases);
        const date = find(cs.fields, 'date', 'human', 'all')!;
        expect(+date.accB.toFixed(3)).toBe(0.989);
        expect([date.aOnlyRight, date.bOnlyRight, +date.p.toFixed(3)]).toEqual([3, 0, 0.25]);
        const number = find(cs.fields, 'number', 'human', 'all')!;
        expect([+number.accB.toFixed(3), number.aOnlyRight, +number.p.toFixed(3)]).toEqual([0.978, 6, 0.031]);
    });

    it('extraction: sonnet-4-6 vs haiku-5-5 per label group match extraction-compare.txt', () => {
        const load = (v: string) => loadSpikeRun(path.join(spikeDir!, 'extraction', v), 'decisions.extraction');
        const a = load('sonnet-4-6');
        const b = load('haiku-5-5');
        const cases = spikeCases('decisions.extraction', [...a.spikeRows, ...b.spikeRows], tags => `${tags[0]}/${tags[1]}`);
        const cmp = compareRuns(a.run, b.run, cases);
        // [n, accA, accB, A-only-right, B-only-right] for the spike's labels=human / labels=agreed|other lines
        const expected: Record<string, Record<string, [number, number, number, number, number]>> = {
            rollCall: { human: [14, 0.857, 0.548, 4, 0], drafted: [47, 0.936, 0.879, 4, 1] },
            attendanceChanges: { human: [17, 0.941, 0.784, 3, 0], drafted: [44, 0.909, 0.864, 2, 0] },
            votes: { human: [26, 0.962, 0.885, 2, 0], drafted: [35, 1, 0.952, 1, 0] },
            subject: { human: [21, 0.857, 0.762, 5, 3], drafted: [39, 1, 0.974, 0, 0] },
            excerpt: { human: [3, 0, 0, 0, 0], drafted: [52, 0.846, 0.712, 9, 4] },
        };
        for (const [field, groups] of Object.entries(expected)) {
            for (const [group, [n, accA, accB, aOnly, bOnly]] of Object.entries(groups)) {
                const f = find(cmp.fields, field, group, 'all')!;
                expect([f.n, +f.accA.toFixed(3), +f.accB.toFixed(3), f.aOnlyRight, f.bOnlyRight], `${field}/${group}`)
                    .toEqual([n, accA, accB, aOnly, bOnly]);
            }
        }
        expect(cmp.noiseFloorPp).toBeGreaterThan(0);
    });
});

describe('units B did not score', () => {
    const cases = Array.from({ length: 20 }, (_, i) => mkCase(`h${i}`, `body${i}`, 'holdout', { date: 'adjudicated' }));
    const all = (o: FieldOutcome) => Object.fromEntries(cases.map(c => [c.id, [{ date: o }]]));
    const a = mkRun('A', all('agree'));

    it('fail the gate instead of dropping out of the pairing', () => {
        const b = mkRun('B', all('agree'));
        expect(evaluateGate(compareRuns(a, b, cases), DEFAULT_GATE).verdict).toBe('PASS');

        b.rows.find(r => r.caseId === 'h3')!.status = 'truncated';
        b.rows = b.rows.filter(r => r.caseId !== 'h7');
        b.errors = [{ caseId: 'h7', rep: 0, errorClass: 'Error', message: 'boom', costUsd: 0 }];
        const cmp = compareRuns(a, b, cases);
        expect(cmp.unscoredByB).toEqual([{ field: 'date', unit: 'h3', why: 'truncated' }, { field: 'date', unit: 'h7', why: 'errored' }]);
        const gate = evaluateGate(cmp, DEFAULT_GATE);
        expect(gate.verdict).toBe('FAIL');
        expect(gate.reasons[0]).toBe('B did not score 2 human-tier holdout unit(s) that A scored: date h3 (truncated), date h7 (errored)');
        expect(evaluateGate(cmp, { ...DEFAULT_GATE, ignoreFields: ['date'] }).reasons.some(r => r.startsWith('B did not score'))).toBe(false);
    });
});

describe('item fields', () => {
    it('scores subject[…] fields as one family whose units are (case, item), clustered by the case', () => {
        const cases = [
            mkCase('m1', 'cityA', 'dev', { 'subject[#1 a]': 'drafted', 'subject[#2 b]': 'drafted' }),
            mkCase('m2', 'cityB', 'dev', { 'subject[#1 c]': 'drafted' }),
        ];
        const a = mkRun('production', { m1: [{ 'subject[#1 a]': 'agree', 'subject[#2 b]': 'agree' }], m2: [{ 'subject[#1 c]': 'agree' }] });
        const b = mkRun('variant', { m1: [{ 'subject[#1 a]': 'agree', 'subject[#2 b]': 'disagree' }], m2: [{ 'subject[#1 c]': 'agree' }] });
        a.rows[0].detail = { 'subject[#1 a]': 'identical', 'subject[#2 b]': 'cosmetic (context)' };
        b.rows[0].detail = { 'subject[#1 a]': 'cosmetic (contribs-changed:1)', 'subject[#2 b]': 'structural (-speakers:x)' };
        const cmp = compareRuns(a, b, cases);
        const f = find(cmp.fields, 'subject', 'drafted', 'dev')!;
        expect(f.n).toBe(3);
        expect(f.aOnlyRight).toBe(1);
        expect(f.regressionsByCluster).toEqual([{ cluster: 'cityA', count: 1 }]);
        expect(f.regressedCases).toEqual(['m1[#2 b]']);
        expect(cmp.detailTallies?.subject).toEqual({ a: { identical: 1, cosmetic: 1 }, b: { cosmetic: 1, structural: 1 } });
        const text = formatComparison(cmp);
        expect(text).toContain('verdicts (all reps)  A cosmetic 1 · identical 1   B cosmetic 1 · structural 1');
        expect(text).toContain('regression only');
    });
});
