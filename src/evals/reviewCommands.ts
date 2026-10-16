import fs from 'fs';
import type { Command } from 'commander';
import { openArchive } from '../lib/archive/store.js';
import { RUN_ENVS, type RunEnv } from '../lib/telemetry/context.js';
import { collect, parseEnvOption, parseIntOption } from '../cliOptions.js';
import { getCandidates, listCandidates, type Candidate, type CandidateSource } from './harvest/candidate.js';
import { CANDIDATE_SOURCES, collectCandidates, harvest, type HarvestOptions } from './harvest/harvest.js';
import { harvestOpencouncil } from './harvest/sources/opencouncil.js';
import { privateCasesRoot } from './cases/caseStore.js';
import { loadModes } from './registry/registry.js';
import { SUITES } from './suites/registry.js';
import { applyBatch } from './review/apply.js';
import { listBatches, loadBatch, REVIEW_KINDS, saveBatch, submitResults, type ReviewBatch, type ReviewKind } from './review/batch.js';
import { buildBatch, buildPairwiseBatch } from './review/build.js';
import { renderPage } from './review/render/page.js';
import { serveBatch } from './review/server.js';

function age(iso: string, now = Date.now()): string {
    const h = (now - new Date(iso).getTime()) / 3_600_000;
    return h < 1 ? `${Math.max(0, Math.round(h * 60))}m` : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`;
}

/** candidate id → the batch that holds it (the latest, when several do). */
function batchesByCandidate(batches: ReviewBatch[]): Map<string, ReviewBatch> {
    const out = new Map<string, ReviewBatch>();
    for (const b of batches) for (const i of b.items) if (i.candidateId) out.set(i.candidateId, b);
    return out;
}

function candidateLine(c: Candidate, batch?: ReviewBatch): string {
    const where = c.caseId ?? `${c.traceId}${c.label ? ` ${c.label}` : ''}`;
    return `${c.id}  ${c.signal.padEnd(34)} ${age(c.createdAt).padStart(4)}  ${where}${batch ? `  [${batch.status} in ${batch.id}]` : ''}`;
}

export function registerReviewCommands(evalCmd: Command): void {
    evalCmd.command('harvest [suite]')
        .description('Turn signals into cases: monitoring (failed checks), disagreement (a suite run vs drafted/contested values), novelty (production inputs unlike every case) write candidates to the archive; opencouncil (an exported signal file) writes imported cases to the private case root')
        .requiredOption('--source <source>', [...CANDIDATE_SOURCES, 'opencouncil'].join(' | '))
        .option('--since <days>', 'monitoring, novelty: how far back', parseIntOption, 14)
        .option('--env <env>', `monitoring, novelty: one of ${RUN_ENVS.join(', ')}`, parseEnvOption, 'production')
        .option('--run <runId>', 'disagreement: a run of the suite (repeatable)', collect, [])
        .option('--all-statuses', 'monitoring: also fired checks of candidate modes (recorded with eval checks run --all-statuses --record)')
        .option('--dry-run', 'print the candidates without writing them')
        .option('--signals <file>', 'opencouncil: the JSONL written by its scripts/export-eval-signals.ts (with --contexts)')
        .action(async (suite: string | undefined, o: { source: string; since: number; env: RunEnv; run: string[]; allStatuses?: boolean; dryRun?: boolean; signals?: string }) => {
            if (o.source === 'opencouncil') {
                if (!o.signals) throw new Error('harvest --source opencouncil needs --signals <file>');
                const r = harvestOpencouncil(o.signals, { suite });
                for (const f of r.written) console.log(`wrote    ${f}`);
                for (const f of r.updated) console.log(`updated  ${f}`);
                for (const s of r.skipped) console.log(`skipped  ${s}`);
                for (const [what, n] of Object.entries(r.unused)) console.log(`unused   ${n} ${what}`);
                console.log(`${r.written.length} new and ${r.updated.length} updated imported case(s) in ${privateCasesRoot()} (gitignored: production content stays on this machine)`);
                return;
            }
            const store = openArchive();
            const opts: HarvestOptions = {
                source: o.source as CandidateSource, suite, env: o.env, sinceDays: o.since, runIds: o.run,
                ...(o.allStatuses && { modes: loadModes() }),
                noveltyStats: {},
            };
            const printStats = () => {
                for (const [s, n] of Object.entries(opts.noveltyStats ?? {})) console.log(`scanned ${s}: ${n.seen} ${SUITES[s]?.caseFromCall ? 'calls' : 'runs'}, ${n.placed} name a case, ${n.known} of those already cases`);
            };
            if (o.dryRun) {
                const found = await collectCandidates(store, opts);
                for (const c of found) console.log(`would  ${candidateLine(c)}${c.evidence ? `\n         ${c.evidence}` : ''}`);
                printStats();
                console.log(`${found.length} candidate(s), none written (--dry-run)`);
                return;
            }
            const { written, existing } = await harvest(store, opts);
            for (const c of written) console.log(`new       ${candidateLine(c)}`);
            for (const c of existing) console.log(`existing  ${candidateLine(c)}`);
            printStats();
            console.log(`${written.length} new candidate(s), ${existing.length} already harvested (${store.url})`);
        });

    evalCmd.command('candidates [suite]')
        .description('Candidates not yet settled by an applied review batch')
        .option('--signal <prefix>', 'only signals starting with this, e.g. check:context_disclaimer_preamble')
        .option('--all', 'include candidates whose batch was applied')
        .action(async (suite: string | undefined, o: { signal?: string; all?: boolean }) => {
            const store = openArchive();
            const inBatch = batchesByCandidate(await listBatches(store));
            const shown = (await listCandidates(store, suite))
                .filter(c => !o.signal || c.signal.startsWith(o.signal))
                .filter(c => o.all || inBatch.get(c.id)?.status !== 'applied');
            const bySuite = new Map<string, Candidate[]>();
            for (const c of shown) bySuite.set(c.suite, [...(bySuite.get(c.suite) ?? []), c]);
            for (const [s, cs] of bySuite) {
                console.log(`${s} (${cs.length})`);
                for (const c of cs) console.log(`  ${candidateLine(c, inBatch.get(c.id))}`);
            }
            if (shown.length === 0) console.log('(no open candidates)');
        });

    const review = evalCmd.command('review').description('Review batches: the pages where a person settles candidates');

    review.command('build <kind>')
        .description(`Build a batch and its page from open candidates: ${REVIEW_KINDS.join(' | ')}`)
        .option('--candidate <id>', 'a candidate id (repeatable)', collect, [])
        .option('--suite <suite>', 'every open candidate of this suite')
        .option('--signal <prefix>', 'every open candidate whose signal starts with this')
        .option('--limit <n>', 'cap on candidates in the batch', parseIntOption, 30)
        .option('--name <slug>', 'name in the batch id')
        .option('--run <runId>', 'pairwise: a run of --suite; give two, the baseline first', collect, [])
        .action(async (kind: string, o: { candidate: string[]; suite?: string; signal?: string; limit: number; name?: string; run: string[] }) => {
            const store = openArchive();
            if (!REVIEW_KINDS.includes(kind as ReviewKind)) throw new Error(`Unknown review kind "${kind}" (expected ${REVIEW_KINDS.join(' | ')})`);
            if (kind === 'pairwise') {
                if (!o.suite || o.run.length !== 2) throw new Error('A pairwise batch needs --suite and two --run ids (baseline first)');
                const batch = await buildPairwiseBatch(o.suite, [o.run[0], o.run[1]], { store, name: o.name, limit: o.limit });
                await saveBatch(store, batch, renderPage(batch));
                console.log(`batch ${batch.id}: pairwise, ${batch.items.length} item(s) where ${batch.runs!.baseline.variant} and ${batch.runs!.candidate.variant} differ, status open`);
                console.log(`next: eval review open ${batch.id}`);
                return;
            }
            let picked: Candidate[];
            if (o.candidate.length) picked = await getCandidates(store, o.candidate);
            else {
                if (!o.suite && !o.signal) throw new Error('Name the candidates: --candidate <id>, --suite <suite> or --signal <prefix>');
                const inBatch = batchesByCandidate(await listBatches(store));
                picked = (await listCandidates(store, o.suite))
                    .filter(c => !o.signal || c.signal.startsWith(o.signal))
                    .filter(c => !inBatch.has(c.id));
            }
            picked = picked.slice(0, o.limit);
            const batch = await buildBatch(kind as ReviewKind, picked, { store, name: o.name });
            const mode = batch.modeId ? loadModes().find(m => m.id === batch.modeId) : undefined;
            await saveBatch(store, batch, renderPage(batch, { mode }));
            console.log(`batch ${batch.id}: ${batch.kind}, ${batch.items.length} item(s) from ${picked.length} candidate(s), status open`);
            console.log(`next: eval review open ${batch.id}`);
        });

    review.command('open <batchId>')
        .description('Serve the batch page on localhost with each item\'s archived source; a submit there writes results.json')
        .option('--port <n>', 'port (default: any free one)', parseIntOption, 0)
        .option('--page <file>', 'also write the page to this file, to open or send without the server')
        .option('--exit-on-submit', 'stop serving once results are submitted')
        .action(async (batchId: string, o: { port: number; page?: string; exitOnSubmit?: boolean }) => {
            const store = openArchive();
            const batch = await loadBatch(store, batchId);
            if (o.page) {
                const mode = batch.modeId ? loadModes().find(m => m.id === batch.modeId) : undefined;
                fs.writeFileSync(o.page, renderPage(batch, { mode }));
                console.log(`page written to ${o.page}`);
            }
            let stop = () => {};
            const server = await serveBatch(store, batchId, {
                port: o.port,
                onSubmit: b => {
                    console.log(`results submitted by ${b.history.at(-1)?.by}; next: eval review apply ${b.id}`);
                    if (o.exitOnSubmit) stop();
                },
            });
            console.log(`batch ${batchId} (${batch.status}, ${batch.items.length} items) at ${server.url}  — Ctrl-C to stop`);
            await new Promise<void>(resolve => {
                stop = () => { void server.close().then(resolve); };
                process.once('SIGINT', stop);
            });
        });

    review.command('submit <batchId> <resultsFile>')
        .description('Submit a results file downloaded from the page (when it was reviewed without the server)')
        .action(async (batchId: string, file: string) => {
            const store = openArchive();
            const next = await submitResults(store, await loadBatch(store, batchId), JSON.parse(fs.readFileSync(file, 'utf8')));
            console.log(`batch ${batchId}: ${next.status} by ${next.history.at(-1)?.by}; next: eval review apply ${batchId}`);
        });

    review.command('apply <batchId>')
        .description('Write a submitted batch\'s results into case and failure-mode files in the working tree, lint them, print a PR body')
        .action(async (batchId: string) => {
            const out = await applyBatch(openArchive(), batchId);
            for (const f of out.files) console.log(`wrote ${f}`);
            if (out.issues.length) {
                for (const i of out.issues) console.log(`${i.rule}: ${i.file}: ${i.message}`);
                console.log(`\n${out.issues.length} lint issue(s): nothing written, batch left ${out.batch.status}; fix them and apply again`);
                process.exitCode = 1;
                return;
            }
            if (out.plan.preferences) {
                const by = (k: string) => out.plan.preferences!.filter(p => p.preferred === k).length;
                const { baseline, candidate } = out.batch.runs!;
                console.log(`batch ${batchId}: applied. ${out.plan.preferences.length} preference(s) archived: baseline ${baseline.variant} ${by('baseline')} · candidate ${candidate.variant} ${by('candidate')} · same ${by('same')} · can't tell ${by('cant-tell')}`);
                return;
            }
            console.log(`\nbatch ${batchId}: applied. eval lint: cases and registry ok`);
            console.log(`Commit on a branch, e.g. git switch -c review/${batchId}, and open a PR with:\n`);
            console.log(out.prBody);
        });

    evalCmd.command('status')
        .description('Pending human work: review batches open or submitted, and open candidates')
        .option('--all', 'include applied batches')
        .action(async (o: { all?: boolean }) => {
            const store = openArchive();
            const batches = await listBatches(store);
            const shown = batches.filter(b => o.all || b.status !== 'applied');
            const waiting: Record<ReviewBatch['status'], (id: string) => string> = {
                open: id => `waiting for a person: eval review open ${id}`,
                submitted: id => `waiting for the agent: eval review apply ${id}`,
                applied: () => 'applied: case/registry files written for a PR (pairwise: preferences archived)',
            };
            console.log(`Review batches (${shown.length}${o.all ? '' : ` pending of ${batches.length}`})`);
            for (const b of shown) {
                const trail = b.history.map(h => `${h.status} ${h.at.slice(0, 16).replace('T', ' ')}${h.by ? ` (${h.by})` : ''}`).join(' → ');
                console.log(`  ${b.id}  ${b.kind}  ${b.suite}  ${b.items.length} items  ${b.status.toUpperCase()}`);
                console.log(`      ${trail}`);
                console.log(`      ${waiting[b.status](b.id)}`);
            }
            const inBatch = batchesByCandidate(batches);
            const open = (await listCandidates(store)).filter(c => !inBatch.has(c.id));
            const bySignal = new Map<string, number>();
            for (const c of open) bySignal.set(`${c.suite} ${c.signal}`, (bySignal.get(`${c.suite} ${c.signal}`) ?? 0) + 1);
            console.log(`Candidates not in any batch (${open.length})`);
            for (const [k, n] of bySignal) console.log(`  ${n}  ${k}`);
        });
}
