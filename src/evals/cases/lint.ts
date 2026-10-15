import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { HUMAN_TIERS, type Tier } from '../types.js';
import { caseFiles, caseRoots, caseStem, casesRoot } from './caseStore.js';

export type LintIssue = { file: string; rule: string; message: string };

const TIERS: readonly Tier[] = ['adjudicated', 'imported', 'drafted', 'contested'];
const TIER_RANK: Record<Tier, number> = { adjudicated: 2, imported: 2, drafted: 1, contested: 0 };

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown) => Array.isArray(v) && v.every(x => typeof x === 'string');

function schemaErrors(raw: unknown, suite: string, stem: string): string[] {
    if (!isObject(raw)) return ['not a JSON object'];
    const errors: string[] = [];
    const expectedId = `${suite}/${stem}`;
    if (raw.id !== expectedId) errors.push(`id must be "${expectedId}", got ${JSON.stringify(raw.id)}`);
    if (raw.suite !== suite) errors.push(`suite must be "${suite}", got ${JSON.stringify(raw.suite)}`);
    if (raw.split !== 'dev' && raw.split !== 'holdout') errors.push(`split must be dev|holdout, got ${JSON.stringify(raw.split)}`);
    if (!('input' in raw) || raw.input === undefined) errors.push('input is required');
    if (raw.replay !== undefined && raw.replay !== null && typeof raw.replay !== 'string') errors.push('replay must be a string or null');
    if (typeof raw.cluster !== 'string' || !raw.cluster) errors.push('cluster must be a non-empty string');
    if (!isStringArray(raw.tags)) errors.push('tags must be an array of strings');
    if (raw.guards !== undefined && !isStringArray(raw.guards)) errors.push('guards must be an array of strings');
    if (raw.note !== undefined && typeof raw.note !== 'string') errors.push('note must be a string');
    if (raw.history !== undefined && !(Array.isArray(raw.history) && raw.history.every(h => isObject(h) && typeof h.at === 'string' && typeof h.change === 'string'))) {
        errors.push('history must be an array of { at, change }');
    }
    if (!isObject(raw.expect)) {
        errors.push('expect must be an object');
        return errors;
    }
    for (const [field, e] of Object.entries(raw.expect)) {
        if (!isObject(e)) { errors.push(`expect.${field} must be an object`); continue; }
        if (!('value' in e)) errors.push(`expect.${field}.value is required (null is a value)`);
        if (!TIERS.includes(e.tier as Tier)) errors.push(`expect.${field}.tier must be one of ${TIERS.join('|')}, got ${JSON.stringify(e.tier)}`);
        for (const key of ['by', 'at', 'source'] as const) {
            if (typeof e[key] !== 'string' || !e[key]) errors.push(`expect.${field}.${key} must be a non-empty string`);
        }
        for (const key of ['signal', 'reason', 'evidence'] as const) {
            if (e[key] !== undefined && typeof e[key] !== 'string') errors.push(`expect.${field}.${key} must be a string`);
        }
    }
    return errors;
}

function suites(root: string): string[] {
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
}

/** The content at `base` of the file at `rel` under `dir`, or null when it did not exist there. */
function atBase(dir: string, rel: string, base: string): unknown | null {
    try {
        const out = execFileSync('git', ['show', `${base}:./${rel}`], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        return JSON.parse(out);
    } catch {
        return null;
    }
}

function historyIssues(file: string, now: Json, before: unknown): LintIssue[] {
    if (!isObject(before)) return [];
    const issues: LintIssue[] = [];
    if (before.split !== now.split) {
        issues.push({ file, rule: 'split-immutable', message: `split changed ${before.split} → ${now.split}; a case keeps its split for life` });
    }
    const beforeExpect = isObject(before.expect) ? before.expect : {};
    const nowExpect = isObject(now.expect) ? now.expect : {};
    for (const [field, prev] of Object.entries(beforeExpect)) {
        if (isObject(prev) && HUMAN_TIERS.includes(prev.tier as Tier) && !(field in nowExpect)) {
            issues.push({ file, rule: 'tier-downgrade', message: `expect.${field} (${prev.tier}) was removed; mark it contested with a reason instead` });
        }
    }
    for (const [field, e] of Object.entries(nowExpect)) {
        const prev = beforeExpect[field];
        if (!isObject(e) || !isObject(prev)) continue;
        const from = prev.tier as Tier, to = e.tier as Tier;
        if (!(from in TIER_RANK) || !(to in TIER_RANK)) continue;
        if (TIER_RANK[to] < TIER_RANK[from] && !e.reason) {
            issues.push({ file, rule: 'tier-downgrade', message: `expect.${field} went ${from} → ${to} without a reason` });
        }
    }
    return issues;
}

/**
 * Checks every case file under the root (by default the committed and the private
 * case roots). With `gitBase`, also compares each file to its committed version
 * there: splits never change and tiers never drop silently.
 */
export function lintCases(root?: string, gitBase?: string): LintIssue[] {
    const base = casesRoot(root);
    if (gitBase && fs.existsSync(base)) {
        // An unknown ref would make every file look new, and so pass.
        try {
            execFileSync('git', ['rev-parse', '--verify', '--quiet', `${gitBase}^{commit}`], { cwd: base, stdio: 'ignore' });
        } catch {
            throw new Error(`git base "${gitBase}" is not a commit in the repository holding ${base}`);
        }
    }
    const issues: LintIssue[] = [];
    const seen = new Map<string, string>();
    const files = caseRoots(root).flatMap(r => suites(r).flatMap(suite => caseFiles(suite, r).map(file => ({ suite, file }))));
    for (const { suite, file } of files) {
        let raw: unknown;
        try {
            raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (err) {
            issues.push({ file, rule: 'parse', message: (err as Error).message });
            continue;
        }
        for (const message of schemaErrors(raw, suite, caseStem(file))) issues.push({ file, rule: 'schema', message });
        if (!isObject(raw)) continue;

        if (typeof raw.id === 'string') {
            const other = seen.get(raw.id);
            if (other) issues.push({ file, rule: 'unique-id', message: `id "${raw.id}" also used by ${other}` });
            else seen.set(raw.id, file);
        }
        if (isObject(raw.expect)) {
            for (const [field, e] of Object.entries(raw.expect)) {
                if (isObject(e) && e.tier === 'imported' && (typeof e.signal !== 'string' || !e.signal)) {
                    issues.push({ file, rule: 'imported-signal', message: `expect.${field} is imported but names no signal` });
                }
            }
        }
        if (gitBase) issues.push(...historyIssues(file, raw, atBase(path.dirname(file), path.basename(file), gitBase)));
    }
    if (gitBase && fs.existsSync(base)) issues.push(...deletedHoldoutIssues(base, gitBase));
    return issues;
}

/** A holdout case deleted since `gitBase`: removing it would shrink the gate's evidence without a trace. */
function deletedHoldoutIssues(root: string, gitBase: string): LintIssue[] {
    const listing = execFileSync('git', ['ls-tree', '-r', '--name-only', gitBase, '--', '.'], { cwd: root, encoding: 'utf8' });
    return listing.split('\n').filter(f => f.endsWith('.json') && !fs.existsSync(path.join(root, f))).flatMap(f => {
        const before = atBase(root, f, gitBase);
        return isObject(before) && before.split === 'holdout'
            ? [{ file: path.join(root, f), rule: 'holdout-deleted', message: `holdout case ${String(before.id)} existed at ${gitBase}; a holdout case is never deleted` }]
            : [];
    });
}
