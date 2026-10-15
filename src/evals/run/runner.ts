import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { randomBytes } from 'crypto';
import { openArchive, archiveKeys, type ArchiveStore } from '../../lib/archive/store.js';
import { cassetteFromCalls } from '../../lib/llm/cassette.js';
import type { CallRecord } from '../../lib/llm/callRecord.js';
import { BudgetExceededError, DEFAULT_POLICY, resolveOverrides, runWithCallPolicy, type CallPolicy } from '../../lib/llm/callPolicy.js';
import { getRunState, type RunState } from '../../lib/telemetry/context.js';
import { runWithTelemetry } from '../../lib/telemetry/telemetry.js';
import { readArchivedRun, type ArchivedRun } from '../../lib/telemetry/archiveSink.js';
import { callsCostUsd } from '../../lib/pricing.js';
import { canonicalJson } from '../../lib/llm/cacheKey.js';
import { caseSetSha, loadCases } from '../cases/caseStore.js';
import type { Suite } from '../suites/suite.js';
import { modesForSuite } from '../registry/registry.js';
import { runChecksOnRun, verdictBySlug } from '../monitor/runChecks.js';
import { getSuite } from '../suites/registry.js';
import { PolicyErrorsInRunError, policyFailures } from '../taskRunner.js';
import type { Case, ErrorRow, ResultRow, RunManifest, Split, Variant } from '../types.js';

export type RunOptions = {
    suite: string;
    variant: Variant;
    split: Split | 'all';
    reps: number;
    concurrency: number;
    budgetUsd: number;
    replay?: boolean;
    /** Label globs live under replay. Undefined: the suite's own; empty: every call served from the recording. */
    live?: string[];
    limit?: number;
    caseIds?: string[];
    /** Resume this run instead of starting a new one. */
    runId?: string;
    /** Local mirror of run files (default .eval-runs). */
    outDir?: string;
    /** Injected for tests. */
    cases?: Case[];
    suiteImpl?: Suite<any, any>;
    archive?: ArchiveStore | null;
    onProgress?: (done: number, total: number, spentUsd: number) => void;
};

export type RunOutcome = { runId: string; manifest: RunManifest; rows: ResultRow[]; errors: ErrorRow[]; dir: string };

const git = (cmd: string) => { try { return execSync(`git ${cmd}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } };

export function runsDir(outDir?: string): string {
    return outDir ?? path.join(process.cwd(), '.eval-runs');
}

const readJsonl = <T>(file: string): T[] => fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as T) : [];

/**
 * The model that answered must be the one asked for: a substituted model would
 * make the comparison meaningless. Dated ids count as their alias.
 */
export function servedModelMismatch(calls: CallRecord[], variant: Variant): string | null {
    for (const call of calls) {
        const label = call.label ?? 'aiChat';
        const wanted = resolveOverrides(label, { ...DEFAULT_POLICY, overrides: variant.overrides }).model;
        const served = call.response?.servedModel;
        if (wanted && served && served !== wanted && !served.startsWith(`${wanted}-`) && !wanted.startsWith(`${served}-`)) {
            return `${label}: asked for ${wanted}, served ${served}`;
        }
    }
    return null;
}

/**
 * Whether the output may be cut short. aiChat continues a plain-text response that hit
 * max_tokens until it completes, so only a structured one (which it cannot continue, and
 * throws on for the task to handle) can leave the output short.
 */
export function outputTruncated(calls: CallRecord[]): boolean {
    return calls.some(k => k.response?.stopReason === 'max_tokens' && Boolean(k.request.output_config?.format));
}

const RESUME_SETTINGS = ['variant', 'split', 'reps', 'caseSetSha', 'replay'] as const;

/** Settings a resumed run must share with the run it continues, or its rows would mix two experiments. */
export function resumeMismatch(previous: RunManifest, next: RunManifest): string[] {
    return RESUME_SETTINGS.filter(k => canonicalJson(previous[k] ?? null) !== canonicalJson(next[k] ?? null))
        .map(k => `${k} (was ${canonicalJson(previous[k] ?? null)}, now ${canonicalJson(next[k] ?? null)})`);
}

export async function runSuite(opts: RunOptions): Promise<RunOutcome> {
    const suite = opts.suiteImpl ?? getSuite(opts.suite);
    const allCases = opts.cases ?? loadCases(opts.suite);
    let cases = allCases.filter(c => opts.split === 'all' || c.split === opts.split);
    if (opts.caseIds?.length) cases = cases.filter(c => opts.caseIds!.includes(c.id));
    if (opts.limit) cases = cases.slice(0, opts.limit);

    const runId = opts.runId ?? `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${opts.variant.name}-${randomBytes(2).toString('hex')}`;
    const dir = path.join(runsDir(opts.outDir), opts.suite, runId);
    fs.mkdirSync(dir, { recursive: true });
    const resultsFile = path.join(dir, 'results.jsonl');
    const errorsFile = path.join(dir, 'errors.jsonl');
    const manifestFile = path.join(dir, 'manifest.json');

    const rows = readJsonl<ResultRow>(resultsFile);
    const done = new Set(rows.map(r => `${r.caseId}#${r.rep}`));
    const previous = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as RunManifest : null;

    const budget = { limitUsd: opts.budgetUsd, spentUsd: previous?.spentUsd ?? 0 };
    // Phase suites replay their recorded runs by default, with only their own labels live.
    const replay = opts.replay ?? Boolean(suite.replay);
    const live = opts.live ?? suite.replay?.live ?? [];
    const onMiss = replay && opts.live === undefined ? suite.replay?.onMiss : undefined;
    const manifest: RunManifest = {
        runId, suite: opts.suite, variant: opts.variant, split: opts.split, reps: opts.reps, cases: cases.length,
        caseSetSha: caseSetSha(cases), gitRef: git('rev-parse --short HEAD'), gitDirty: git('status --porcelain src evals') !== '',
        startedAt: previous?.startedAt ?? new Date().toISOString(), spentUsd: budget.spentUsd, status: 'running',
        ...(replay && { replay: { live, ...(onMiss && { onMiss }) } }),
    };
    if (previous) {
        const differs = resumeMismatch(previous, manifest);
        if (differs.length) throw new Error(`Cannot resume ${opts.suite}/${runId} with different settings: ${differs.join('; ')}`);
    }
    const writeManifest = () => fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, spentUsd: budget.spentUsd }, null, 2));
    writeManifest();

    // Every mode with a code detector is scored, whatever its status: fire rates per
    // variant are evidence even for modes not yet confirmed. Judges cost money, so not here.
    const modes = modesForSuite(opts.suite).filter(m => m.detector?.kind === 'code');
    const work = cases.flatMap(c => Array.from({ length: opts.reps }, (_, rep) => ({ c, rep }))).filter(({ c, rep }) => !done.has(`${c.id}#${rep}`));
    // A resumed run retries the attempts that errored: their old errors go, or an attempt would count twice.
    const retried = new Set(work.map(({ c, rep }) => `${c.id}#${rep}`));
    const errors = readJsonl<ErrorRow>(errorsFile).filter(e => !retried.has(`${e.caseId}#${e.rep}`) && !done.has(`${e.caseId}#${e.rep}`));
    if (fs.existsSync(errorsFile)) fs.writeFileSync(errorsFile, errors.map(e => JSON.stringify(e) + '\n').join(''));
    let completed = 0;
    let stopped: string | undefined;

    const archive = opts.archive === undefined ? openArchive() : opts.archive;
    const recordings = new Map<string, Promise<ArchivedRun | null>>();
    const recording = (traceId: string) => {
        let r = recordings.get(traceId);
        if (!r) recordings.set(traceId, (r = archive ? readArchivedRun(traceId, archive) : Promise.resolve(null)));
        return r;
    };

    const runOne = async (c: Case, rep: number) => {
        const policy: CallPolicy = {
            mode: replay ? 'replay' : 'live',
            live,
            ...(onMiss && { onMiss }),
            // Live calls must be fresh samples, for repeats and for a production rerun alike;
            // replayed calls come from the cassette or recordings, which this does not touch.
            cacheRead: false,
            cacheWrite: true,
            overrides: opts.variant.overrides,
            budget,
        };
        let state: RunState | undefined;
        const started = Date.now();
        try {
            const recorded = c.replay ? await recording(c.replay) : null;
            if (c.replay && !recorded && (replay || suite.request)) throw new Error(`Recorded run ${c.replay} is not in the archive`);
            if (replay && recorded) policy.cassette = cassetteFromCalls(recorded.calls);
            const request = suite.request ? suite.request(c, recorded) : c.input;
            const meeting = (c.input as { meeting?: unknown } | null)?.meeting;
            const output = await runWithCallPolicy(policy, () => runWithTelemetry({
                taskType: suite.task, taskVersion: null, taskId: `${runId}/${c.id}/${rep}`, env: 'eval',
                input: request, eval: { runId, caseId: c.id, rep }, ...(typeof meeting === 'string' && { meeting }),
            }, () => { state = getRunState(); return suite.run(c, { variant: opts.variant, recorded, request }); }));
            const calls = state?.calls ?? [];
            // Tasks that handle subjects one at a time catch per-item failures: a replay miss or a
            // spent budget would otherwise be scored as a degraded output.
            const failed = policyFailures(calls);
            if (failed.some(k => k.error?.class === 'BudgetExceededError')) throw new BudgetExceededError(budget.limitUsd, budget.spentUsd);
            if (failed.length) throw new PolicyErrorsInRunError(state!.run.traceId, failed, calls.length);
            const mismatch = servedModelMismatch(calls, opts.variant);
            const { usd } = callsCostUsd(calls);
            if (mismatch) {
                const err: ErrorRow = { caseId: c.id, rep, errorClass: 'served-model-mismatch', message: mismatch, traceId: state?.run.traceId, costUsd: usd };
                errors.push(err); fs.appendFileSync(errorsFile, JSON.stringify(err) + '\n');
                return;
            }
            const usage = calls.filter(k => k.response && !k.response.cacheHit).reduce((u, k) => {
                const x = k.response!.usage as Record<string, number>;
                return { input_tokens: u.input_tokens + (x.input_tokens ?? 0), output_tokens: u.output_tokens + (x.output_tokens ?? 0),
                    cache_read_input_tokens: u.cache_read_input_tokens + (x.cache_read_input_tokens ?? 0), cache_creation_input_tokens: u.cache_creation_input_tokens + (x.cache_creation_input_tokens ?? 0) };
            }, { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
            const checks = state && modes.length ? verdictBySlug(await runChecksOnRun({ run: state.run, calls, result: output }, modes)) : {};
            const row: ResultRow = {
                caseId: c.id, rep, fields: suite.score(output, c), ...(suite.detail && { detail: suite.detail(output, c) }), checks, usage, costUsd: usd, latencyMs: Date.now() - started,
                servedModels: [...new Set(calls.map(k => k.response?.servedModel).filter((m): m is string => Boolean(m)))],
                status: outputTruncated(calls) ? 'truncated' : 'ok',
                traceId: state?.run.traceId ?? '', output,
            };
            rows.push(row); fs.appendFileSync(resultsFile, JSON.stringify(row) + '\n');
        } catch (e) {
            if (e instanceof BudgetExceededError) { stopped = e.message; return; }
            const calls = state?.calls ?? [];
            const err: ErrorRow = { caseId: c.id, rep, errorClass: e instanceof Error ? e.name : 'Error', message: e instanceof Error ? e.message.slice(0, 500) : String(e), traceId: state?.run.traceId, costUsd: callsCostUsd(calls).usd };
            errors.push(err); fs.appendFileSync(errorsFile, JSON.stringify(err) + '\n');
        } finally {
            completed++;
            writeManifest();
            opts.onProgress?.(completed, work.length, budget.spentUsd);
        }
    };

    let cursor = 0;
    await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, async () => {
        while (cursor < work.length && !stopped) {
            const { c, rep } = work[cursor++];
            await runOne(c, rep);
        }
    }));

    manifest.finishedAt = new Date().toISOString();
    manifest.status = stopped || cursor < work.length ? 'incomplete' : 'complete';
    if (stopped) manifest.incompleteReason = stopped;
    writeManifest();

    if (archive) {
        for (const file of ['manifest.json', 'results.jsonl', 'errors.jsonl']) {
            const full = path.join(dir, file);
            if (fs.existsSync(full)) {
                await archive.put(archiveKeys.run(opts.suite, runId, file), fs.readFileSync(full))
                    .catch(e => console.error(`Archiving ${file} failed (it stays in ${dir}):`, e instanceof Error ? e.message : e));
            }
        }
    }
    return { runId, manifest: { ...manifest, spentUsd: budget.spentUsd }, rows, errors, dir };
}

/** Loads a run's files from the local mirror, falling back to the archive. */
export async function loadRun(suite: string, runId: string, outDir?: string, archive: ArchiveStore | null = openArchive()): Promise<{ manifest: RunManifest; rows: ResultRow[]; errors: ErrorRow[] }> {
    const dir = path.join(runsDir(outDir), suite, runId);
    if (!fs.existsSync(path.join(dir, 'manifest.json')) && archive) {
        fs.mkdirSync(dir, { recursive: true });
        for (const file of ['manifest.json', 'results.jsonl', 'errors.jsonl']) {
            const body = await archive.get(archiveKeys.run(suite, runId, file));
            if (body) fs.writeFileSync(path.join(dir, file), body);
        }
    }
    const manifestFile = path.join(dir, 'manifest.json');
    if (!fs.existsSync(manifestFile)) throw new Error(`No run ${suite}/${runId} locally or in the archive`);
    return {
        manifest: JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as RunManifest,
        rows: readJsonl<ResultRow>(path.join(dir, 'results.jsonl')),
        errors: readJsonl<ErrorRow>(path.join(dir, 'errors.jsonl')),
    };
}
