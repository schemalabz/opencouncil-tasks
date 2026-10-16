import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import { loadModes, modeBySlug, monitoredModes } from './registry/registry.js';
import { lintRegistry } from './registry/lint.js';
import { lintCases } from './cases/lint.js';
import { recordChecks } from './monitor/postTask.js';
import { runChecksOnRun } from './monitor/runChecks.js';
import { iterateArchivedRuns, requireArchivedRun } from '../lib/runs/fetch.js';
import { openArchive } from '../lib/archive/store.js';
import { RUN_ENVS, type RunEnv } from '../lib/telemetry/context.js';
import { parseEnvOption, parseIntOption } from '../cliOptions.js';
import { getLangfuseClient } from '../lib/observability.js';
import { POSTHOG_READ_ENV, posthogQuery, posthogReadConfig, posthogRequest } from '../lib/telemetry/posthogQuery.js';
import { calibrate, formatCalibration } from './checks/calibrate.js';
import {
    applyPlan, desiredDestination, formatApply, formatPlan, insightData, isWritable, langfuseWriter, planSync, posthogWriter, readLangfuseState, readPosthogDestinations, readPosthogState, testDestination,
    SYNC_PLATFORMS, type PlatformState, type SyncPlatform,
} from './registry/sync.js';

export function registerCheckCommands(evalCmd: Command): void {
    const checks = evalCmd.command('checks').description('Failure-mode checks over archived runs');

    checks.command('run <traceId>')
        .description('Run every monitored failure mode over one archived run and print the verdicts')
        .option('--all-statuses', 'include candidate modes too')
        .option('--record', 'archive and emit the results as the post-task hook would')
        .option('-v, --verbose', 'one line per check instead of one per mode')
        .action(async (traceId: string, o: { allStatuses?: boolean; record?: boolean; verbose?: boolean }) => {
            const archived = await requireArchivedRun(traceId, openArchive());
            const modes = o.allStatuses ? loadModes() : monitoredModes();
            const target = { run: archived.run, calls: archived.calls, result: archived.result };
            const records = await runChecksOnRun(target, modes);
            const line = (r: typeof records[number]) => `${r.result.padEnd(7)} ${r.slug.padEnd(32)} ${r.label ?? '(task)'}${r.evidence ? `  — ${r.evidence.slice(0, 120)}` : ''}`;
            if (o.verbose) records.forEach(r => console.log(line(r)));
            else {
                for (const slug of new Set(records.map(r => r.slug))) {
                    const mine = records.filter(r => r.slug === slug);
                    const count = (result: string) => mine.filter(r => r.result === result).length;
                    console.log(`${slug.padEnd(32)} ${count('pass')} pass, ${count('fail')} fail, ${count('unknown')} unknown`);
                    mine.filter(r => r.result === 'fail').forEach(r => console.log(`  ${line(r)}`));
                }
            }
            if (records.length === 0) console.log('(no check applies to this run)');
            if (o.record) await recordChecks(target, records, openArchive());
        });

    checks.command('backfill [slugs...]')
        .description("Run modes' detectors over archived runs, in one pass, to measure how often each fires before enabling an alert. No slugs: every monitored mode")
        .option('--all-statuses', 'with no slugs: candidate modes too')
        .option('--since <days>', 'how far back', parseIntOption, 90)
        .option('--env <env>', `one of ${RUN_ENVS.join(', ')}`, parseEnvOption, 'production')
        .option('--task <taskType>', 'only runs of this task')
        .option('--examples <n>', 'example trace ids to print per mode', parseIntOption, 10)
        .option('--evidence', "print each example's evidence (what the detector matched)")
        .action(async (slugs: string[], o: { allStatuses?: boolean; since: number; env: RunEnv; task?: string; examples: number; evidence?: boolean }) => {
            const modes = slugs.length
                ? slugs.map(slug => modeBySlug(slug) ?? (() => { throw new Error(`No failure mode with slug ${slug}`); })())
                : (o.allStatuses ? loadModes() : monitoredModes());
            const tally = new Map(modes.map(m => [m.slug, { checked: 0, fired: 0, unknown: 0, examples: [] as string[], why: new Map<string, number>() }]));
            let runs = 0;
            for await (const archived of iterateArchivedRuns({ sinceDays: o.since, env: o.env, task: o.task })) {
                runs++;
                for (const r of await runChecksOnRun({ run: archived.run, calls: archived.calls, result: archived.result }, modes)) {
                    const t = tally.get(r.slug)!;
                    t.checked++;
                    if (r.result === 'fail') { t.fired++; if (t.examples.length < o.examples) t.examples.push(`${r.traceId} ${r.label ?? ''}${o.evidence && r.evidence ? `\n      ${r.evidence.slice(0, 240)}` : ''}`); }
                    if (r.result === 'unknown') {
                        t.unknown++;
                        // Evidence names the call's specifics after a colon; the reason is what precedes it.
                        const why = (r.evidence ?? 'no evidence').split(/[:(]/)[0].trim().slice(0, 80);
                        t.why.set(why, (t.why.get(why) ?? 0) + 1);
                    }
                }
            }
            console.log(`${runs} ${o.env} runs in ${o.since} days`);
            for (const [slug, t] of tally) {
                const rate = t.checked ? ((100 * t.fired) / t.checked).toFixed(2) : 'n/a';
                console.log(`${slug.padEnd(32)} fired ${t.fired}/${t.checked} checks (${rate}%), ${t.unknown} unknown`);
                for (const [why, n] of [...t.why].sort((a, b) => b[1] - a[1]).slice(0, 3)) console.log(`  unknown ×${n}: ${why}`);
                for (const e of t.examples) console.log(`  ${e}`);
            }
        });

    evalCmd.command('lint')
        .description('Lint the case store and the failure-mode registry (npm test runs both, without --git-base)')
        .option('--git-base <ref>', 'also check against this ref (e.g. origin/main): splits, tiers, holdout cases, mode ids and slugs')
        .action((o: { gitBase?: string }) => {
            const issues = [...lintCases(undefined, o.gitBase), ...lintRegistry(undefined, { gitBase: o.gitBase })];
            for (const i of issues) console.log(`${i.rule}: ${i.file}: ${i.message}`);
            console.log(issues.length ? `${issues.length} issue(s)` : 'cases and registry ok');
            if (issues.length) process.exitCode = 1;
        });

    evalCmd.command('sync')
        .description('Mirror the registry onto the platforms: a Langfuse BOOLEAN score config per monitored slug, a PostHog insight and alert per check:<slug>. --plan reads only; --apply writes what eval sync manages')
        .option('--plan', 'print what to create, what is up to date and what is orphaned')
        .option('--apply', 'print the plan, then create Langfuse score configs and create or update the managed PostHog insights and alerts')
        .option('--yes', 'with --apply: skip the confirmation prompt (required when not on a terminal)')
        .option('--only <platform>', `one of ${SYNC_PLATFORMS.join(', ')}`)
        .option('--env <env>', 'environment the PostHog insights filter on', parseEnvOption, 'production')
        .option('--json', 'print the plan as JSON')
        .option('--data', "also print the last intervals of each PostHog insight's query, run through the query API")
        .option('--test-destination', 'after the plan (and apply), send a sample firing alert through the Discord destination')
        .action(async (o: { plan?: boolean; apply?: boolean; yes?: boolean; only?: string; env: RunEnv; json?: boolean; data?: boolean; testDestination?: boolean }) => {
            if (!o.plan && !o.apply) throw new Error('Pass --plan to see the plan, or --apply to write it.');
            if (o.only && !SYNC_PLATFORMS.includes(o.only as SyncPlatform)) throw new Error(`--only takes one of ${SYNC_PLATFORMS.join(', ')}`);
            const only = o.only as SyncPlatform | undefined;
            const wants = (p: SyncPlatform) => !only || only === p;
            // The webhook stays in the environment: it is a secret, never part of the repo.
            const destination = process.env.DISCORD_ALERT_WEBHOOK ? desiredDestination(process.env.DISCORD_ALERT_WEBHOOK) : undefined;
            const lf = wants('langfuse') ? getLangfuseClient() : null;
            const ph = wants('posthog') ? posthogReadConfig() : null;
            const state: Partial<PlatformState> = {
                ...(wants('langfuse') && {
                    langfuse: lf
                        ? await readLangfuseState(page => lf.api.scoreConfigs.get({ page, limit: 100 })).catch(e => ({ error: (e as Error).message.slice(0, 160) }))
                        : { error: 'LANGFUSE_PUBLIC_KEY/SECRET_KEY not set' },
                }),
                ...(wants('posthog') && {
                    posthog: ph
                        ? await readPosthogState(posthogQuery(ph))
                            .then(async st => (destination ? { ...st, destinations: await readPosthogDestinations(posthogRequest(ph)) } : st))
                            .catch(e => ({ error: (e as Error).message.slice(0, 160) }))
                        : { error: `${POSTHOG_READ_ENV} not set` },
                }),
            };
            const plan = planSync(loadModes(), state, o.env, only, destination);
            const where = { langfuse: lf ? process.env.LANGFUSE_BASE_URL ?? process.env.LANGFUSE_BASEURL ?? 'https://cloud.langfuse.com' : undefined, posthog: ph ? `${ph.host} project ${ph.project}` : undefined };
            console.log(o.json ? JSON.stringify({ ...plan, desired: undefined }, null, 2) : formatPlan(plan, where));
            if (o.data && ph) console.log(`\nInsight data (${o.env}):\n${await insightData(plan.desired, posthogRequest(ph))}`);
            const sendTest = async () => {
                if (!o.testDestination) return;
                if (!ph || !destination) throw new Error('--test-destination needs PostHog credentials and DISCORD_ALERT_WEBHOOK');
                const found = (await readPosthogDestinations(posthogRequest(ph))).find(d => d.name === destination.name);
                if (!found) throw new Error(`No destination "${destination.name}" yet: run --apply first`);
                const status = await testDestination(posthogRequest(ph), found.id, destination, `${ph.host}/project/${ph.project}`);
                console.log(`\nTest alert sent through destination ${found.id}: ${status}`);
            };
            if (!o.apply) return sendTest();

            const writable = plan.items.filter(isWritable);
            if (writable.length === 0) return sendTest();
            if (!o.yes) {
                if (!process.stdin.isTTY) throw new Error('--apply writes to the platforms above: pass --yes, or run it on a terminal to confirm.');
                const rl = createInterface({ input: process.stdin, output: process.stdout });
                const answer = await rl.question(`\nWrite ${writable.length} item(s) to ${[...new Set(writable.map(i => where[i.platform]))].join(' and ')}? [y/N] `);
                rl.close();
                if (!/^y(es)?$/i.test(answer.trim())) { console.log('Nothing written.'); return; }
            }
            const report = await applyPlan(plan, {
                ...(lf && { langfuse: langfuseWriter(req => lf.api.scoreConfigs.create(req)) }),
                ...(ph && { posthog: posthogWriter(posthogRequest(ph), ph.project) }),
            });
            console.log(`\nApplied:\n${formatApply(report)}`);
            if (report.results.some(r => r.outcome === 'failed') || Object.keys(report.stopped).length) process.exitCode = 1;
            else await sendTest();
        });

    evalCmd.command('calibrate <slug>')
        .description("TPR/TNR of a mode's detector over its labelled detector cases and the archive's mode-examples review results. Judges are read from recordings only, never called")
        .option('--no-archive', 'detector cases only')
        .option('--json', 'print the calibration as JSON')
        .action(async (slug: string, o: { archive: boolean; json?: boolean }) => {
            const mode = modeBySlug(slug);
            if (!mode) throw new Error(`No failure mode with slug ${slug}`);
            const c = await calibrate(mode, { store: o.archive ? openArchive() : undefined });
            console.log(o.json ? JSON.stringify(c, null, 2) : formatCalibration(c));
        });
}
