import { isDeepStrictEqual } from 'node:util';
import type { ArchiveStore } from '../../lib/archive/store.js';
import { sha256Hex } from '../../lib/llm/cacheKey.js';
import type { CallRecord } from '../../lib/llm/callRecord.js';
import { readArchivedRun } from '../../lib/telemetry/archiveSink.js';
import { loadCases, readCase } from '../cases/caseStore.js';
import { loadRun } from '../run/runner.js';
import { getSuite } from '../suites/registry.js';
import type { Candidate } from '../harvest/candidate.js';
import { loadModes } from '../registry/registry.js';
import type { FailureMode } from '../registry/schema.js';
import type { Case, ResultRow } from '../types.js';
import { batchId, type MinimalCall, type PairwiseRunRef, type ReviewBatch, type ReviewEvidence, type ReviewItem, type ReviewKind } from './batch.js';

export type BuildContext = {
    store: ArchiveStore;
    casesRoot?: string;
    /** Repo root holding evals/failure-modes. */
    registryRoot?: string;
    createdBy?: string;
    name?: string;
    now?: Date;
};

function oneSuite(candidates: Candidate[]): string {
    const suites = [...new Set(candidates.map(c => c.suite))];
    if (suites.length !== 1) throw new Error(`A batch covers one suite; these candidates span ${suites.join(', ') || 'none'}`);
    return suites[0];
}

/** The case a candidate's values belong to; a candidate for a new case gets a skeleton without a split. */
function caseOf(c: Candidate, root?: string): { c: Case; isNew: boolean } {
    if (!c.caseId) throw new Error(`Candidate ${c.id} (${c.signal}) names no case; value batches need a case id (and newCase for one not in the store)`);
    const found = readCase(c.caseId, root);
    if (found) return { c: found, isNew: false };
    if (!c.newCase) throw new Error(`Candidate ${c.id}: case ${c.caseId} is not in the case store and the candidate carries no newCase`);
    return { c: { id: c.caseId, suite: c.suite, split: 'dev', input: c.newCase.input, expect: {}, cluster: c.newCase.cluster, tags: c.newCase.tags ?? [] }, isNew: true };
}

function documentShaOf(call: CallRecord): string | undefined {
    for (const m of call.request.messages) {
        for (const block of Array.isArray(m.content) ? m.content : []) {
            const sha = (block as { type?: string; source?: { sha256?: string } }).source?.sha256;
            if ((block as { type?: string }).type === 'document' && sha) return sha;
        }
    }
    return undefined;
}

/**
 * The PDF the model read, so the page can show it: the candidate's own call's when it names
 * one (a run can read many decisions), else the first document the run sent.
 */
async function documentSha(store: ArchiveStore, traceId: string, callId?: string): Promise<string | undefined> {
    const run = await readArchivedRun(traceId, store).catch(() => null);
    const calls = run?.calls ?? [];
    if (callId) {
        const call = calls.find(k => k.callId === callId);
        return call && documentShaOf(call);
    }
    for (const call of calls) {
        const sha = documentShaOf(call);
        if (sha) return sha;
    }
    return undefined;
}

async function valueItems(candidates: Candidate[], ctx: BuildContext, keep: (proposed: unknown, c: Case, field: string) => boolean): Promise<Array<ReviewItem & { proposed: unknown }>> {
    const items: Array<ReviewItem & { proposed: unknown }> = [];
    // One item per case field: applying one rewrites the field, so a second would read as stale.
    const seen = new Set<string>();
    for (const cand of candidates) {
        const { c, isNew } = caseOf(cand, ctx.casesRoot);
        const fields = Object.keys(cand.proposed ?? {}).filter(f => !seen.has(`${c.id}\u0000${f}`) && keep(cand.proposed![f], c, f));
        if (fields.length === 0) continue;
        for (const f of fields) seen.add(`${c.id}\u0000${f}`);
        const input = c.input as { pdfUrl?: string } | null;
        const sha256 = await documentSha(ctx.store, cand.traceId, cand.callId);
        const evidence: ReviewEvidence = {
            traceId: cand.traceId,
            ...(cand.callId && { callId: cand.callId }),
            ...((input?.pdfUrl || sha256) && { pdf: { ...(input?.pdfUrl && { url: input.pdfUrl }), ...(sha256 && { sha256 }), page: 1 } }),
            signals: [cand.signal],
            ...(cand.evidence && { check: cand.evidence }),
        };
        for (const field of fields) {
            items.push({
                id: `${cand.id}:${field}`, candidateId: cand.id, caseId: c.id, field, proposed: cand.proposed![field], current: c.expect[field] ?? null, evidence,
                ...(isNew && { newCase: cand.newCase }),
            });
        }
    }
    return items;
}

const messageText = (content: unknown): string => (typeof content === 'string' ? content
    : Array.isArray(content) ? content.map(b => ((b as { type?: string }).type === 'text' ? (b as { text?: string }).text ?? '' : '')).filter(Boolean).join('\n') : '');

function minimalCall(call: CallRecord, traceId: string): MinimalCall {
    if (!call.response) throw new Error(`Call ${call.callId} in run ${traceId} has no response to review`);
    const messages = call.request.messages.map(m => ({ role: m.role, content: messageText(m.content) })).filter(m => m.content);
    return {
        traceId,
        callId: call.callId,
        label: call.label,
        request: { model: call.request.model, max_tokens: call.request.max_tokens, messages },
        response: { text: call.response.text, stopReason: call.response.stopReason, servedModel: call.response.servedModel },
    };
}

async function modeExampleItems(candidates: Candidate[], mode: FailureMode, ctx: BuildContext): Promise<ReviewItem[]> {
    const items: ReviewItem[] = [];
    for (const cand of candidates) {
        if (!cand.callId) throw new Error(`Candidate ${cand.id} names no call; ${mode.id} is a call-scope mode`);
        const run = await readArchivedRun(cand.traceId, ctx.store);
        if (!run) throw new Error(`Candidate ${cand.id}: run ${cand.traceId} is not in the archive (${ctx.store.url})`);
        const call = run.calls.find(c => c.callId === cand.callId);
        if (!call) throw new Error(`Candidate ${cand.id}: run ${cand.traceId} has no call ${cand.callId}`);
        const minimal = minimalCall(call, cand.traceId);
        items.push({
            id: cand.id,
            candidateId: cand.id,
            evidence: { traceId: cand.traceId, callId: cand.callId, label: call.label, text: minimal.response.text, check: cand.evidence, signals: [cand.signal], call: minimal },
        });
    }
    return items;
}

/** a/b order from a hash, so a rebuild shows the same page but a reviewer can't learn a pattern. */
const flipFor = (seed: string) => parseInt(sha256Hex(seed).slice(0, 2), 16) % 2 === 1;

export function blindOptions(seed: string, expected: unknown, output: unknown): Pick<ReviewItem, 'options' | 'hidden'> {
    return flipFor(seed)
        ? { options: [{ key: 'a', value: output }, { key: 'b', value: expected }], hidden: { a: 'output', b: 'expected' } }
        : { options: [{ key: 'a', value: expected }, { key: 'b', value: output }], hidden: { a: 'expected', b: 'output' } };
}

function shuffle<T>(xs: T[], seed: string, id: (x: T) => string): T[] {
    return [...xs].sort((a, b) => sha256Hex(seed + id(a)).localeCompare(sha256Hex(seed + id(b))));
}

export type PairwiseContext = BuildContext & { limit?: number; runsDir?: string };

/** The first repeat of each case: a pairwise item compares one output with one output. */
function firstRepByCase(rows: ResultRow[]): Map<string, ResultRow> {
    const out = new Map<string, ResultRow>();
    for (const r of [...rows].sort((x, y) => x.rep - y.rep)) if (!out.has(r.caseId)) out.set(r.caseId, r);
    return out;
}

/**
 * Two runs of a suite side by side, field by field where their outputs differ: the
 * reviewer sees A and B in a per-item random order and never which run is which.
 * The first run is the baseline; results become preference records, not case values.
 */
export async function buildPairwiseBatch(suiteId: string, runIds: [string, string], ctx: PairwiseContext): Promise<ReviewBatch> {
    const suite = getSuite(suiteId);
    if (!suite.pairwiseItems) throw new Error(`Suite ${suiteId} has no pairwise view`);
    const [ra, rb] = await Promise.all(runIds.map(id => loadRun(suiteId, id, ctx.runsDir, ctx.store)));
    const ref = (role: PairwiseRunRef['role'], run: typeof ra): PairwiseRunRef => ({ role, runId: run.manifest.runId, variant: run.manifest.variant.name });
    const runs = { baseline: ref('baseline', ra), candidate: ref('candidate', rb) };
    const cases = new Map(loadCases(suiteId, ctx.casesRoot).map(c => [c.id, c]));
    const rowsB = firstRepByCase(rb.rows);
    const now = ctx.now ?? new Date();
    const id = batchId(ctx.name ?? `${suiteId}-pairwise`, now, runIds.join(','));

    const raw: ReviewItem[] = [];
    for (const [caseId, rowA] of firstRepByCase(ra.rows)) {
        const rowB = rowsB.get(caseId);
        const c = cases.get(caseId);
        if (!rowB || !c) continue;
        const recorded = c.replay ? await readArchivedRun(c.replay, ctx.store).catch(() => null) : null;
        suite.pairwiseItems(rowA.output, rowB.output, c).forEach((view, n) => {
            const call = view.sourceLabel ? recorded?.calls.find(k => k.label === view.sourceLabel) : undefined;
            const itemId = `${caseId.slice(suiteId.length + 1)}#${n + 1}`;
            const flip = flipFor(id + itemId);
            const [first, second] = flip ? [view.b, view.a] : [view.a, view.b];
            raw.push({
                id: itemId, caseId, field: view.field,
                options: [{ key: 'a', value: first }, { key: 'b', value: second }],
                sides: flip ? { a: runs.candidate, b: runs.baseline } : { a: runs.baseline, b: runs.candidate },
                evidence: { text: view.title, ...(call && { traceId: c.replay!, callId: call.callId, label: call.label }) },
            });
        });
    }
    if (raw.length === 0) throw new Error(`Runs ${runIds.join(' and ')} have no differing outputs to compare`);
    const items = shuffle(raw, id, i => i.id).slice(0, ctx.limit ?? 30);
    return {
        id, kind: 'pairwise', suite: suiteId, createdBy: ctx.createdBy ?? 'agent', createdAt: now.toISOString(), status: 'open', runs,
        title: `${suiteId}: which output is better?`, items,
        history: [{ status: 'open', at: now.toISOString(), by: ctx.createdBy ?? 'agent' }],
    };
}

export async function buildBatch(kind: ReviewKind, candidates: Candidate[], ctx: BuildContext): Promise<ReviewBatch> {
    if (candidates.length === 0) throw new Error('No candidates to review');
    const now = ctx.now ?? new Date();
    const suite = oneSuite(candidates);
    const base = { kind, suite, createdBy: ctx.createdBy ?? 'agent', createdAt: now.toISOString(), status: 'open' as const, history: [{ status: 'open' as const, at: now.toISOString(), by: ctx.createdBy ?? 'agent' }] };
    const salt = candidates.map(c => c.id).join(',');

    switch (kind) {
        case 'label-confirm': {
            const items = await valueItems(candidates, ctx, () => true);
            if (items.length === 0) throw new Error('None of these candidates proposes a value to confirm');
            const id = batchId(ctx.name ?? suite, now, salt);
            return { id, ...base, title: `${suite}: confirm proposed values`, items };
        }
        case 'disagreement': {
            const id = batchId(ctx.name ?? `${suite}-disagreement`, now, salt);
            const raw = await valueItems(candidates, ctx, (proposed, c, field) => c.expect[field] !== undefined && !isDeepStrictEqual(proposed, c.expect[field].value));
            if (raw.length === 0) throw new Error('None of these candidates has a value that differs from its expectation');
            const items = shuffle(raw, id, i => i.id).map(({ proposed, ...item }) => ({ ...item, ...blindOptions(id + item.id, item.current!.value, proposed) }));
            return { id, ...base, title: `${suite}: which value is right?`, items };
        }
        case 'mode-examples': {
            const modeIds = [...new Set(candidates.map(c => c.modeId))];
            if (modeIds.length !== 1 || !modeIds[0]) throw new Error(`A mode-examples batch covers one failure mode; these candidates name ${modeIds.join(', ') || 'none'}`);
            const mode = loadModes(ctx.registryRoot).find(m => m.id === modeIds[0]);
            if (!mode) throw new Error(`No failure mode ${modeIds[0]} in the registry`);
            if (mode.scope !== 'call') throw new Error(`${mode.id} is task-scope; mode-examples batches only review calls so far`);
            const items = await modeExampleItems(candidates, mode, ctx);
            return { id: batchId(ctx.name ?? mode.slug, now, salt), ...base, modeId: mode.id, title: `${mode.id} ${mode.slug}: is each one an occurrence?`, items };
        }
        default:
            throw new Error(kind === 'pairwise'
                ? 'A pairwise batch compares two runs, not candidates: eval review build pairwise --suite <suite> --run <baseline> --run <candidate>'
                : `Review kind "${kind}" has no builder yet (built: label-confirm, disagreement, pairwise, mode-examples)`);
    }
}
