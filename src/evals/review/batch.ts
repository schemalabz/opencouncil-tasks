import { archiveKeys, type ArchiveStore } from '../../lib/archive/store.js';
import { sha256Hex } from '../../lib/llm/cacheKey.js';
import type { NewCase } from '../harvest/candidate.js';
import type { Expected } from '../types.js';

export type ReviewKind = 'label-confirm' | 'disagreement' | 'pairwise' | 'mode-examples' | 'open-coding';
export const REVIEW_KINDS: readonly ReviewKind[] = ['label-confirm', 'disagreement', 'pairwise', 'mode-examples', 'open-coding'];

export type BatchStatus = 'open' | 'submitted' | 'applied';

/**
 * The slice of a call a detector case needs: what `callCheck` reads, with the messages'
 * text (documents dropped) for detectors that compare a response with its prompt.
 */
export type MinimalCall = {
    traceId?: string;
    callId?: string;
    label?: string;
    request: { model: string; max_tokens: number; messages: Array<{ role: string; content: string }> };
    response: { text: string; stopReason: string; servedModel?: string };
};

export type ReviewEvidence = {
    traceId?: string;
    callId?: string;
    label?: string;
    pdf?: { url?: string; sha256?: string; page?: number };
    /** What the reviewer judges, e.g. a response text. */
    text?: string;
    /** What the detector or scorer said. */
    check?: string;
    signals?: string[];
    /** mode-examples: becomes the detector case. */
    call?: MinimalCall;
};

export type ReviewItem = {
    /** Unique within the batch; results refer to it. */
    id: string;
    candidateId?: string;
    caseId?: string;
    field?: string;
    proposed?: unknown;
    /** The expectation as it stood when the batch was built; null when the field had none. */
    current?: Expected | null;
    /** The case to create when `caseId` is not in the store yet. */
    newCase?: NewCase;
    /** disagreement: the two values in the order shown, labels a/b. */
    options?: Array<{ key: 'a' | 'b'; value: unknown }>;
    /** disagreement: which option is which. Never rendered into the page. */
    hidden?: Record<'a' | 'b', 'expected' | 'output'>;
    /** pairwise: which run each option came from. Never rendered into the page. */
    sides?: Record<'a' | 'b', PairwiseRunRef>;
    evidence: ReviewEvidence;
};

/** One of the two runs a pairwise batch compares; `role` says which was passed first (the baseline). */
export type PairwiseRunRef = { role: 'baseline' | 'candidate'; runId: string; variant: string };

export type ReviewBatch = {
    id: string;
    kind: ReviewKind;
    suite: string;
    createdBy: string;
    createdAt: string;
    status: BatchStatus;
    /** mode-examples: the mode every item is a proposed occurrence of. */
    modeId?: string;
    /** pairwise: the runs compared, baseline first. */
    runs?: { baseline: PairwiseRunRef; candidate: PairwiseRunRef };
    title?: string;
    items: ReviewItem[];
    history: Array<{ status: BatchStatus; at: string; by?: string; note?: string }>;
};

export type ReviewDecision = 'confirm' | 'correct' | 'cant-tell' | 'reject' | 'a' | 'b' | 'same';
export type ReviewResult = { itemId: string; decision: ReviewDecision; value?: unknown; note?: string };
/** The file a page downloads or posts. */
export type ReviewResults = { batchId: string; reviewer: string; submittedAt: string; results: ReviewResult[] };

export const DECISIONS_BY_KIND: Record<ReviewKind, readonly ReviewDecision[]> = {
    'label-confirm': ['confirm', 'correct', 'cant-tell'],
    'mode-examples': ['confirm', 'reject', 'cant-tell'],
    disagreement: ['a', 'b', 'same', 'cant-tell'],
    pairwise: ['a', 'b', 'same', 'cant-tell'],
    'open-coding': ['confirm', 'cant-tell'],
};

/** "rv-2026-10-11-<slug>-<4 hex>": readable, sortable by day, unique per build. */
export function batchId(name: string, now: Date, salt: string): string {
    const slug = name.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'batch';
    return `rv-${now.toISOString().slice(0, 10)}-${slug}-${sha256Hex(`${salt}${now.toISOString()}`).slice(0, 4)}`;
}

export async function saveBatch(store: ArchiveStore, batch: ReviewBatch, page?: string): Promise<void> {
    await store.put(archiveKeys.review(batch.id, 'batch.json'), JSON.stringify(batch, null, 2) + '\n', 'application/json');
    if (page !== undefined) await store.put(archiveKeys.review(batch.id, 'page.html'), page, 'text/html; charset=utf-8');
}

export async function loadBatch(store: ArchiveStore, id: string): Promise<ReviewBatch> {
    const body = await store.get(archiveKeys.review(id, 'batch.json'));
    if (!body) throw new Error(`No review batch ${id} in ${store.url}`);
    return JSON.parse(body.toString('utf8')) as ReviewBatch;
}

export async function loadPage(store: ArchiveStore, id: string): Promise<string | null> {
    return (await store.get(archiveKeys.review(id, 'page.html')))?.toString('utf8') ?? null;
}

export async function loadResults(store: ArchiveStore, id: string): Promise<ReviewResults | null> {
    const body = await store.get(archiveKeys.review(id, 'results.json'));
    return body ? JSON.parse(body.toString('utf8')) as ReviewResults : null;
}

export async function listBatches(store: ArchiveStore): Promise<ReviewBatch[]> {
    const out: ReviewBatch[] = [];
    for await (const key of store.list('reviews/')) {
        if (!key.endsWith('/batch.json')) continue;
        const body = await store.get(key);
        if (body) out.push(JSON.parse(body.toString('utf8')) as ReviewBatch);
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Everything wrong with a results file for this batch; empty when it can be submitted. */
export function resultsErrors(batch: ReviewBatch, r: unknown): string[] {
    if (typeof r !== 'object' || r === null) return ['results must be a JSON object'];
    const res = r as Partial<ReviewResults>;
    const errors: string[] = [];
    if (res.batchId !== batch.id) errors.push(`batchId is ${JSON.stringify(res.batchId)}, expected ${batch.id}`);
    if (typeof res.reviewer !== 'string' || !res.reviewer.trim()) errors.push('reviewer must name the person who reviewed');
    if (typeof res.submittedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(res.submittedAt) || Number.isNaN(Date.parse(res.submittedAt))) {
        errors.push(`submittedAt is ${JSON.stringify(res.submittedAt)}, expected an ISO timestamp`);
    }
    if (!Array.isArray(res.results)) return [...errors, 'results must be an array'];
    const allowed = DECISIONS_BY_KIND[batch.kind];
    const items = new Map(batch.items.map(i => [i.id, i]));
    const seen = new Set<string>();
    for (const [i, x] of (res.results as unknown[]).entries()) {
        if (typeof x !== 'object' || x === null || Array.isArray(x)) { errors.push(`results[${i}] must be an object`); continue; }
        const result = x as ReviewResult;
        if (!items.has(result.itemId)) { errors.push(`unknown item ${result.itemId}`); continue; }
        if (seen.has(result.itemId)) errors.push(`item ${result.itemId} decided twice`);
        seen.add(result.itemId);
        if (!allowed.includes(result.decision)) errors.push(`item ${result.itemId}: decision ${JSON.stringify(result.decision)} is not one of ${allowed.join('|')}`);
        if (result.decision === 'correct' && result.value === undefined) errors.push(`item ${result.itemId}: a correction needs a value`);
        if (result.note !== undefined && typeof result.note !== 'string') errors.push(`item ${result.itemId}: note must be a string`);
    }
    const undecided = batch.items.filter(i => !seen.has(i.id)).map(i => i.id);
    if (undecided.length) errors.push(`${undecided.length} item(s) undecided: ${undecided.slice(0, 5).join(', ')}${undecided.length > 5 ? ', …' : ''} (use can't tell)`);
    return errors;
}

/** Writes the results and moves the batch to `submitted`; allowed again until it is applied. */
export async function submitResults(store: ArchiveStore, batch: ReviewBatch, raw: unknown, now = new Date()): Promise<ReviewBatch> {
    if (batch.status === 'applied') throw new Error(`Batch ${batch.id} is already applied`);
    const errors = resultsErrors(batch, raw);
    if (errors.length) throw new Error(`Results for ${batch.id} rejected:\n  ${errors.join('\n  ')}`);
    const results = raw as ReviewResults;
    await store.put(archiveKeys.review(batch.id, 'results.json'), JSON.stringify(results, null, 2) + '\n', 'application/json');
    const next: ReviewBatch = { ...batch, status: 'submitted', history: [...batch.history, { status: 'submitted', at: now.toISOString(), by: results.reviewer }] };
    await saveBatch(store, next);
    return next;
}
