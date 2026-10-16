import { archiveKeys, type ArchiveStore } from '../../lib/archive/store.js';
import { sha256Hex } from '../../lib/llm/cacheKey.js';
import type { RunEnv } from '../../lib/telemetry/context.js';

export type CandidateSource = 'monitoring' | 'disagreement' | 'novelty';

/**
 * A proposed case, label change or failure-mode occurrence, with the signal that
 * produced it. Lives in the archive; it reaches git only through a review batch.
 */
export type Candidate = {
    id: string;
    suite: string;
    source: CandidateSource;
    /** "check:<slug>" or "disagreement:<runId>". */
    signal: string;
    traceId: string;
    callId?: string;
    /** Proposed expected values by field, when the signal carries them. */
    proposed?: Record<string, unknown>;
    createdAt: string;
    /** The case the signal concerns, when it is already in the store. */
    caseId?: string;
    /** Fields the signal concerns; some may have no proposed value. */
    fields?: string[];
    modeId?: string;
    label?: string;
    /** What the detector or scorer saw. */
    evidence?: string;
    env?: RunEnv;
    /** For a case that is not in the store yet: what it would hold. Its split is assigned when a review writes it. */
    newCase?: NewCase;
};

export type NewCase = { input: unknown; cluster: string; tags?: string[] };

/** Deterministic, so harvesting the same signal twice finds the candidate it already wrote. */
export function candidateId(...parts: string[]): string {
    return `c-${sha256Hex(parts.join('\u0000')).slice(0, 16)}`;
}

/** Candidates for modes that apply to every suite are filed under this name. */
export const ANY_SUITE = 'any';

export const candidateSuiteDir = (suite: string): string => (suite === '*' ? ANY_SUITE : suite);

export async function writeCandidates(store: ArchiveStore, candidates: Candidate[]): Promise<{ written: Candidate[]; existing: Candidate[] }> {
    const written: Candidate[] = [];
    const existing: Candidate[] = [];
    for (const c of candidates) {
        const key = archiveKeys.candidate(candidateSuiteDir(c.suite), c.id);
        if (await store.exists(key)) { existing.push(c); continue; }
        await store.put(key, JSON.stringify(c, null, 2) + '\n', 'application/json');
        written.push(c);
    }
    return { written, existing };
}

export async function listCandidates(store: ArchiveStore, suite?: string): Promise<Candidate[]> {
    const prefix = suite ? `candidates/${candidateSuiteDir(suite)}/` : 'candidates/';
    const out: Candidate[] = [];
    for await (const key of store.list(prefix)) {
        if (!key.endsWith('.json')) continue;
        const body = await store.get(key);
        if (body) out.push(JSON.parse(body.toString('utf8')) as Candidate);
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export async function getCandidates(store: ArchiveStore, ids: string[]): Promise<Candidate[]> {
    const all = await listCandidates(store);
    const byId = new Map(all.map(c => [c.id, c]));
    const missing = ids.filter(id => !byId.has(id));
    if (missing.length) throw new Error(`No candidate ${missing.join(', ')} in ${store.url}`);
    return ids.map(id => byId.get(id)!);
}
