import { describe, expect, it } from 'vitest';
import { clusterBootstrapCI, exactMcNemarP, holm, majority, mean } from './stats.js';

describe('exactMcNemarP', () => {
    it('matches the two-sided exact binomial on discordant counts', () => {
        expect(exactMcNemarP(8, 0)).toBeCloseTo(0.0078125, 10);
        expect(exactMcNemarP(8, 2)).toBeCloseTo(0.109375, 6);
        expect(exactMcNemarP(0, 0)).toBe(1);
        expect(exactMcNemarP(5, 5)).toBe(1);
    });

    it('is symmetric', () => {
        expect(exactMcNemarP(2, 8)).toBe(exactMcNemarP(8, 2));
        expect(exactMcNemarP(0, 13)).toBe(exactMcNemarP(13, 0));
    });

    it('stays finite for large discordant counts', () => {
        const p = exactMcNemarP(700, 600);
        expect(p).toBeGreaterThan(0);
        expect(p).toBeLessThan(0.01);
    });
});

describe('holm', () => {
    it('adjusts step-down and keeps the input order', () => {
        // sorted: 0.01*4=0.04, 0.02*3=0.06, 0.03*2=0.06 (monotone), 0.04*1 -> max(0.06, 0.04)=0.06
        expect(holm([0.03, 0.01, 0.04, 0.02]).map(p => +p.toFixed(10))).toEqual([0.06, 0.04, 0.06, 0.06]);
    });

    it('caps at 1 and handles empty input', () => {
        expect(holm([0.5, 0.6])).toEqual([1, 1]);
        expect(holm([])).toEqual([]);
    });
});

describe('majority and mean', () => {
    it('votes 1, 0 or a 0.5 tie', () => {
        expect(majority([1, 1, 0])).toBe(1);
        expect(majority([0, 0, 1])).toBe(0);
        expect(majority([1, 0])).toBe(0.5);
    });

    it('averages', () => {
        expect(mean([1, 0, 0, 1])).toBe(0.5);
        expect(mean([])).toBeNaN();
    });
});

describe('clusterBootstrapCI', () => {
    const spread = new Map<string, number[]>(
        Array.from({ length: 20 }, (_, i) => [`c${i}`, [i % 4 === 0 ? -1 : 0, 0, i % 5 === 0 ? -1 : 0]]),
    );

    it('is deterministic for a seed and contains the mean', () => {
        const a = clusterBootstrapCI(spread, { seed: 7 });
        expect(clusterBootstrapCI(spread, { seed: 7 })).toEqual(a);
        const all = [...spread.values()].flat();
        expect(a[0]).toBeLessThanOrEqual(mean(all));
        expect(a[1]).toBeGreaterThanOrEqual(mean(all));
    });

    it('is wider when the same diffs sit in few clusters', () => {
        const all = [...spread.values()].flat();
        const lumped = new Map<string, number[]>([
            ['x', all.filter(d => d < 0)],
            ['y', all.filter(d => d === 0).slice(0, 30)],
            ['z', all.filter(d => d === 0).slice(30)],
        ]);
        const perCase = new Map(all.map((d, i) => [`case${i}`, [d]]));
        const [lo1, hi1] = clusterBootstrapCI(perCase);
        const [lo2, hi2] = clusterBootstrapCI(lumped);
        expect(hi2 - lo2).toBeGreaterThan(hi1 - lo1);
    });

    it('returns NaN bounds without data', () => {
        expect(clusterBootstrapCI(new Map())).toEqual([NaN, NaN]);
    });
});
