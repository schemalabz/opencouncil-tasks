import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import type { RunManifest } from '../types.js';
import { formatComparison, type Comparison, type FieldComparison } from './compare.js';
import { DEFAULT_GATE, evaluateGate, loadGate } from './gate.js';

const manifest = { runId: 'r', suite: 'demo', variant: { name: 'v', overrides: {} }, reps: 1, status: 'complete' } as RunManifest;

function field(over: Partial<FieldComparison>): FieldComparison {
    return {
        field: 'date', tierGroup: 'human', split: 'holdout', n: 50, cases: 50, accA: 1, accB: 1, delta: 0, ci: [0, 0],
        aOnlyRight: 0, bOnlyRight: 0, p: 1, pAdj: 1, flipsA: [0, 0], flipsB: [0, 0],
        regressionsByCluster: [], regressedCases: [], ...over,
    };
}

const regressed = (count: number, cluster = 'argithea/Δημοτικό Συμβούλιο'): Partial<FieldComparison> => ({
    accB: 1 - count / 50, delta: -count / 50, aOnlyRight: count,
    regressedCases: Array.from({ length: count }, (_, i) => `c${i}`),
    regressionsByCluster: [{ cluster, count }],
});

function comparison(fields: FieldComparison[], over: Partial<Comparison> = {}): Comparison {
    return { suite: 'demo', a: manifest, b: manifest, fields, costA: 0.01, costB: 0.01, errorsA: 0, errorsB: 0, casesA: 50, casesB: 50, attemptsA: 50, attemptsB: 50, unscoredByB: [], staleExpectations: [], ...over };
}

describe('evaluateGate', () => {
    it('passes when no human-tier holdout value regresses', () => {
        const c = comparison([field({}), field({ split: 'dev', ...regressed(1) })]);
        expect(evaluateGate(c, DEFAULT_GATE)).toEqual({ verdict: 'PASS', reasons: [] });
    });

    it('fails on a human-tier holdout regression and names the cluster', () => {
        const r = evaluateGate(comparison([field(regressed(8))]), DEFAULT_GATE);
        expect(r.verdict).toBe('FAIL');
        expect(r.reasons[0]).toMatch(/date: 8 human-tier holdout regression\(s\).*argithea\/Δημοτικό Συμβούλιο \(8\)/);
    });

    it('lets a regression within the noise floor through, and ignores listed fields', () => {
        const c = comparison([field(regressed(1))]);
        expect(evaluateGate(c, { ...DEFAULT_GATE, noiseFloorPp: 3 }).verdict).toBe('PASS');
        expect(evaluateGate(comparison([field(regressed(1)), field({ field: 'number' })]), { ...DEFAULT_GATE, ignoreFields: ['date'] }).verdict).toBe('PASS');
    });

    it('judges the noise floor on the regressions, so an improvement elsewhere in the field cannot cancel one out', () => {
        const netZero = field({ delta: 0, aOnlyRight: 1, bOnlyRight: 1, regressedCases: ['c0'], regressionsByCluster: [{ cluster: 'x', count: 1 }] });
        expect(evaluateGate(comparison([netZero]), DEFAULT_GATE).verdict).toBe('FAIL');
        expect(evaluateGate(comparison([netZero]), { ...DEFAULT_GATE, noiseFloorPp: 2 }).verdict).toBe('PASS');
    });

    it('needs review when only drafted labels show regressions', () => {
        const c = comparison([field({ tierGroup: 'drafted', split: 'all', ...regressed(3) }), field({ tierGroup: 'drafted', ...regressed(3) })]);
        const r = evaluateGate(c, DEFAULT_GATE);
        expect(r.verdict).toBe('NEEDS_REVIEW');
        expect(r.reasons[0]).toMatch(/decided only by drafted labels/);
    });

    it('never passes on drafted labels alone, even with nothing changed', () => {
        const r = evaluateGate(comparison([field({ tierGroup: 'drafted', split: 'all' }), field({ tierGroup: 'drafted', split: 'dev' })]), DEFAULT_GATE);
        expect(r.verdict).toBe('NEEDS_REVIEW');
        expect(r.reasons[0]).toMatch(/no human-tier holdout values/);
    });

    it('needs review until enough cases carry human-tier holdout values, but still fails on their regressions', () => {
        const rule = { ...DEFAULT_GATE, minHumanHoldoutCases: 5 };
        expect(evaluateGate(comparison([field({ n: 40, cases: 4 })]), rule)).toEqual({ verdict: 'NEEDS_REVIEW', reasons: ['only 4 case(s) carry human-tier holdout values; this gate needs 5'] });
        expect(evaluateGate(comparison([field({ n: 40, cases: 5 })]), rule).verdict).toBe('PASS');
        expect(evaluateGate(comparison([field({ n: 40, cases: 4, ...regressed(2) })]), rule).verdict).toBe('FAIL');
    });

    it('never passes when a run did not finish, and names the run and why', () => {
        const stopped: RunManifest = { ...manifest, runId: 'run-B', reps: 2, status: 'incomplete', incompleteReason: 'budget $2 reached' };
        const c = comparison([field({})], { b: stopped });
        const r = evaluateGate(c, DEFAULT_GATE);
        expect(r.verdict).toBe('NEEDS_REVIEW');
        expect(r.reasons).toEqual([expect.stringMatching(/^B \(run-B\) is incomplete \(budget \$2 reached\)/)]);
        expect(formatComparison(c)).toContain('! B (run-B) is incomplete (budget $2 reached)');
        expect(evaluateGate(comparison([field({})], { a: { ...manifest, status: 'running' } }), DEFAULT_GATE).verdict).toBe('NEEDS_REVIEW');
    });

    it('fails on a cost increase over the limit', () => {
        const r = evaluateGate(comparison([field({})], { costB: 0.0115 }), DEFAULT_GATE);
        expect(r.verdict).toBe('FAIL');
        expect(r.reasons[0]).toMatch(/cost \+15\.0%/);
        expect(evaluateGate(comparison([field({})], { costB: 0.0105 }), DEFAULT_GATE).verdict).toBe('PASS');
    });

    it('fails when a guarded failure mode fires significantly more often', () => {
        const c = comparison([field({})], { checkFireRates: { 'FM-7': { a: 0, b: 0.2, p: 0.002 }, 'FM-8': { a: 0, b: 0.04, p: 0.5 } } });
        const r = evaluateGate(c, DEFAULT_GATE);
        expect(r.verdict).toBe('FAIL');
        expect(r.reasons).toHaveLength(1);
        expect(r.reasons[0]).toMatch(/^FM-7/);
    });

    it('notes more errors and fails only above 5% of attempts', () => {
        const few = evaluateGate(comparison([field({})], { errorsB: 2 }), DEFAULT_GATE);
        expect(few.verdict).toBe('PASS');
        expect(few.reasons[0]).toMatch(/errors 0 → 2/);
        expect(evaluateGate(comparison([field({})], { errorsB: 3 }), DEFAULT_GATE).verdict).toBe('FAIL');
        // Three reps of 50 cases: 3 errors are 2% of attempts, though 6% of cases.
        expect(evaluateGate(comparison([field({})], { errorsB: 3, attemptsB: 150 }), DEFAULT_GATE).verdict).toBe('PASS');
    });
});

describe('loadGate', () => {
    it('merges a suite file over the default and falls back without one', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
        fs.mkdirSync(path.join(root, 'evals', 'gates'), { recursive: true });
        fs.writeFileSync(path.join(root, 'evals', 'gates', 's.yaml'), 'maxCostIncreasePct: 25\nignoreFields: [excerpt]\n');
        expect(loadGate('s', root)).toEqual({ ...DEFAULT_GATE, maxCostIncreasePct: 25, ignoreFields: ['excerpt'] });
        expect(loadGate('missing', root)).toEqual(DEFAULT_GATE);
        fs.writeFileSync(path.join(root, 'evals', 'gates', 'bad.yaml'), 'maxCostIncrease: 25\n');
        expect(() => loadGate('bad', root)).toThrow(/unknown gate key/);
    });

    it('reads the checked-in gates', () => {
        const root = fileURLToPath(new URL('../../..', import.meta.url));
        expect(loadGate('decisions.reading', root)).toEqual(DEFAULT_GATE);
        expect(loadGate('decisions.extraction', root)).toEqual({ ...DEFAULT_GATE, ignoreFields: ['excerpt'] });
        for (const suite of ['agenda.extraction', 'fix.transcript']) expect(loadGate(suite, root)).toEqual({ ...DEFAULT_GATE, minHumanHoldoutCases: 5 });
    });
});
