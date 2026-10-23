import type { Case, ResultRow } from '../../types.js';
import { candidateId, type Candidate } from '../candidate.js';

/** The suite's answer for a field in the case's shape; undefined when it has none. */
export type LabelValue = (output: unknown, field: string) => unknown;

/**
 * A drafted value the run disagrees with, or a contested value the run produced an
 * answer for: both need a person, and the run's answer is the proposal.
 * One candidate per case, across all of the run's repeats.
 */
export function disagreementCandidates(suite: string, runId: string, rows: ResultRow[], cases: Case[], labelValue: LabelValue, now = new Date()): Candidate[] {
    const byCase = new Map(cases.map(c => [c.id, c]));
    const out = new Map<string, Candidate>();
    for (const row of rows) {
        const c = byCase.get(row.caseId);
        if (!c) continue;
        const fields: string[] = [];
        const proposed: Record<string, unknown> = {};
        for (const [field, expected] of Object.entries(c.expect)) {
            const outcome = row.fields[field];
            const value = row.output === null || row.output === undefined ? undefined : labelValue(row.output, field);
            const flagged = (expected.tier === 'drafted' && outcome === 'disagree')
                || (expected.tier === 'contested' && outcome !== undefined && value !== undefined);
            if (!flagged) continue;
            fields.push(field);
            if (value !== undefined) proposed[field] = value;
        }
        if (fields.length === 0) continue;
        const id = candidateId('disagreement', runId, c.id);
        const prev = out.get(id);
        if (prev) {
            prev.fields = [...new Set([...(prev.fields ?? []), ...fields])];
            const merged = { ...proposed, ...prev.proposed };
            if (Object.keys(merged).length) prev.proposed = merged;
            continue;
        }
        out.set(id, {
            id,
            suite,
            source: 'disagreement',
            signal: `disagreement:${runId}`,
            traceId: row.traceId,
            caseId: c.id,
            fields,
            ...(Object.keys(proposed).length && { proposed }),
            createdAt: now.toISOString(),
            evidence: fields.map(f => `${f}: ${c.expect[f].tier} ${row.fields[f]}`).join('; '),
        });
    }
    return [...out.values()];
}
