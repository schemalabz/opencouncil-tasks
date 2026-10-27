import type { Command } from 'commander';
import { loadVariant } from './run/variants.js';
import { loadRun, runSuite } from './run/runner.js';
import { loadCases } from './cases/caseStore.js';
import { getSuite } from './suites/registry.js';
import { compareRuns, formatComparison } from './compare/compare.js';
import { evaluateGate, loadGate } from './compare/gate.js';
import { flushTelemetry } from '../lib/telemetry/telemetry.js';
import type { Split } from './types.js';
import { collect, parsePositiveIntOption, parseUsdOption } from '../cliOptions.js';

export function registerRunCommands(evalCmd: Command): void {
    evalCmd.command('run <suite>')
        .description('Run a suite on a variant: every case × repeat through production code, scored, archived')
        .requiredOption('--variant <name>', 'variant name (evals/variants/<name>.yaml) or path')
        .option('--split <split>', 'dev | holdout | all', 'dev')
        .option('--reps <n>', 'repeats per case', parsePositiveIntOption, 1)
        .option('--concurrency <n>', 'cases in parallel', parsePositiveIntOption, 4)
        .option('--budget-usd <n>', 'spend ceiling for this run', parseUsdOption, 2)
        .option('--limit <n>', 'only the first N cases (after the split filter)', parsePositiveIntOption)
        .option('--case <id>', 'only this case id (repeatable)', collect, [])
        .option('--override <spec>', 'extra per-label override, e.g. decision-reading.model=claude-haiku-5-5 (repeatable)', collect, [])
        .option('--hints-file <file>', 'conventions file for extraction suites (as production sends)')
        .option('--replay', 'serve LLM calls from recordings; see --live')
        .option('--live <glob>', 'label glob that stays live under --replay (repeatable); default: the suite\'s own labels', collect, [])
        .option('--no-live', 'with --replay, serve every call from the recording, the suite\'s own labels included ($0)')
        .option('--resume <runId>', 'continue an earlier run')
        .action(async (suiteId: string, o: { variant: string; split: string; reps: number; concurrency: number; budgetUsd: number; limit?: number; case: string[]; override: string[]; hintsFile?: string; replay?: boolean; live: string[] | false; resume?: string }) => {
            const variant = loadVariant(o.variant, { override: o.override, params: o.hintsFile ? { hintsFile: o.hintsFile } : undefined });
            let last = 0;
            const r = await runSuite({
                suite: suiteId, variant, split: o.split as Split | 'all', reps: o.reps, concurrency: o.concurrency,
                budgetUsd: o.budgetUsd, limit: o.limit, caseIds: o.case, replay: o.replay, live: o.live === false ? [] : o.live.length ? o.live : undefined, runId: o.resume,
                onProgress: (done, total, spent) => { if (done - last >= 10 || done === total) { last = done; console.log(`  ${done}/${total}  $${spent.toFixed(2)}`); } },
            });
            await flushTelemetry();
            console.log(`\nrun ${r.runId}: ${r.manifest.status}${r.manifest.incompleteReason ? ` (${r.manifest.incompleteReason})` : ''} · ${r.rows.length} rows · ${r.errors.length} errors · $${r.manifest.spentUsd.toFixed(3)} · ${r.dir}`);
        });

    evalCmd.command('compare <suite> <runA> <runB>')
        .description('Paired comparison of two runs of a suite (A = baseline)')
        .option('--show-holdout', 'list holdout case ids (keep off while iterating on a change)')
        .option('--json', 'print the comparison as JSON')
        .action(async (suiteId: string, a: string, b: string, o: { showHoldout?: boolean; json?: boolean }) => {
            const cmp = compareRuns(await loadRun(suiteId, a), await loadRun(suiteId, b), loadCases(suiteId));
            console.log(o.json ? JSON.stringify(cmp, null, 2) : formatComparison(cmp, { showHoldoutCases: o.showHoldout }));
        });

    evalCmd.command('report <suite> <runId>')
        .description("The suite's own summary of a run (matching: recall and precision; speaker id: the backtest tables)")
        .action(async (suiteId: string, runId: string) => {
            const suite = getSuite(suiteId);
            if (!suite.report) throw new Error(`Suite ${suiteId} has no report`);
            const run = await loadRun(suiteId, runId);
            console.log(suite.report(run.rows, loadCases(suiteId)));
        });

    evalCmd.command('gate <suite> <runA> <runB>')
        .description("Apply the suite's gate (evals/gates/<suite>.yaml) to a comparison; exits 1 unless PASS")
        .action(async (suiteId: string, a: string, b: string) => {
            const cmp = compareRuns(await loadRun(suiteId, a), await loadRun(suiteId, b), loadCases(suiteId));
            const gate = evaluateGate(cmp, loadGate(suiteId));
            console.log(`GATE ${suiteId}: ${gate.verdict}`);
            for (const reason of gate.reasons) console.log(`  - ${reason}`);
            if (gate.verdict !== 'PASS') process.exitCode = 1;
        });
}
