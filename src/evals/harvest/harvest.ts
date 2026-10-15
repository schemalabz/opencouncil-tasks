import type { ArchiveStore } from '../../lib/archive/store.js';
import type { RunEnv } from '../../lib/telemetry/context.js';
import { loadCases } from '../cases/caseStore.js';
import { monitoredModes } from '../registry/registry.js';
import type { FailureMode } from '../registry/schema.js';
import { loadRun } from '../run/runner.js';
import { SUITES } from '../suites/registry.js';
import { writeCandidates, type Candidate, type CandidateSource } from './candidate.js';
import { disagreementCandidates } from './sources/disagreement.js';
import { harvestMonitoring } from './sources/monitoring.js';
import { harvestNovelty, type NoveltyStats } from './sources/novelty.js';

export const CANDIDATE_SOURCES: readonly CandidateSource[] = ['monitoring', 'disagreement', 'novelty'];

export type HarvestOptions = {
    source: CandidateSource;
    suite?: string;
    env: RunEnv;
    sinceDays: number;
    /** disagreement: the suite runs to read. */
    runIds?: string[];
    /** monitoring: defaults to the modes production monitors. */
    modes?: FailureMode[];
    casesRoot?: string;
    now?: Date;
    /** novelty: filled with what was scanned per suite. */
    noveltyStats?: Record<string, NoveltyStats>;
};

export async function collectCandidates(store: ArchiveStore, opts: HarvestOptions): Promise<Candidate[]> {
    switch (opts.source) {
        case 'monitoring':
            return harvestMonitoring(store, {
                env: opts.env, sinceDays: opts.sinceDays, suite: opts.suite, now: opts.now,
                modes: opts.modes ?? monitoredModes(),
            });
        case 'disagreement': {
            if (!opts.suite) throw new Error('harvest --source disagreement needs a suite');
            if (!opts.runIds?.length) throw new Error('harvest --source disagreement needs at least one --run <runId>');
            const cases = loadCases(opts.suite, opts.casesRoot);
            const suite = SUITES[opts.suite];
            const labelValue = (output: unknown, field: string) => suite?.labelValue?.(output, field);
            const out: Candidate[] = [];
            for (const runId of opts.runIds) {
                const run = await loadRun(opts.suite, runId, undefined, store);
                out.push(...disagreementCandidates(opts.suite, runId, run.rows, cases, labelValue, opts.now));
            }
            return out;
        }
        case 'novelty':
            return harvestNovelty(store, { env: opts.env, sinceDays: opts.sinceDays, suite: opts.suite, casesRoot: opts.casesRoot, now: opts.now, stats: opts.noveltyStats });
        default:
            throw new Error(`Unknown harvest source "${opts.source}" (expected ${CANDIDATE_SOURCES.join(' | ')})`);
    }
}

export async function harvest(store: ArchiveStore, opts: HarvestOptions): Promise<{ written: Candidate[]; existing: Candidate[] }> {
    return writeCandidates(store, await collectCandidates(store, opts));
}
