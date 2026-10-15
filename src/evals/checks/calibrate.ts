import type { ArchiveStore } from '../../lib/archive/store.js';
import { ReplayMissError, runWithCallPolicy } from '../../lib/llm/callPolicy.js';
import type { CallRecord } from '../../lib/llm/callRecord.js';
import { listBatches, loadResults } from '../review/batch.js';
import { loadDetectorCases } from '../registry/registry.js';
import type { DetectorCase, DetectorCaseKind, FailureMode } from '../registry/schema.js';
import { loadCheck, type Check, type TaskOutput } from './check.js';

/**
 * How well a mode's detector agrees with people: TPR over labelled occurrences, TNR over
 * labelled non-occurrences. Known misses are occurrences and known false alarms are not,
 * so the documented limitations count against the detector here, as they should.
 */

export type Confusion = { tp: number; fn: number; tn: number; fp: number; unknown: number };
export type LabelledVerdict = { source: string; ref: string; truth: boolean; verdict: 'fire' | 'silent' | 'unknown'; why?: string };
export type CalibrationSource = { source: string; confusion: Confusion; note?: string };
export type Calibration = {
    mode: { id: string; slug: string; detector: string };
    sources: CalibrationSource[];
    total: Confusion;
    tpr: number | null;
    tnr: number | null;
    /** Labelled examples the detector got wrong, for reading. */
    disagreements: LabelledVerdict[];
    notes: string[];
};

const OCCURRENCE: Record<DetectorCaseKind, boolean> = { 'must-fire': true, 'known-miss': true, 'must-not-fire': false, 'known-false-alarm': false };

const empty = (): Confusion => ({ tp: 0, fn: 0, tn: 0, fp: 0, unknown: 0 });

function tally(verdicts: LabelledVerdict[]): Confusion {
    const c = empty();
    for (const v of verdicts) {
        if (v.verdict === 'unknown') c.unknown++;
        else if (v.truth) v.verdict === 'fire' ? c.tp++ : c.fn++;
        else v.verdict === 'fire' ? c.fp++ : c.tn++;
    }
    return c;
}

const add = (a: Confusion, b: Confusion): Confusion => ({ tp: a.tp + b.tp, fn: a.fn + b.fn, tn: a.tn + b.tn, fp: a.fp + b.fp, unknown: a.unknown + b.unknown });

/**
 * A judge is only ever read from its recordings here: replay with no live fallback and a
 * zero budget, so a missing recording is `unknown`, never a model call.
 */
async function verdictOf(check: Check, input: CallRecord | TaskOutput, judge: boolean): Promise<{ verdict: LabelledVerdict['verdict']; why?: string }> {
    const run = async () => {
        if (!check.appliesTo(input)) return { verdict: 'unknown' as const, why: 'not applicable' };
        const r = await check.run(input);
        return r.result === 'unknown' ? { verdict: 'unknown' as const, why: r.evidence } : { verdict: r.result === 'fail' ? 'fire' as const : 'silent' as const };
    };
    try {
        return judge
            ? await runWithCallPolicy({ mode: 'replay', onMiss: 'error', cacheWrite: false, budget: { limitUsd: 0, spentUsd: 0 } }, run)
            : await run();
    } catch (e) {
        if (e instanceof ReplayMissError) return { verdict: 'unknown', why: 'no recorded judge output' };
        return { verdict: 'unknown', why: `detector threw: ${(e as Error).message}` };
    }
}

const callKey = (x: unknown): string | undefined => {
    const c = x as { traceId?: string; callId?: string } | null;
    return c?.traceId && c.callId ? `${c.traceId}:${c.callId}` : undefined;
};

export type CalibrateOptions = { store?: ArchiveStore; cases?: DetectorCase[]; check?: Check; root?: string };

export async function calibrate(mode: FailureMode, opts: CalibrateOptions = {}): Promise<Calibration> {
    const detector = mode.detector;
    if (!detector) throw new Error(`${mode.id} ${mode.slug} has no detector to calibrate`);
    const judge = detector.kind === 'judge';
    // Every labelled example counts, not only the sampled share production would judge.
    const check = opts.check ?? await loadCheck(judge ? { ...mode, detector: { ...detector, sample: 1 } } : mode);
    const notes: string[] = [];
    const sources: CalibrationSource[] = [];
    const all: LabelledVerdict[] = [];

    const cases = opts.cases ?? loadDetectorCases(mode, opts.root);
    const caseVerdicts: LabelledVerdict[] = [];
    for (const c of cases) {
        const v = await verdictOf(check, c.input as CallRecord | TaskOutput, judge);
        caseVerdicts.push({ source: 'detector cases', ref: c.file?.split('/').pop() ?? c.kind, truth: OCCURRENCE[c.kind], ...v });
    }
    sources.push({ source: 'detector cases', confusion: tally(caseVerdicts) });
    all.push(...caseVerdicts);

    if (opts.store) {
        const seen = new Set(cases.map(c => callKey(c.input)).filter(Boolean));
        const reviewVerdicts: LabelledVerdict[] = [];
        let batches = 0, duplicates = 0, cantTell = 0;
        for (const batch of await listBatches(opts.store)) {
            if (batch.kind !== 'mode-examples' || batch.modeId !== mode.id) continue;
            const results = await loadResults(opts.store, batch.id);
            if (!results) continue;
            batches++;
            const items = new Map(batch.items.map(i => [i.id, i]));
            for (const r of results.results) {
                const item = items.get(r.itemId);
                if (r.decision === 'cant-tell') { cantTell++; continue; }
                if (!item?.evidence.call || (r.decision !== 'confirm' && r.decision !== 'reject')) continue;
                const key = callKey(item.evidence.call);
                // An applied batch's answers are detector cases already.
                if (key && seen.has(key)) { duplicates++; continue; }
                if (key) seen.add(key);
                const v = await verdictOf(check, item.evidence.call as unknown as CallRecord, judge);
                reviewVerdicts.push({ source: `review ${batch.id}`, ref: item.id, truth: r.decision === 'confirm', ...v });
            }
        }
        const extra = [duplicates && `${duplicates} already detector cases`, cantTell && `${cantTell} can't tell`].filter(Boolean).join(', ');
        sources.push({ source: 'mode-examples reviews', confusion: tally(reviewVerdicts), note: `${batches} batch(es)${extra ? `; ${extra}` : ''}` });
        all.push(...reviewVerdicts);
        // Fired production calls only: confirms and rejects measure precision, not recall.
        if (reviewVerdicts.length) notes.push('mode-examples items were sampled from detector fires, so they weigh towards fp/tp');

        let preferences = 0;
        for await (const key of opts.store.list(`preferences/${mode.suite}/`)) if (key.endsWith('.jsonl')) preferences++;
        notes.push(`pairwise: ${preferences} preference file(s) for ${mode.suite}; they rank two outputs and label no occurrence of this mode, so they are not used`);
    }

    const total = sources.reduce((acc, s) => add(acc, s.confusion), empty());
    if (judge && all.length && all.every(v => v.why === 'no recorded judge output')) notes.push('no recorded judge outputs: run the judge over these examples (it costs model calls) and calibrate again');
    if (judge) notes.push(`a guarded judge needs ≥30 labelled examples per class: have ${total.tp + total.fn} occurrences, ${total.tn + total.fp} non-occurrences with a verdict`);
    const known = cases.filter(c => c.kind === 'known-miss' || c.kind === 'known-false-alarm').length;
    if (known) notes.push(`${known} known-miss/known-false-alarm case(s) count against the detector by design`);

    const rate = (num: number, den: number) => (den ? num / den : null);
    return {
        mode: { id: mode.id, slug: mode.slug, detector: detector.kind === 'code' ? `code ${detector.module}` : `judge ${detector.model}` },
        sources,
        total,
        tpr: rate(total.tp, total.tp + total.fn),
        tnr: rate(total.tn, total.tn + total.fp),
        disagreements: all.filter(v => v.verdict !== 'unknown' && (v.verdict === 'fire') !== v.truth),
        notes,
    };
}

const pct = (r: number | null, num: number, den: number) => (r === null ? 'n/a (no labelled examples)' : `${(100 * r).toFixed(1)}% (${num}/${den})`);

export function formatCalibration(c: Calibration): string {
    const row = (name: string, x: Confusion, note?: string) =>
        `${name.padEnd(24)} ${String(x.tp + x.fn).padStart(4)} ${String(x.tp).padStart(4)} ${String(x.fn).padStart(4)}   ${String(x.tn + x.fp).padStart(4)} ${String(x.tn).padStart(4)} ${String(x.fp).padStart(4)}   ${String(x.unknown).padStart(7)}${note ? `   ${note}` : ''}`;
    const t = c.total;
    return [
        `${c.mode.id} ${c.mode.slug} (${c.mode.detector})`,
        `${'source'.padEnd(24)} ${'pos'.padStart(4)} ${'TP'.padStart(4)} ${'FN'.padStart(4)}   ${'neg'.padStart(4)} ${'TN'.padStart(4)} ${'FP'.padStart(4)}   ${'unknown'.padStart(7)}`,
        ...c.sources.map(s => row(s.source, s.confusion, s.note)),
        row('total', t),
        `TPR ${pct(c.tpr, t.tp, t.tp + t.fn)}   TNR ${pct(c.tnr, t.tn, t.tn + t.fp)}`,
        ...c.disagreements.map(d => `  wrong: ${d.truth ? 'occurrence missed' : 'false alarm'}  ${d.source}  ${d.ref}`),
        ...c.notes.map(n => `note: ${n}`),
    ].join('\n');
}
