import fs from 'fs';
import type { Command } from 'commander';
import { openArchive } from '../lib/archive/store.js';
import { drainSpool } from '../lib/archive/spool.js';
import { importLangfuseRuns } from '../lib/runs/langfuseImport.js';
import { cassetteFromCalls } from '../lib/llm/cassette.js';
import type { CallPolicy } from '../lib/llm/callPolicy.js';
import type { RunEnv } from '../lib/telemetry/context.js';
import { collect, parseEnvOption, parseIntOption, parseUsdOption } from '../cliOptions.js';
import { readArchivedRun } from '../lib/telemetry/archiveSink.js';
import { flushTelemetry } from '../lib/telemetry/telemetry.js';
import { getDataDir } from '../lib/dataDir.js';
import { lintCases } from './cases/lint.js';
import { casesRoot, locateCase, privateCasesRoot, readCase, writeCase } from './cases/caseStore.js';
import { getSuite } from './suites/registry.js';
import { isTaskName, runTask } from './taskRunner.js';
import type { TaskName } from '../tasks/registry.js';
import { parseOverrides } from './run/variants.js';
import { registerRunCommands } from './runCommands.js';
import { registerCheckCommands } from './checkCommands.js';
import { registerReviewCommands } from './reviewCommands.js';
import { registerTelemetryCommands } from './telemetryCommands.js';
import { settleMonitoring, startMonitoring } from './monitor/postTask.js';

/** A meeting payload from a saved file, or from opencouncil's public endpoint for cityId/meetingId. */
async function readMeetingPayload(ref: string, baseUrl: string): Promise<{ meeting: string; payload: unknown }> {
    if (fs.existsSync(ref)) {
        const payload = JSON.parse(fs.readFileSync(ref, 'utf8')) as { meeting?: { id?: string; cityId?: string } };
        if (!payload.meeting?.id || !payload.meeting.cityId) throw new Error(`${ref} is not a meeting payload (no meeting.id / meeting.cityId)`);
        return { meeting: `${payload.meeting.cityId}/${payload.meeting.id}`, payload };
    }
    const m = ref.match(/^([^/]+)\/([^/]+)$/);
    if (!m) throw new Error(`Expected cityId/meetingId or a file path, got "${ref}"`);
    const url = `${baseUrl.replace(/\/$/, '')}/api/cities/${encodeURIComponent(m[1])}/meetings/${encodeURIComponent(m[2])}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} responded ${response.status}`);
    const payload = await response.json() as { transcriptHiddenForReview?: boolean };
    if (payload.transcriptHiddenForReview) throw new Error(`${ref}: the transcript is hidden for review; the public endpoint returns it empty`);
    return { meeting: ref, payload };
}

export function registerEvalCommands(program: Command): void {
    const evalCmd = program.command('eval').description('Evaluation pipeline: run tasks under a call policy, replay recorded runs, manage the archive');
    // Servers archive only to an explicit ARCHIVE_URL; on a dev machine eval commands default to the data dir.
    evalCmd.hook('preAction', () => { process.env.ARCHIVE_URL ??= `file://${getDataDir()}/archive`; });

    evalCmd.command('task')
        .command('run <taskName>')
        .description('Run a registered task with a request file, recording every LLM call to the archive')
        .requiredOption('--request <file>', 'request JSON file, or - for stdin')
        .option('--env <env>', 'run environment tag: development | eval', parseEnvOption, 'development')
        .option('--replay', 'serve every LLM call from recordings (no network); see --live and --cassette')
        .option('--cassette <traceId>', 'replay strictly from this archived run, in recorded order')
        .option('--live <glob>', 'label glob that stays live under --replay (repeatable)', collect, [])
        .option('--on-miss <mode>', 'a replayed call with no recording: error | live', 'error')
        .option('--override <spec>', 'per-label override, e.g. decision-reading.model=claude-haiku-5-5 (repeatable)', collect, [])
        .option('--no-cache-read', 'never serve a stored response (fresh samples)')
        .option('--budget-usd <n>', 'stop before a live call once this much has been spent', parseUsdOption, 5)
        .option('--meeting <cityId/meetingId>', 'meeting the run belongs to (for telemetry)')
        .option('--sinks <list>', 'telemetry sinks for this run (archive,langfuse,posthog)')
        .option('--out <file>', 'write {traceId, result, costUsd, liveCalls} as JSON')
        .action(async (taskName: string, opts: { request: string; env: RunEnv; replay?: boolean; cassette?: string; live: string[]; onMiss: string; override: string[]; cacheRead: boolean; budgetUsd: number; meeting?: string; sinks?: string; out?: string }) => {
            if (!(await isTaskName(taskName))) throw new Error(`Unknown task "${taskName}"`);
            if (opts.sinks) process.env.TELEMETRY_SINKS = opts.sinks;
            const request = JSON.parse(opts.request === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(opts.request, 'utf8'));
            const policy: Partial<CallPolicy> = {
                mode: opts.replay || opts.cassette ? 'replay' : 'live',
                live: opts.live,
                onMiss: opts.onMiss === 'live' ? 'live' : 'error',
                overrides: parseOverrides(opts.override),
                budget: { limitUsd: opts.budgetUsd, spentUsd: 0 },
                ...(opts.cacheRead === false && { cacheRead: false }),
            };
            if (opts.cassette) {
                const recorded = await readArchivedRun(opts.cassette);
                if (!recorded) throw new Error(`No archived run with trace id ${opts.cassette}`);
                policy.cassette = cassetteFromCalls(recorded.calls);
            }
            const started = Date.now();
            const stopMonitoring = startMonitoring();
            const out = await runTask(taskName as TaskName, request, { env: opts.env, policy, meeting: opts.meeting });
            const replayed = out.calls.filter(c => c.response?.replayed).length;
            console.log(`\n${taskName}: trace ${out.traceId} · ${out.calls.length} calls (${out.liveCalls} live, ${replayed} replayed) · $${out.costUsd.toFixed(4)} · ${((Date.now() - started) / 1000).toFixed(1)}s`);
            if (opts.out) fs.writeFileSync(opts.out, JSON.stringify({ traceId: out.traceId, result: out.result, costUsd: out.costUsd, liveCalls: out.liveCalls, calls: out.calls.length }, null, 2));
            await settleMonitoring();
            stopMonitoring();
            await flushTelemetry();
        });

    const cases = evalCmd.command('cases').description('The tiered case store under evals/cases');
    cases.command('lint')
        .description('Check every case file: schema, unique ids, imported signals; with --git-base, split immutability, tier downgrades and deleted holdout cases')
        .option('--git-base <ref>', 'compare each case file to its version at this ref')
        .action((opts: { gitBase?: string }) => {
            const issues = lintCases(undefined, opts.gitBase);
            for (const i of issues) console.log(`${i.file}: [${i.rule}] ${i.message}`);
            console.log(issues.length ? `${issues.length} issue(s)` : 'cases ok');
            if (issues.length) process.exitCode = 1;
        });

    cases.command('from-run <suite> <traceId...>')
        .description('Write one case per recorded run for a suite whose cases are recorded runs (summarize.*, agenda.*, fix.transcript); expectations are the run\'s own output, tier drafted, except values a person already settled')
        .option('--meeting <cityId/meetingId>', 'the meeting of a run recorded without one (one trace id only)')
        .action(async (suiteId: string, traceIds: string[], o: { meeting?: string }) => {
            const suite = getSuite(suiteId);
            if (!suite.caseFromRun) throw new Error(`Suite ${suiteId} does not build cases from recorded runs`);
            if (o.meeting && traceIds.length !== 1) throw new Error('--meeting names the meeting of a single run');
            for (const traceId of traceIds) {
                const recorded = await readArchivedRun(traceId);
                if (!recorded) throw new Error(`No archived run with trace id ${traceId}`);
                const drafted = suite.caseFromRun(recorded, { meeting: o.meeting });
                const found = locateCase(drafted.id);
                const existing = found?.case;
                // A regenerated case keeps its split (lint refuses a changed split), its history, and every
                // value a person settled: only drafted values are the new run's to replace.
                const settled = Object.fromEntries(Object.entries(existing?.expect ?? {}).filter(([, e]) => e.tier !== 'drafted'));
                const c = existing ? { ...drafted, split: existing.split, history: existing.history, expect: { ...drafted.expect, ...settled } } : drafted;
                const file = writeCase(c, found?.root);
                console.log(`${existing ? 'updated' : 'wrote  '} ${file}  (${Object.keys(c.expect).length} expected fields, ${Object.keys(settled).length} kept as settled, cluster ${c.cluster}, ${c.split})`);
            }
        });

    cases.command('from-meeting <suite> <meetings...>')
        .description("Write one case per meeting for a suite read from opencouncil's public meeting payload (fix.speaker-id). Each meeting is cityId/meetingId, or a saved copy of the payload; cases go to the private case root")
        .option('--base-url <url>', 'opencouncil base URL', 'https://opencouncil.gr')
        .action(async (suiteId: string, refs: string[], o: { baseUrl: string }) => {
            const suite = getSuite(suiteId);
            if (!suite.caseFromMeeting) throw new Error(`Suite ${suiteId} does not build cases from a meeting payload`);
            for (const ref of refs) {
                const { meeting, payload } = await readMeetingPayload(ref, o.baseUrl);
                const c = suite.caseFromMeeting(meeting, payload);
                if (readCase(c.id, casesRoot())) {
                    console.log(`skipped ${c.id}: already committed under ${casesRoot()}`);
                    continue;
                }
                const existing = readCase(c.id, privateCasesRoot());
                const file = writeCase(existing ? { ...c, split: existing.split, history: existing.history } : c, privateCasesRoot());
                console.log(`${existing ? 'updated' : 'wrote  '} ${file}  (${Object.keys(c.expect).length} expected fields, ${Object.values(c.expect).filter(e => e.tier === 'imported').length} imported, ${c.split})`);
            }
        });

    registerRunCommands(evalCmd);
    registerCheckCommands(evalCmd);
    registerReviewCommands(evalCmd);
    registerTelemetryCommands(evalCmd);

    const archive = evalCmd.command('archive').description('The long-term archive of calls, runs and blobs');
    archive.command('selftest')
        .description('Write, read and list a probe object in the configured archive')
        .action(async () => {
            const store = openArchive();
            const key = `selftest/${process.pid}-${Date.now()}`;
            await store.put(key, 'probe', 'text/plain');
            const back = (await store.get(key))?.toString();
            let listed = false;
            for await (const k of store.list('selftest/')) if (k === key) listed = true;
            if (back !== 'probe' || !listed) throw new Error(`archive selftest failed (read ${back}, listed ${listed})`);
            console.log(`archive ok ${store.url}`);
        });
    archive.command('drain')
        .description('Resend archive writes spooled locally after a failure')
        .action(async () => {
            const { sent, failed } = await drainSpool(openArchive());
            console.log(`spool: ${sent} sent, ${failed} still failing`);
        });
    archive.command('import-langfuse')
        .description("Copy Langfuse traces into the archive (prompts and outputs verbatim) so checks and backfills cover history from before archiving, and outlive Langfuse's retention")
        .option('--env <env>', 'Langfuse environment', parseEnvOption, 'production')
        .option('--since <days>', 'how far back', parseIntOption, 30)
        .option('--task <taskType>', 'only traces of this task')
        .option('--limit <n>', 'at most this many traces', parseIntOption)
        .option('--concurrency <n>', 'traces fetched in parallel', parseIntOption, 4)
        .action(async (o: { env: RunEnv; since: number; task?: string; limit?: number; concurrency: number }) => {
            let last = 0;
            const summary = await importLangfuseRuns(openArchive(), {
                env: o.env, sinceDays: o.since, task: o.task, limit: o.limit, concurrency: o.concurrency,
                onProgress: (done, total) => { if (done - last >= 25 || done === total) { last = done; console.log(`  ${done}/${total}`); } },
            });
            console.log(`langfuse ${o.env}: ${summary.listed} traces · ${summary.imported} imported (${summary.calls} calls) · ${summary.skipped} already archived · ${summary.failed} failed`);
            if (summary.failed) process.exitCode = 1;
        });
}
