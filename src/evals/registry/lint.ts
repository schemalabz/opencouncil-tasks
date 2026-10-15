import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import type { LintIssue } from '../cases/lint.js';
import { detectorCaseFiles, modeFiles, modeStem, modesDir, readDetectorCase, readModeFile, repoRoot } from './registry.js';
import {
    DECISIONS, GUARDED_STATUSES, IMPACTS, ISSUE_STATUSES, MODE_STATUSES, RELATION_TYPES, SCOPES, SEVERITIES,
    type DetectorCase, type FailureMode,
} from './schema.js';

export type { LintIssue };

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

const ID = /^FM-\d{4}$/;
const SLUG = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

function oneOf(raw: Json, key: string, allowed: readonly string[], required: boolean): string[] {
    const v = raw[key];
    if (v === undefined) return required ? [`${key} is required`] : [];
    return allowed.includes(v as string) ? [] : [`${key} must be one of ${allowed.join('|')}, got ${JSON.stringify(v)}`];
}

function schemaErrors(raw: Json): string[] {
    const errors: string[] = [];
    for (const key of ['id', 'slug', 'title', 'definition'] as const) {
        if (!nonEmpty(raw[key])) errors.push(`${key} must be a non-empty string`);
    }
    if (!nonEmpty(raw.suite) && !(Array.isArray(raw.suite) && raw.suite.length > 0 && raw.suite.every(nonEmpty))) {
        errors.push('suite must be a non-empty string or a non-empty list of them');
    }
    for (const key of ['boundary', 'issue', 'alert', 'reason'] as const) {
        if (raw[key] !== undefined && !nonEmpty(raw[key])) errors.push(`${key} must be a non-empty string`);
    }
    errors.push(
        ...oneOf(raw, 'scope', SCOPES, true),
        ...oneOf(raw, 'severity', SEVERITIES, true),
        ...oneOf(raw, 'impact', IMPACTS, true),
        ...oneOf(raw, 'status', MODE_STATUSES, true),
        ...oneOf(raw, 'decision', DECISIONS, false),
    );
    if (raw.related !== undefined && !(Array.isArray(raw.related) && raw.related.every(r => isObject(r) && RELATION_TYPES.includes(r.type as never) && nonEmpty(r.id)))) {
        errors.push(`related must be a list of { type: ${RELATION_TYPES.join('|')}, id }`);
    }
    const d = raw.detector;
    if (d !== undefined) {
        if (!isObject(d)) errors.push('detector must be an object');
        else if (d.kind === 'code') {
            if (!nonEmpty(d.module)) errors.push('detector.module must be a non-empty string');
            if (d.export !== undefined && !nonEmpty(d.export)) errors.push('detector.export must be a non-empty string');
        } else if (d.kind === 'judge') {
            if (!nonEmpty(d.prompt)) errors.push('detector.prompt must be a non-empty string');
            if (!nonEmpty(d.model)) errors.push('detector.model must be a non-empty string');
            if (typeof d.sample !== 'number' || d.sample < 0 || d.sample > 1) errors.push('detector.sample must be a number in [0, 1]');
            const c = d.calibration;
            if (c !== undefined && !(isObject(c) && typeof c.tpr === 'number' && typeof c.tnr === 'number' && typeof c.n === 'number' && nonEmpty(c.at))) {
                errors.push('detector.calibration must be { tpr, tnr, n, at }');
            }
        } else errors.push(`detector.kind must be code|judge, got ${JSON.stringify(d.kind)}`);
    }
    return errors;
}

function lifecycleIssues(file: string, mode: FailureMode, cases: DetectorCase[], root: string): LintIssue[] {
    const issues: LintIssue[] = [];
    const add = (rule: string, message: string) => issues.push({ file, rule, message });

    if (ISSUE_STATUSES.includes(mode.status) && !mode.issue) add('issue-required', `status ${mode.status} requires an issue link`);

    if (GUARDED_STATUSES.includes(mode.status)) {
        if (!mode.detector) add('guarded-evidence', `status ${mode.status} requires a detector`);
        for (const kind of ['must-fire', 'must-not-fire'] as const) {
            if (!cases.some(c => c.kind === kind)) add('guarded-evidence', `status ${mode.status} requires at least one ${kind} detector case`);
        }
        if (mode.detector?.kind === 'judge' && !(mode.detector.calibration && mode.detector.calibration.n >= 30)) {
            add('judge-calibration', `a judge at ${mode.status} needs calibration on n ≥ 30 labelled examples`);
        }
    }

    if (mode.status === 'retired' && !(mode.related?.length || mode.reason)) add('retired-successor', 'a retired mode needs `related` or a `reason`');

    if (mode.detector?.kind === 'code' && !fs.existsSync(path.resolve(root, mode.detector.module))) {
        add('detector-missing', `detector module ${mode.detector.module} does not exist`);
    }
    if (mode.detector?.kind === 'judge' && !fs.existsSync(path.resolve(root, mode.detector.prompt))) {
        add('detector-missing', `judge prompt ${mode.detector.prompt} does not exist`);
    }
    return issues;
}

function git(root: string, args: string[]): string | null {
    try {
        return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
        return null;
    }
}

/** id → slug of every entry at `base`. */
function modesAtBase(root: string, base: string): Map<string, { slug: string; file: string }> {
    const dir = path.relative(root, modesDir(root));
    const listing = git(root, ['ls-tree', '--name-only', base, '--', `${dir}/`]) ?? '';
    const out = new Map<string, { slug: string; file: string }>();
    for (const file of listing.split('\n').filter(f => f.endsWith('.yaml'))) {
        const text = git(root, ['show', `${base}:./${file}`]);
        if (text === null) continue;
        try {
            const raw = YAML.parse(text);
            if (isObject(raw) && typeof raw.id === 'string' && typeof raw.slug === 'string') out.set(raw.id, { slug: raw.slug, file });
        } catch { /* an unparseable old entry has nothing to protect */ }
    }
    return out;
}

function historyIssues(root: string, base: string, modes: FailureMode[]): LintIssue[] {
    const issues: LintIssue[] = [];
    const now = new Map(modes.map(m => [m.id, m]));
    for (const [id, before] of modesAtBase(root, base)) {
        const mode = now.get(id);
        if (!mode) {
            issues.push({ file: path.join(root, before.file), rule: 'id-removed', message: `${id} existed at ${base}; retire it instead of deleting it` });
        } else if (mode.slug !== before.slug && !mode.related?.some(r => r.type === 'renamed')) {
            issues.push({ file: mode.file!, rule: 'slug-renamed', message: `${id} changed slug ${before.slug} → ${mode.slug} without a \`related: renamed\` entry` });
        }
    }
    return issues;
}

/**
 * Validate every entry and its detector cases. `root` is the repo root (entries live in
 * evals/failure-modes/ beneath it, detector modules and judge prompts resolve against it).
 * With `gitBase`, also checks that no id disappeared or silently changed slug since then.
 */
export function lintRegistry(root = repoRoot(), opts: { gitBase?: string } = {}): LintIssue[] {
    const issues: LintIssue[] = [];
    const present: FailureMode[] = [];
    const ids = new Map<string, string>();
    const slugs = new Map<string, string>();

    for (const file of modeFiles(root)) {
        let raw: unknown;
        try {
            raw = readModeFile(file);
        } catch (e) {
            issues.push({ file, rule: 'parse', message: (e as Error).message });
            continue;
        }
        if (!isObject(raw)) {
            issues.push({ file, rule: 'schema', message: 'not a YAML mapping' });
            continue;
        }
        const errors = schemaErrors(raw);
        issues.push(...errors.map(message => ({ file, rule: 'schema', message })));

        const mode = { ...raw, file } as FailureMode;
        if (nonEmpty(raw.id)) {
            if (!ID.test(mode.id)) issues.push({ file, rule: 'id-format', message: `id must match FM-NNNN, got ${mode.id}` });
            if (ids.has(mode.id)) issues.push({ file, rule: 'id-unique', message: `${mode.id} is also used by ${path.basename(ids.get(mode.id)!)}` });
            ids.set(mode.id, file);
        }
        if (nonEmpty(raw.slug)) {
            if (!SLUG.test(mode.slug)) issues.push({ file, rule: 'slug-format', message: `slug must be snake_case, got ${mode.slug}` });
            if (slugs.has(mode.slug)) issues.push({ file, rule: 'slug-unique', message: `${mode.slug} is also used by ${path.basename(slugs.get(mode.slug)!)}` });
            slugs.set(mode.slug, file);
        }
        if (nonEmpty(raw.id) && nonEmpty(raw.slug) && path.basename(file) !== `${modeStem(mode)}.yaml`) {
            issues.push({ file, rule: 'file-name', message: `file must be named ${modeStem(mode)}.yaml` });
        }
        present.push(mode);
        if (errors.length > 0) continue;

        const cases: DetectorCase[] = [];
        for (const caseFile of detectorCaseFiles(mode, root)) {
            try {
                cases.push(readDetectorCase(caseFile));
            } catch (e) {
                issues.push({ file: caseFile, rule: 'detector-case', message: (e as Error).message });
            }
        }
        issues.push(...lifecycleIssues(file, mode, cases, root));
    }

    if (opts.gitBase) {
        // An unknown ref would list no entries at the base, and so pass.
        if (git(root, ['rev-parse', '--verify', '--quiet', `${opts.gitBase}^{commit}`]) === null) {
            throw new Error(`git base "${opts.gitBase}" is not a commit in the repository holding ${root}`);
        }
        issues.push(...historyIssues(root, opts.gitBase, present));
    }
    return issues;
}
