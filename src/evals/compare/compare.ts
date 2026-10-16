import { HUMAN_TIERS } from '../types.js';
import type { Case, ErrorRow, FieldOutcome, ResultRow, RunManifest, Split } from '../types.js';
import { clusterBootstrapCI, exactMcNemarP, holm, majority, mean } from './stats.js';

export type ComparableRun = { manifest: RunManifest; rows: ResultRow[]; errors: ErrorRow[] };

export type TierGroup = 'human' | 'drafted';
export type SplitScope = Split | 'all';

export type FieldComparison = {
    field: string; tierGroup: TierGroup; split: SplitScope;
    /** Scored units (cases, or items within cases for item fields) and the distinct cases they come from. */
    n: number; cases: number; accA: number; accB: number; delta: number; ci: [number, number];
    aOnlyRight: number; bOnlyRight: number; p: number; pAdj: number;
    /** [cases whose outcome differs across reps, cases with >1 rep] */
    flipsA: [number, number]; flipsB: [number, number];
    /** Cases whose majority went from right (A) to wrong (B), grouped by cluster, largest first. */
    regressionsByCluster: Array<{ cluster: string; count: number }>;
    regressedCases: string[];
};

export type Comparison = {
    suite: string; a: RunManifest; b: RunManifest; fields: FieldComparison[];
    /** Mean USD per attempted (case, rep), errors included, so runs with different reps or case counts compare. */
    costA: number; costB: number;
    errorsA: number; errorsB: number; casesA: number; casesB: number;
    /** (case, rep) pairs tried, errored or not. */
    attemptsA: number; attemptsB: number;
    /**
     * Human-tier holdout units A scored and B did not: pairing drops them, so without this a B
     * that fails on exactly the cases it would regress compares as unchanged.
     */
    unscoredByB: Array<{ field: string; unit: string; why: 'errored' | 'truncated' | 'unscored' }>;
    noiseFloorPp?: number;
    checkFireRates?: Record<string, { a: number; b: number; p: number }>;
    /** Per field family, how often each finer verdict (ResultRow.detail) occurs in A and in B. */
    detailTallies?: Record<string, { a: Record<string, number>; b: Record<string, number> }>;
};

/**
 * Item fields ("subject[#3 …]") are scored as one family ("subject") whose units are
 * (case, item): a meeting holds many subjects, and per-subject fields would each have n=1.
 */
const ITEM_FIELD = /^([^[\]]+)\[(.+)\]$/;
export function fieldFamily(field: string): { family: string; item?: string } {
    const m = ITEM_FIELD.exec(field);
    return m ? { family: m[1], item: m[2] } : { family: field };
}

/** What the statistics pair and cluster: a case, or one item within a case. */
type Unit = { id: string; caseId: string; field: string };
type Scored = { family: string; units: Map<string, Unit>; reps: Map<string, number[]> };

const SCORE: Partial<Record<FieldOutcome, number>> = { agree: 1, disagree: 0, missing: 0 };
const TIER_GROUPS: TierGroup[] = ['human', 'drafted'];
const SPLITS: SplitScope[] = ['holdout', 'dev', 'all'];

/** family → unit → per-rep 0/1. Truncated responses are shown elsewhere but never averaged in as wrong. */
function scoresByField(rows: ResultRow[]): Map<string, Scored> {
    const out = new Map<string, Scored>();
    for (const row of rows) {
        if (row.status === 'truncated') continue;
        for (const [field, outcome] of Object.entries(row.fields)) {
            const v = SCORE[outcome];
            if (v === undefined) continue;
            const { family, item } = fieldFamily(field);
            const id = item === undefined ? row.caseId : `${row.caseId}[${item}]`;
            let scored = out.get(family);
            if (!scored) out.set(family, (scored = { family, units: new Map(), reps: new Map() }));
            scored.units.set(id, { id, caseId: row.caseId, field });
            const reps = scored.reps.get(id);
            if (reps) reps.push(v); else scored.reps.set(id, [v]);
        }
    }
    return out;
}

function detailTallies(a: ResultRow[], b: ResultRow[]): Comparison['detailTallies'] {
    const out: NonNullable<Comparison['detailTallies']> = {};
    for (const [side, rows] of [['a', a], ['b', b]] as const) {
        for (const row of rows) {
            for (const [field, detail] of Object.entries(row.detail ?? {})) {
                const family = fieldFamily(field).family;
                const verdict = detail.split(' ')[0];
                const t = (out[family] ??= { a: {}, b: {} })[side];
                t[verdict] = (t[verdict] ?? 0) + 1;
            }
        }
    }
    return Object.keys(out).length ? out : undefined;
}

function tierGroupOf(c: Case, field: string): TierGroup | null {
    const tier = c.expect[field]?.tier;
    if (tier === 'contested') return null;
    // Derived fields some suites score have no expect entry of their own: never human-backed.
    return tier && HUMAN_TIERS.includes(tier) ? 'human' : 'drafted';
}

function flips(byCase: number[][]): [number, number] {
    const multi = byCase.filter(reps => reps.length > 1);
    return [multi.filter(reps => new Set(reps).size > 1).length, multi.length];
}

type ScoredUnit = { id: string; caseId: string; cluster: string; split: Split };

function compareSubset(field: string, tierGroup: TierGroup, split: SplitScope, subset: ScoredUnit[],
    a: Map<string, number[]>, b: Map<string, number[]>): FieldComparison {
    const diffsByCluster = new Map<string, number[]>();
    const regressions = new Map<string, number>();
    const regressedCases: string[] = [];
    let aOnlyRight = 0;
    let bOnlyRight = 0;
    for (const c of subset) {
        const ra = a.get(c.id)!;
        const rb = b.get(c.id)!;
        const diffs = diffsByCluster.get(c.cluster);
        const d = mean(rb) - mean(ra);
        if (diffs) diffs.push(d); else diffsByCluster.set(c.cluster, [d]);
        const ma = majority(ra);
        const mb = majority(rb);
        if (ma === 1 && mb === 0) {
            aOnlyRight++;
            regressedCases.push(c.id);
            regressions.set(c.cluster, (regressions.get(c.cluster) ?? 0) + 1);
        } else if (ma === 0 && mb === 1) {
            bOnlyRight++;
        }
    }
    const accA = mean(subset.map(c => mean(a.get(c.id)!)));
    const accB = mean(subset.map(c => mean(b.get(c.id)!)));
    const p = exactMcNemarP(aOnlyRight, bOnlyRight);
    return {
        field, tierGroup, split, n: subset.length, cases: new Set(subset.map(c => c.caseId)).size, accA, accB, delta: accB - accA,
        ci: clusterBootstrapCI(diffsByCluster), aOnlyRight, bOnlyRight, p, pAdj: p,
        flipsA: flips(subset.map(c => a.get(c.id)!)), flipsB: flips(subset.map(c => b.get(c.id)!)),
        regressionsByCluster: [...regressions].map(([cluster, count]) => ({ cluster, count }))
            .sort((x, y) => y.count - x.count || x.cluster.localeCompare(y.cluster)),
        regressedCases: regressedCases.sort(),
    };
}

/** Per case: 1 if the mode fired on the majority of reps with a known outcome. */
function firesByMode(rows: ResultRow[]): Map<string, Map<string, number[]>> {
    const out = new Map<string, Map<string, number[]>>();
    for (const row of rows) {
        for (const [mode, outcome] of Object.entries(row.checks)) {
            if (outcome === 'unknown') continue;
            let byCase = out.get(mode);
            if (!byCase) out.set(mode, (byCase = new Map()));
            const v = outcome === 'fail' ? 1 : 0;
            const reps = byCase.get(row.caseId);
            if (reps) reps.push(v); else byCase.set(row.caseId, [v]);
        }
    }
    return out;
}

function checkFireRates(a: ResultRow[], b: ResultRow[]): Comparison['checkFireRates'] {
    const fa = firesByMode(a);
    const fb = firesByMode(b);
    const out: NonNullable<Comparison['checkFireRates']> = {};
    for (const mode of new Set([...fa.keys(), ...fb.keys()])) {
        const ca = fa.get(mode) ?? new Map<string, number[]>();
        const cb = fb.get(mode) ?? new Map<string, number[]>();
        const common = [...ca.keys()].filter(id => cb.has(id));
        if (common.length === 0) continue;
        // A tie counts as fired: a mode that fires on half the repeats is not under control.
        const fired = (reps: number[]) => (majority(reps) >= 0.5 ? 1 : 0);
        const aOnly = common.filter(id => fired(ca.get(id)!) === 1 && fired(cb.get(id)!) === 0).length;
        const bOnly = common.filter(id => fired(ca.get(id)!) === 0 && fired(cb.get(id)!) === 1).length;
        out[mode] = {
            a: mean(common.map(id => fired(ca.get(id)!))),
            b: mean(common.map(id => fired(cb.get(id)!))),
            p: exactMcNemarP(aOnly, bOnly),
        };
    }
    return Object.keys(out).length ? out : undefined;
}

function costPerAttempt(run: ComparableRun): number {
    const attempts = run.rows.length + run.errors.length;
    if (attempts === 0) return 0;
    return [...run.rows, ...run.errors].reduce((s, r) => s + r.costUsd, 0) / attempts;
}

function unscoredByB(sa: Map<string, Scored>, sb: Map<string, Scored>, b: ComparableRun, caseById: Map<string, Case>): Comparison['unscoredByB'] {
    const errored = new Set(b.errors.map(e => e.caseId));
    const truncated = new Set(b.rows.filter(r => r.status === 'truncated').map(r => r.caseId));
    const out: Comparison['unscoredByB'] = [];
    for (const [field, fa] of sa) {
        for (const unit of fa.units.values()) {
            const c = caseById.get(unit.caseId);
            if (!c || c.split !== 'holdout' || tierGroupOf(c, unit.field) !== 'human' || sb.get(field)?.reps.has(unit.id)) continue;
            const why = errored.has(unit.caseId) ? 'errored' : truncated.has(unit.caseId) ? 'truncated' : 'unscored';
            out.push({ field, unit: unit.id, why });
        }
    }
    return out.sort((x, y) => x.field.localeCompare(y.field) || x.unit.localeCompare(y.unit));
}

function distinctCases(run: ComparableRun): number {
    return new Set([...run.rows.map(r => r.caseId), ...run.errors.map(e => e.caseId)]).size;
}

export function compareRuns(a: ComparableRun, b: ComparableRun, cases: Case[]): Comparison {
    const caseById = new Map(cases.map(c => [c.id, c]));
    const sa = scoresByField(a.rows);
    const sb = scoresByField(b.rows);
    const fieldNames = [...new Set([...sa.keys(), ...sb.keys()])];

    const fields: FieldComparison[] = [];
    for (const field of fieldNames) {
        const fa = sa.get(field);
        const fb = sb.get(field);
        if (!fa || !fb) continue;
        const groups = new Map<TierGroup, ScoredUnit[]>(TIER_GROUPS.map(g => [g, []]));
        for (const unit of fa.units.values()) {
            const c = caseById.get(unit.caseId);
            if (!c || !fb.reps.has(unit.id)) continue;
            const g = tierGroupOf(c, unit.field);
            if (g) groups.get(g)!.push({ id: unit.id, caseId: unit.caseId, cluster: c.cluster, split: c.split });
        }
        for (const tierGroup of TIER_GROUPS) {
            for (const split of SPLITS) {
                const subset = groups.get(tierGroup)!.filter(c => split === 'all' || c.split === split);
                if (subset.length) fields.push(compareSubset(field, tierGroup, split, subset, fa.reps, fb.reps));
            }
        }
    }

    for (const tierGroup of TIER_GROUPS) {
        for (const split of SPLITS) {
            const family = fields.filter(f => f.tierGroup === tierGroup && f.split === split);
            holm(family.map(f => f.p)).forEach((pAdj, i) => { family[i].pAdj = pAdj; });
        }
    }

    // Approximation of self-noise until an incumbent-vs-incumbent run exists: the largest share of
    // cases whose outcome changes between A's own repeats. It is an upper bound on how much a
    // per-case Δ can move from repetition alone, not the spread of the mean Δ, so it errs lenient.
    let noiseFloorPp: number | undefined;
    if (a.manifest.reps >= 2) {
        const shares = fields.filter(f => f.split === 'all' && f.flipsA[1] > 0).map(f => (100 * f.flipsA[0]) / f.flipsA[1]);
        noiseFloorPp = shares.length ? Math.max(...shares) : 0;
    }

    return {
        suite: b.manifest.suite, a: a.manifest, b: b.manifest, fields,
        costA: costPerAttempt(a), costB: costPerAttempt(b),
        errorsA: a.errors.length, errorsB: b.errors.length,
        casesA: distinctCases(a), casesB: distinctCases(b),
        attemptsA: a.rows.length + a.errors.length, attemptsB: b.rows.length + b.errors.length,
        unscoredByB: unscoredByB(sa, sb, b, caseById),
        noiseFloorPp,
        checkFireRates: checkFireRates(a.rows, b.rows),
        detailTallies: detailTallies(a.rows, b.rows),
    };
}

const pct = (x: number) => (Number.isNaN(x) ? '  n/a' : x.toFixed(3));
const signed = (x: number) => (Number.isNaN(x) ? 'n/a' : `${x >= 0 ? '+' : ''}${x.toFixed(3)}`);
const runLabel = (m: RunManifest) => `${m.variant.name} (${m.runId}, ${m.reps} rep${m.reps === 1 ? '' : 's'})`;

function verdictOf(f: FieldComparison, noiseFloorPp: number): string {
    const [lo, hi] = f.ci;
    const direction = f.delta > 0 ? 'B better' : 'B worse';
    if (Math.abs(f.delta) * 100 <= noiseFloorPp) return 'no detectable difference';
    // Cases that share a cluster are not independent: a paired test can be significant while
    // the cluster bootstrap still spans 0 because one or two clusters hold every change.
    if (lo <= 0 && hi >= 0) return f.pAdj < 0.05 ? `${direction}, concentrated in few clusters (paired test significant, clustered CI spans 0)` : 'no detectable difference';
    return direction;
}

/** Splits worth printing: all three when both exist, otherwise the single split present. */
function splitsToShow(entries: FieldComparison[]): FieldComparison[] {
    const by = (s: SplitScope) => entries.find(e => e.split === s);
    const holdout = by('holdout');
    const dev = by('dev');
    if (holdout && dev) return [by('all')!, holdout, dev];
    return [holdout ?? dev ?? by('all')!].filter(Boolean);
}

export function formatComparison(c: Comparison, opts: { showHoldoutCases?: boolean } = {}): string {
    const out: string[] = [];
    out.push(`# ${c.suite}: A = ${runLabel(c.a)}  vs  B = ${runLabel(c.b)}`);
    if (c.a.caseSetSha !== c.b.caseSetSha) out.push('  ! case sets differ: only cases scored in both runs are compared');
    out.push(`  cases  A ${c.casesA}  B ${c.casesB}`);
    out.push(`  errors A ${c.errorsA}  B ${c.errorsB}`);
    if (c.unscoredByB.length) {
        const by = (why: string) => c.unscoredByB.filter(u => u.why === why).length;
        out.push(`  ! B left ${c.unscoredByB.length} human-tier holdout unit(s) A scored unscored: ${by('errored')} errored, ${by('truncated')} truncated, ${by('unscored')} not scored`);
    }
    const costChange = c.costA > 0 ? ((c.costB - c.costA) / c.costA) * 100 : NaN;
    const costPct = Number.isNaN(costChange) ? '' : ` (${costChange >= 0 ? '+' : ''}${costChange.toFixed(1)}%)`;
    out.push(`  cost   A $${c.costA.toFixed(4)}/attempt  B $${c.costB.toFixed(4)}/attempt${costPct}`);
    if (c.noiseFloorPp !== undefined) out.push(`  noise floor ≈ ${c.noiseFloorPp.toFixed(1)} pp (largest rep-to-rep flip share of A)`);

    const tally = (t: Record<string, number>) => Object.entries(t).sort(([x], [y]) => x.localeCompare(y)).map(([k, n]) => `${k} ${n}`).join(' · ') || '-';
    for (const field of [...new Set(c.fields.map(f => f.field))]) {
        out.push('', `## ${field}`);
        const d = c.detailTallies?.[field];
        if (d) out.push(`  verdicts (all reps)  A ${tally(d.a)}   B ${tally(d.b)}`);
        for (const tierGroup of TIER_GROUPS) {
            const entries = splitsToShow(c.fields.filter(f => f.field === field && f.tierGroup === tierGroup));
            if (!entries.length) continue;
            out.push(`  labels=${tierGroup}${tierGroup === 'drafted' ? ' (regression only: agreement with a drafted baseline, not correctness)' : ''}`);
            for (const f of entries) {
                out.push(`    ${f.split.padEnd(7)} n=${String(f.n).padStart(3)}  acc ${pct(f.accA)} → ${pct(f.accB)}  Δ ${signed(f.delta)} [95% CI ${signed(f.ci[0])}, ${signed(f.ci[1])}]  ${verdictOf(f, c.noiseFloorPp ?? 0)}`);
                out.push(`            A-only-right ${f.aOnlyRight}, B-only-right ${f.bOnlyRight}, p=${f.p.toFixed(3)} (Holm ${f.pAdj.toFixed(3)}); flips A ${f.flipsA[0]}/${f.flipsA[1]}, B ${f.flipsB[0]}/${f.flipsB[1]}`);
                if (f.regressionsByCluster.length) {
                    out.push(`            regressions by cluster: ${f.regressionsByCluster.slice(0, 5).map(r => `${r.cluster} ${r.count}`).join(', ')}`);
                }
                // Holdout ids stay hidden so nobody tunes against them; 'all' contains holdout cases too.
                const showIds = f.split === 'dev' || (f.split === 'holdout' && opts.showHoldoutCases);
                if (showIds && f.regressedCases.length) out.push(`            regressed: ${f.regressedCases.join(', ')}`);
            }
        }
    }

    if (c.checkFireRates) {
        out.push('', '## failure modes (fire rate A → B)');
        for (const [mode, r] of Object.entries(c.checkFireRates)) {
            out.push(`  ${mode}: ${pct(r.a)} → ${pct(r.b)}  p=${r.p.toFixed(3)}`);
        }
    }
    return out.join('\n');
}
