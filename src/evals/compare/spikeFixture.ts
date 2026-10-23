/**
 * Test-only adapter: loads the 2026-10-08 eval spike's run directories (written by its run.ts)
 * as ComparableRuns plus Case objects, so compare.ts can be checked against compare.py's report.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { Case, ErrorRow, FieldOutcome, ResultRow, Tier } from '../types.js';
import type { ComparableRun } from './compare.js';

type SpikeRow = {
    case_id: string; rep: number; model: string; tags: string[];
    provenance: Record<string, string>; scores: Record<string, string>;
    output: unknown; usage: ResultRow['usage']; cost_usd: number; latency_ms: number; status: string;
};

const OUTCOME: Record<string, FieldOutcome> = {
    agree: 'agree', 'true-negative': 'agree',
    disagree: 'disagree', 'false-positive': 'disagree',
    missing: 'missing', unread: 'missing',
};

function tierOf(provenance: string | undefined, score: string): Tier {
    if (score === 'contested' || provenance === 'false') return 'contested';
    return provenance === 'human' || provenance === 'adjudicated' ? 'adjudicated' : 'drafted';
}

/** The spike lives untracked in the main checkout, which a worktree doesn't see. */
export function spikeRunsDir(): string | null {
    const rel = '.extraction-survey/eval-spike-2026-10-08/runs';
    const roots = [process.env.EVAL_SPIKE_DIR, path.resolve(rel)];
    try {
        const common = execSync('git rev-parse --path-format=absolute --git-common-dir', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        roots.push(path.join(path.dirname(common), rel));
    } catch { /* not a git checkout */ }
    return roots.find((d): d is string => !!d && fs.existsSync(path.join(d, 'reading'))) ?? null;
}

const readJsonl = <T>(file: string): T[] => fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as T)
    : [];

export function loadSpikeRun(dir: string, suite: string): { run: ComparableRun; spikeRows: SpikeRow[] } {
    const man = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    const spikeRows = readJsonl<SpikeRow>(path.join(dir, 'results.jsonl'));
    const rows: ResultRow[] = spikeRows.map(r => ({
        caseId: r.case_id, rep: r.rep,
        fields: Object.fromEntries(Object.entries(r.scores).map(([f, o]) => [f, OUTCOME[o] ?? 'unscorable'])),
        checks: {}, usage: r.usage, costUsd: r.cost_usd, latencyMs: r.latency_ms,
        servedModels: [r.model], status: 'ok', traceId: '', output: r.output,
    }));
    const errors: ErrorRow[] = readJsonl<{ case_id: string; rep: number; error: string }>(path.join(dir, 'errors.jsonl'))
        .map(e => ({ caseId: e.case_id, rep: e.rep, errorClass: 'error', message: e.error, costUsd: 0 }));
    return {
        spikeRows,
        run: {
            rows, errors,
            manifest: {
                runId: man.variant, suite, variant: { name: man.variant, overrides: {} },
                split: 'all', reps: man.reps, cases: man.cases, caseSetSha: man.fixtureSha,
                gitRef: man.appCommit, gitDirty: man.appDirty, startedAt: man.startedAt, finishedAt: man.finishedAt,
                spentUsd: man.spentUsd, status: 'complete',
            },
        },
    };
}

/** Cases from the rows' labels: every case is 'dev' (the spike had no holdout). */
export function spikeCases(suite: string, rows: SpikeRow[], clusterOf: (tags: string[]) => string): Case[] {
    const byId = new Map<string, Case>();
    for (const r of rows) {
        if (byId.has(r.case_id)) continue;
        const expect: Case['expect'] = {};
        for (const [field, score] of Object.entries(r.scores)) {
            expect[field] = { value: null, tier: tierOf(r.provenance[field], score), by: 'spike', at: '2026-10-08', source: 'spike' };
        }
        byId.set(r.case_id, {
            id: r.case_id, suite, split: 'dev', input: null, expect, cluster: clusterOf(r.tags), tags: r.tags,
        });
    }
    return [...byId.values()];
}
