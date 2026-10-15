import fs from 'fs';
import path from 'path';
import { parse } from 'yaml';
import type { Comparison, FieldComparison } from './compare.js';

export type GateRule = {
    maxHumanHoldoutRegressions: number;
    noiseFloorPp: number;
    maxCostIncreasePct: number;
    maxModeFireIncreaseP: number;
    /** Fields whose regressions never decide the gate, e.g. ones scored against a drafted baseline. */
    ignoreFields?: string[];
    /** Fewer cases with human-tier holdout values than this and the gate can't pass: too little truth to decide on. */
    minHumanHoldoutCases?: number;
};

export const DEFAULT_GATE: GateRule = { maxHumanHoldoutRegressions: 0, noiseFloorPp: 0, maxCostIncreasePct: 10, maxModeFireIncreaseP: 0.05 };

const NUMERIC_KEYS = ['maxHumanHoldoutRegressions', 'noiseFloorPp', 'maxCostIncreasePct', 'maxModeFireIncreaseP', 'minHumanHoldoutCases'] as const;

/** evals/gates/<suite>.yaml merged over DEFAULT_GATE; a missing file means the default gate. */
export function loadGate(suite: string, root: string = process.cwd()): GateRule {
    const file = path.join(root, 'evals', 'gates', `${suite}.yaml`);
    if (!fs.existsSync(file)) return { ...DEFAULT_GATE };
    const raw: unknown = parse(fs.readFileSync(file, 'utf8')) ?? {};
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${file}: expected a mapping`);
    const doc = raw as Record<string, unknown>;
    const rule: GateRule = { ...DEFAULT_GATE };
    for (const [key, value] of Object.entries(doc)) {
        if ((NUMERIC_KEYS as readonly string[]).includes(key)) {
            if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${file}: ${key} must be a number`);
            rule[key as (typeof NUMERIC_KEYS)[number]] = value;
        } else if (key === 'ignoreFields') {
            if (!Array.isArray(value) || !value.every(v => typeof v === 'string')) throw new Error(`${file}: ignoreFields must be a list of field names`);
            rule.ignoreFields = value;
        } else {
            throw new Error(`${file}: unknown gate key '${key}'`);
        }
    }
    return rule;
}

export type GateResult = { verdict: 'PASS' | 'FAIL' | 'NEEDS_REVIEW'; reasons: string[] };

const ERROR_RATE_LIMIT = 0.05;

const topClusters = (f: FieldComparison) =>
    f.regressionsByCluster.slice(0, 3).map(r => `${r.cluster} (${r.count})`).join(', ');

export function evaluateGate(c: Comparison, rule: GateRule): GateResult {
    const reasons: string[] = [];
    let fail = false;
    let needsReview = false;
    const ignored = new Set(rule.ignoreFields ?? []);
    const decides = c.fields.filter(f => !ignored.has(f.field));

    const humanHoldout = decides.filter(f => f.tierGroup === 'human' && f.split === 'holdout');
    const totalHumanRegressions = humanHoldout.reduce((s, f) => s + f.regressedCases.length, 0);
    if (totalHumanRegressions > rule.maxHumanHoldoutRegressions) {
        for (const f of humanHoldout.filter(f => f.regressedCases.length > 0)) {
            // The regression rate, not the net Δ: improvements elsewhere in the field would
            // otherwise cancel a regression out and let it through.
            const regressedPp = (f.regressedCases.length / f.n) * 100;
            if (regressedPp > rule.noiseFloorPp) {
                fail = true;
                reasons.push(`${f.field}: ${f.regressedCases.length} human-tier holdout regression(s) (${regressedPp.toFixed(1)} pp of ${f.n}), Δ ${(f.delta * 100).toFixed(1)} pp; top clusters: ${topClusters(f)}`);
            } else {
                reasons.push(`${f.field}: ${f.regressedCases.length} human-tier holdout regression(s) (${regressedPp.toFixed(1)} pp of ${f.n}) within the ${rule.noiseFloorPp} pp noise floor (Δ ${(f.delta * 100).toFixed(1)} pp)`);
            }
        }
    }

    // Drafted values measure change against a baseline, never correctness: agreement with
    // them is no evidence that B is right, so a gate with no human truth can't pass.
    if (humanHoldout.length === 0) {
        needsReview = true;
        const unbacked = decides.filter(f => f.split === 'all' && f.regressedCases.length > 0);
        reasons.push(unbacked.length
            ? `no human-tier holdout values: regressions decided only by drafted labels or dev cases (${unbacked.map(f => `${f.field}/${f.tierGroup} ${f.regressedCases.length}`).join(', ')}); review a batch before gating`
            : 'no human-tier holdout values: the scores only say how far B moved from a drafted baseline; review a batch before gating');
    } else {
        const humanCases = Math.max(...humanHoldout.map(f => f.cases));
        if (rule.minHumanHoldoutCases !== undefined && humanCases < rule.minHumanHoldoutCases) {
            needsReview = true;
            reasons.push(`only ${humanCases} case(s) carry human-tier holdout values; this gate needs ${rule.minHumanHoldoutCases}`);
        }
    }

    const unscored = c.unscoredByB.filter(u => !ignored.has(u.field));
    if (unscored.length) {
        fail = true;
        const shown = unscored.slice(0, 10).map(u => `${u.field} ${u.unit} (${u.why})`).join(', ');
        reasons.push(`B did not score ${unscored.length} human-tier holdout unit(s) that A scored: ${shown}${unscored.length > 10 ? `, +${unscored.length - 10} more` : ''}`);
    }

    if (c.costA > 0) {
        const increasePct = ((c.costB - c.costA) / c.costA) * 100;
        if (increasePct > rule.maxCostIncreasePct) {
            fail = true;
            reasons.push(`cost +${increasePct.toFixed(1)}% per attempt ($${c.costA.toFixed(4)} → $${c.costB.toFixed(4)}), limit +${rule.maxCostIncreasePct}%`);
        }
    }

    for (const [mode, r] of Object.entries(c.checkFireRates ?? {})) {
        if (r.b > r.a && r.p < rule.maxModeFireIncreaseP) {
            fail = true;
            reasons.push(`${mode} fires more often: ${(r.a * 100).toFixed(1)}% → ${(r.b * 100).toFixed(1)}% (p=${r.p.toFixed(3)})`);
        }
    }

    if (c.errorsB > c.errorsA) {
        const rate = c.attemptsB > 0 ? c.errorsB / c.attemptsB : 0;
        const tooMany = rate > ERROR_RATE_LIMIT;
        fail ||= tooMany;
        reasons.push(`errors ${c.errorsA} → ${c.errorsB} (${(rate * 100).toFixed(1)}% of B's attempts${tooMany ? `, over ${ERROR_RATE_LIMIT * 100}%` : ''})`);
    }

    return { verdict: fail ? 'FAIL' : needsReview ? 'NEEDS_REVIEW' : 'PASS', reasons };
}
