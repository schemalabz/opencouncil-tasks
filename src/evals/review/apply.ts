import fs from 'fs';
import path from 'path';
import { isDeepStrictEqual } from 'node:util';
import { archiveKeys, type ArchiveStore } from '../../lib/archive/store.js';
import { assignSplit, casesRoot as resolveCasesRoot, locateCase, stemOf, writeCase } from '../cases/caseStore.js';
import { lintCases, type LintIssue } from '../cases/lint.js';
import { lintRegistry } from '../registry/lint.js';
import { detectorCaseFiles, detectorCasesDir, loadModes, repoRoot } from '../registry/registry.js';
import type { DetectorCaseKind } from '../registry/schema.js';
import { settledByPerson, type Case, type Expected, type Tier } from '../types.js';
import { loadBatch, loadResults, saveBatch, type PairwiseRunRef, type ReviewBatch, type ReviewDecision, type ReviewItem, type ReviewResult, type ReviewResults } from './batch.js';

export type ApplyContext = {
    casesRoot?: string;
    /** Repo root holding evals/failure-modes. */
    registryRoot?: string;
    appliedBy?: string;
    now?: Date;
};

/** `root` is where the case was read from: a private case must never land in the committed tree. */
export type CaseWrite = { case: Case; root: string; created: boolean; changes: string[] };
export type DetectorCaseWrite = { modeId: string; kind: DetectorCaseKind; file: string; body: { kind: DetectorCaseKind; note: string; input: unknown } };
/**
 * A person's preference between two runs' outputs for one field. Kept in the archive, not
 * in cases: it is a quality signal (and judge calibration data), not an expected value.
 */
export type PreferenceRecord = {
    batchId: string; suite: string; caseId: string; field: string; reviewer: string; at: string;
    preferred: 'baseline' | 'candidate' | 'same' | 'cant-tell';
    baseline: PairwiseRunRef; candidate: PairwiseRunRef;
    /** Which run the page showed as A (order is random per item). */
    shownAs: { a: PairwiseRunRef['role']; b: PairwiseRunRef['role'] };
    note?: string;
};

export type ApplyPlan = { cases: CaseWrite[]; detectorCases: DetectorCaseWrite[]; preferences?: PreferenceRecord[]; tally: Partial<Record<ReviewDecision, number>> };

type Settled = { value: unknown; tier: Tier; reason?: string; corrected: boolean };

/** The expected value a label-confirm or disagreement decision settles on. */
function settle(batch: ReviewBatch, item: ReviewItem, r: ReviewResult): Settled {
    const current = item.current?.value;
    const cantTell = (value: unknown): Settled => ({ value, tier: 'contested', corrected: false, reason: `can't tell in review ${batch.id}${r.note ? `: ${r.note}` : ''}` });
    if (batch.kind === 'label-confirm') {
        if (r.decision === 'confirm') return { value: item.proposed, tier: 'adjudicated', corrected: false };
        if (r.decision === 'correct') return { value: r.value, tier: 'adjudicated', corrected: true };
        return cantTell(item.current ? current : item.proposed);
    }
    if (r.decision === 'same') return { value: current, tier: 'adjudicated', corrected: false };
    if (r.decision === 'a' || r.decision === 'b') {
        const chosen = item.options?.find(o => o.key === r.decision);
        if (!chosen || chosen.value === undefined) throw new Error(`Item ${item.id}: option ${r.decision} has no value to adopt`);
        return { value: chosen.value, tier: 'adjudicated', corrected: item.hidden?.[r.decision] === 'output' };
    }
    return cantTell(current);
}

function planCases(batch: ReviewBatch, results: ReviewResults, ctx: ApplyContext): CaseWrite[] {
    const at = results.submittedAt.slice(0, 10);
    const byCase = new Map<string, CaseWrite>();
    const items = new Map(batch.items.map(i => [i.id, i]));
    for (const r of results.results) {
        const item = items.get(r.itemId)!;
        if (!item.caseId || !item.field) throw new Error(`Item ${item.id} names no case field`);
        let write = byCase.get(item.caseId);
        if (!write) {
            const found = locateCase(item.caseId, ctx.casesRoot);
            const existing = found?.case;
            if (!existing && !item.newCase) throw new Error(`Item ${item.id}: case ${item.caseId} is gone from the case store`);
            const c: Case = existing
                ? structuredClone(existing)
                : { id: item.caseId, suite: batch.suite, split: assignSplit(item.caseId), input: item.newCase!.input, expect: {}, cluster: item.newCase!.cluster, tags: item.newCase!.tags ?? [] };
            write = { case: c, root: found?.root ?? resolveCasesRoot(ctx.casesRoot), created: !existing, changes: [] };
            byCase.set(item.caseId, write);
        }
        const before = write.case.expect[item.field];
        // A field empty at build time may since have been settled by a person; a drafted value is fair to overwrite.
        const stale = item.current ? before && !isDeepStrictEqual(before, item.current) : before && settledByPerson(before);
        if (stale) {
            throw new Error(`${item.caseId} ${item.field} changed since batch ${batch.id} was built; rebuild the batch`);
        }
        const s = settle(batch, item, r);
        const expected: Expected = { value: s.value, tier: s.tier, by: results.reviewer, at, source: `review:${batch.id}`, ...(s.reason && { reason: s.reason }) };
        write.case.expect[item.field] = expected;
        const change = `${item.field} ${before?.tier ?? 'new'}→${s.tier}${s.corrected ? ' (corrected)' : ''}${r.decision === 'same' ? ' (both readings accepted)' : ''}`;
        write.changes.push(change);
        write.case.history = [...(write.case.history ?? []), { at, change, batch: batch.id, ...(s.reason && { reason: s.reason }) }];
    }
    return [...byCase.values()];
}

const MODE_CASE_KIND: Partial<Record<ReviewDecision, DetectorCaseKind>> = {
    confirm: 'must-fire',
    // The detector fired on it in production, so a person's "no" makes it a documented false alarm.
    reject: 'known-false-alarm',
};

function planDetectorCases(batch: ReviewBatch, results: ReviewResults, ctx: ApplyContext): DetectorCaseWrite[] {
    const root = ctx.registryRoot ?? repoRoot();
    const mode = loadModes(root).find(m => m.id === batch.modeId);
    if (!mode) throw new Error(`Batch ${batch.id}: no failure mode ${batch.modeId} in the registry`);
    const next = new Map<DetectorCaseKind, number>();
    const nextNumber = (kind: DetectorCaseKind) => {
        if (!next.has(kind)) {
            const used = detectorCaseFiles(mode, root).map(f => new RegExp(`^${kind}-(\\d+)-`).exec(path.basename(f))?.[1]).filter(Boolean).map(Number);
            next.set(kind, Math.max(0, ...used) + 1);
        }
        const n = next.get(kind)!;
        next.set(kind, n + 1);
        return n;
    };
    const items = new Map(batch.items.map(i => [i.id, i]));
    const out: DetectorCaseWrite[] = [];
    for (const r of results.results) {
        const kind = MODE_CASE_KIND[r.decision];
        if (!kind) continue;
        const item = items.get(r.itemId)!;
        if (!item.evidence.call) throw new Error(`Item ${item.id} carries no call to keep as a detector case`);
        const verdict = kind === 'must-fire' ? 'confirmed as an occurrence' : 'judged not an occurrence';
        const note = `${verdict} in review ${batch.id} by ${results.reviewer} (trace ${item.evidence.traceId}, ${item.evidence.label})${r.note ? `: ${r.note}` : ''}`;
        out.push({ modeId: mode.id, kind, file: path.join(detectorCasesDir(mode, root), `${kind}-${nextNumber(kind)}-${batch.id}.json`), body: { kind, note, input: item.evidence.call } });
    }
    return out;
}

function planPreferences(batch: ReviewBatch, results: ReviewResults): PreferenceRecord[] {
    if (!batch.runs) throw new Error(`Batch ${batch.id} names no runs to prefer between`);
    const items = new Map(batch.items.map(i => [i.id, i]));
    return results.results.map(r => {
        const item = items.get(r.itemId)!;
        if (!item.caseId || !item.field || !item.sides) throw new Error(`Item ${item.id} is not a pairwise item`);
        const preferred = r.decision === 'a' || r.decision === 'b' ? item.sides[r.decision].role : r.decision === 'same' ? 'same' : 'cant-tell';
        return {
            batchId: batch.id, suite: batch.suite, caseId: item.caseId, field: item.field, reviewer: results.reviewer, at: results.submittedAt,
            preferred, baseline: batch.runs!.baseline, candidate: batch.runs!.candidate,
            shownAs: { a: item.sides.a.role, b: item.sides.b.role }, ...(r.note && { note: r.note }),
        };
    });
}

export function planApply(batch: ReviewBatch, results: ReviewResults, ctx: ApplyContext = {}): ApplyPlan {
    const tally: ApplyPlan['tally'] = {};
    for (const r of results.results) tally[r.decision] = (tally[r.decision] ?? 0) + 1;
    switch (batch.kind) {
        case 'label-confirm':
        case 'disagreement':
            return { cases: planCases(batch, results, ctx), detectorCases: [], tally };
        case 'mode-examples':
            return { cases: [], detectorCases: planDetectorCases(batch, results, ctx), tally };
        case 'pairwise':
            return { cases: [], detectorCases: [], preferences: planPreferences(batch, results), tally };
        default:
            throw new Error(`Review kind "${batch.kind}" has no apply step yet`);
    }
}

const caseFile = (w: CaseWrite) => path.join(w.root, w.case.suite, `${stemOf(w.case)}.json`);

export function writePlan(plan: ApplyPlan): string[] {
    const files: string[] = [];
    for (const w of plan.cases) files.push(writeCase(w.case, w.root));
    for (const d of plan.detectorCases) {
        fs.mkdirSync(path.dirname(d.file), { recursive: true });
        fs.writeFileSync(d.file, JSON.stringify(d.body, null, 2) + '\n');
        files.push(d.file);
    }
    return files;
}

export function prBody(batch: ReviewBatch, results: ReviewResults, plan: ApplyPlan, files: string[], ctx: ApplyContext = {}): string {
    const root = ctx.registryRoot ?? repoRoot();
    const rel = (f: string) => path.relative(root, f);
    const lines = [
        `## Review ${batch.id}`,
        '',
        `${batch.kind} batch on \`${batch.suite}\`${batch.modeId ? ` for ${batch.modeId}` : ''}, built by ${batch.createdBy} on ${batch.createdAt.slice(0, 10)}, reviewed by **${results.reviewer}** on ${results.submittedAt.slice(0, 10)}.`,
        '',
        '| Decision | Items |',
        '| --- | --- |',
        ...Object.entries(plan.tally).map(([d, n]) => `| ${d} | ${n} |`),
        '',
        '### Changes',
        ...plan.cases.map(w => `- \`${rel(caseFile(w))}\`${w.created ? ` (new, ${w.case.split})` : ''}: ${w.changes.join('; ')}`),
        ...plan.detectorCases.map(d => `- \`${rel(d.file)}\`: ${d.kind} detector case for ${d.modeId}`),
        '',
        `Files: ${files.length}. \`eval lint\` passes. Values were written by \`eval review apply\` from the submitted results; merging this PR is the human confirmation.`,
    ];
    return lines.join('\n');
}

export type ApplyOutcome = { batch: ReviewBatch; plan: ApplyPlan; files: string[]; issues: LintIssue[]; prBody: string };

/**
 * Turns a submitted batch's results into case and registry files in the working tree,
 * lints them, and only then marks the batch applied. On lint issues, or if recording the
 * batch as applied fails, the files are put back as they were. Nothing is committed or pushed.
 */
export async function applyBatch(store: ArchiveStore, batchId: string, ctx: ApplyContext = {}): Promise<ApplyOutcome> {
    const batch = await loadBatch(store, batchId);
    if (batch.status === 'applied') throw new Error(`Batch ${batchId} is already applied`);
    if (batch.status !== 'submitted') throw new Error(`Batch ${batchId} is ${batch.status}: a person submits it first (eval review open ${batchId})`);
    const results = await loadResults(store, batchId);
    if (!results) throw new Error(`Batch ${batchId} is marked submitted but has no results.json`);

    const plan = planApply(batch, results, ctx);
    const targets = [...plan.cases.map(caseFile), ...plan.detectorCases.map(d => d.file)];
    const previous = new Map(targets.map(f => [f, fs.existsSync(f) ? fs.readFileSync(f) : null]));
    // Left written while the batch stays submitted, a retry would find its own values and refuse them as stale.
    let applied = false;
    try {
        const files = writePlan(plan);
        const issues = [...lintCases(ctx.casesRoot), ...lintRegistry(ctx.registryRoot ?? repoRoot())];
        if (issues.length) return { batch, plan, files: [], issues, prBody: prBody(batch, results, plan, files, ctx) };
        if (plan.preferences) {
            await store.put(archiveKeys.preferences(batch.suite, batch.id), plan.preferences.map(p => JSON.stringify(p)).join('\n') + '\n', 'application/x-ndjson');
        }
        const next: ReviewBatch = { ...batch, status: 'applied', history: [...batch.history, { status: 'applied', at: (ctx.now ?? new Date()).toISOString(), by: ctx.appliedBy ?? 'agent', note: `${files.length} file(s)` }] };
        await saveBatch(store, next);
        applied = true;
        return { batch: next, plan, files, issues, prBody: prBody(batch, results, plan, files, ctx) };
    } finally {
        if (!applied) {
            for (const [f, body] of previous) {
                if (body === null) fs.rmSync(f, { force: true });
                else fs.writeFileSync(f, body);
            }
        }
    }
}
