import type { ArchiveStore } from '../../../lib/archive/store.js';
import { matchesGlob } from '../../../lib/llm/callPolicy.js';
import { iterateArchivedRuns } from '../../../lib/runs/fetch.js';
import type { ArchivedRun } from '../../../lib/telemetry/archiveSink.js';
import type { RunEnv } from '../../../lib/telemetry/context.js';
import { caseFiles, loadCases } from '../../cases/caseStore.js';
import { SUITES } from '../../suites/registry.js';
import type { Suite } from '../../suites/suite.js';
import type { Case } from '../../types.js';
import { candidateId, type Candidate } from '../candidate.js';

/**
 * Production inputs unlike every case of a suite, by a deterministic rule:
 *
 * - Call suites (`caseFromCall`, the decision suites): the case a call would make lands in a
 *   cluster (city/body) no case has: `novelty:new-city` when no case has the city at all,
 *   `novelty:new-body` when the city has cases under other bodies. Within a covered cluster,
 *   a value of a `noveltyFields` field whose shape (digit runs → 9, letter runs → a) no case
 *   of that cluster has: `novelty:new-shape:<field>`. For decision reading that field is the
 *   decision number, the one page-1 layout signal an archived call keeps (imported calls hold
 *   no PDF). Calls whose document the run does not name, or whose document already is a
 *   case, are skipped.
 * - Run suites (`caseFromRun`, summarize): a successful run of the suite's task from a city
 *   no case has: `novelty:new-city`. Every new meeting lacks a case, so meetings alone are
 *   not novel. Run suites of one task whose cases cover the same cities are scanned once,
 *   under the first of them.
 *
 * One candidate per (suite, city, reason) — per (suite, cluster, shape) for shapes — from the
 * newest example, counting the rest and listing the bodies seen.
 */

export type NoveltyOptions = {
    env: RunEnv;
    sinceDays: number;
    suite?: string;
    casesRoot?: string;
    now?: Date;
    /** For tests: the runs to read instead of the archive's. */
    runs?: AsyncIterable<ArchivedRun>;
    /** Filled with what was scanned, per suite. */
    stats?: Record<string, NoveltyStats>;
};

/** `seen`: calls of the suite's labels (or runs of its task); `placed`: those that name a case; `known`: whose case exists. */
export type NoveltyStats = { seen: number; placed: number; known: number };

export function valueShape(value: string): string {
    return value.trim().replace(/\d+/g, '9').replace(/\p{L}+/gu, 'a').replace(/\s+/g, ' ');
}

type Coverage = { clusters: Set<string>; cities: Set<string>; shapes: Map<string, Map<string, Set<string>>>; caseIds: Set<string> };

function coverage(cases: Case[], fields: string[]): Coverage {
    const shapes = new Map<string, Map<string, Set<string>>>();
    for (const c of cases) {
        const byField = shapes.get(c.cluster) ?? new Map<string, Set<string>>();
        shapes.set(c.cluster, byField);
        for (const f of fields) {
            const v = c.expect[f]?.value;
            if (typeof v !== 'string') continue;
            if (!byField.has(f)) byField.set(f, new Set());
            byField.get(f)!.add(valueShape(v));
        }
    }
    return { clusters: new Set(cases.map(c => c.cluster)), cities: new Set(cases.map(c => c.cluster.split('/')[0])), shapes, caseIds: new Set(cases.map(c => c.id)) };
}

type Example = Omit<Candidate, 'id' | 'suite' | 'source' | 'signal' | 'createdAt'>;
type Group = { candidate: Candidate; where: string; count: number; first: string; last: string; unit: string; why: string; variants: Set<string> };

export async function harvestNovelty(store: ArchiveStore, opts: NoveltyOptions): Promise<Candidate[]> {
    const now = (opts.now ?? new Date()).toISOString();
    const suites = (opts.suite ? [SUITES[opts.suite]] : Object.values(SUITES)).filter((s): s is Suite => Boolean(s && (s.caseFromCall || s.caseFromRun)));
    if (opts.suite && suites.length === 0) throw new Error(`Suite ${opts.suite} states no case for a production call or run, so novelty has nothing to compare`);
    // A suite with no cases yet covers nothing.
    const casesOf = (id: string) => (caseFiles(id, opts.casesRoot).length ? loadCases(id, opts.casesRoot) : []);
    const covered = new Map(suites.map(s => [s.id, coverage(casesOf(s.id), s.noveltyFields ?? [])]));
    // Run suites of one task with the same cities (summarize's three) would file one city three times.
    const twins = new Map<string, string[]>();
    for (const s of suites.filter(s => !s.caseFromCall)) {
        const key = `${s.task}\u0000${[...covered.get(s.id)!.clusters].sort().join(',')}`;
        twins.set(key, [...(twins.get(key) ?? []), s.id]);
    }
    const sameAs = new Map([...twins.values()].map(ids => [ids[0], ids.slice(1)]));
    const scanned = suites.filter(s => s.caseFromCall || sameAs.has(s.id));
    const groups = new Map<string, Group>();
    const stats = opts.stats ?? {};
    for (const s of scanned) stats[s.id] = { seen: 0, placed: 0, known: 0 };

    /** Runs arrive newest first, so the first example of a group is its newest. */
    const note = (suite: Suite, reason: string, where: string, at: string, unit: string, why: string, example: () => Example, variant?: string) => {
        const id = candidateId('novelty', suite.id, where, reason);
        let g = groups.get(id);
        if (g) { g.count++; if (at < g.first) g.first = at; }
        else {
            g = { candidate: { id, suite: suite.id, source: 'novelty', signal: `novelty:${reason}`, createdAt: now, env: opts.env, ...example() }, where, count: 1, first: at, last: at, unit, why, variants: new Set() };
            groups.set(id, g);
        }
        if (variant) g.variants.add(variant);
    };

    const runs = opts.runs ?? iterateArchivedRuns({ env: opts.env, sinceDays: opts.sinceDays }, store);
    for await (const run of runs) {
        const at = run.run.startedAt;
        for (const suite of scanned) {
            const cov = covered.get(suite.id)!;
            const st = stats[suite.id];
            if (suite.caseFromCall) {
                for (const call of run.calls) {
                    if (!suite.labels.some(glob => matchesGlob(call.label ?? 'aiChat', glob))) continue;
                    st.seen++;
                    const made = suite.caseFromCall(call, run);
                    if (!made) continue;
                    st.placed++;
                    if (cov.caseIds.has(made.caseId)) { st.known++; continue; }
                    const { cluster } = made.newCase;
                    const example = (): Example => ({
                        traceId: run.run.traceId, callId: call.callId, ...(call.label && { label: call.label }),
                        caseId: made.caseId, newCase: made.newCase, proposed: made.proposed, fields: Object.keys(made.proposed),
                    });
                    if (!cov.clusters.has(cluster)) {
                        // One candidate per city: bodies are spelled as many ways as pages print them.
                        const [city, body] = [cluster.split('/')[0], cluster.slice(cluster.indexOf('/') + 1)];
                        const newCity = !cov.cities.has(city);
                        note(suite, newCity ? 'new-city' : 'new-body', city, at, 'calls', newCity ? 'no case has this city' : 'the city has cases, none for these bodies', example, body);
                        continue;
                    }
                    for (const f of suite.noveltyFields ?? []) {
                        const v = made.proposed[f];
                        if (typeof v !== 'string') continue;
                        const shape = valueShape(v);
                        const known = cov.shapes.get(cluster)?.get(f);
                        if (known?.has(shape)) continue;
                        const have = known?.size ? [...known].map(s => `"${s}"`).join(', ') : 'none';
                        note(suite, `new-shape:${f}`, `${cluster}#${shape}`, at, 'calls', `${f} shaped "${shape}"; the cluster's cases have ${have}`, example);
                    }
                }
            } else if (suite.caseFromRun && run.run.taskType === suite.task && run.outcome.status === 'success' && run.run.meeting) {
                st.seen++;
                st.placed++;
                const city = run.run.meeting.split('/')[0];
                if (cov.clusters.has(city)) { st.known++; continue; }
                const also = sameAs.get(suite.id)?.length ? ` (nor in ${sameAs.get(suite.id)!.join(', ')})` : '';
                note(suite, 'new-city', city, at, 'runs', `no case has this city${also}`, () => {
                    let made: Case | undefined;
                    try { made = suite.caseFromRun!(run); } catch { /* no archived result: the candidate still names the run */ }
                    return { traceId: run.run.traceId, ...(made && { caseId: made.id, newCase: { input: made.input, cluster: made.cluster, tags: made.tags } }) };
                });
            }
        }
    }

    return [...groups.values()].map(g => {
        const variants = [...g.variants];
        const bodies = variants.length ? `; bodies: ${variants.slice(0, 6).join(' | ')}${variants.length > 6 ? ` (+${variants.length - 6} more)` : ''}` : '';
        return { ...g.candidate, evidence: `${g.count} ${g.unit} from ${g.where} between ${g.first.slice(0, 10)} and ${g.last.slice(0, 10)}; ${g.why}${bodies}` };
    });
}
