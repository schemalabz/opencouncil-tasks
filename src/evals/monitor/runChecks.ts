import type { CallRecord } from '../../lib/llm/callRecord.js';
import type { RunInfo } from '../../lib/telemetry/context.js';
import { loadCheck, type Check, type CheckResult } from '../checks/check.js';
import type { FailureMode } from '../registry/schema.js';

export type CheckRecord = {
    traceId: string;
    modeId: string;
    slug: string;
    scope: 'call' | 'task';
    callId?: string;
    label?: string;
    result: CheckResult['result'];
    evidence?: string;
    at: string;
};

export type CheckableRun = { run: RunInfo; calls: CallRecord[]; result?: unknown };

const loaded = new Map<string, Promise<Check>>();
const checkFor = (mode: FailureMode) => {
    let p = loaded.get(mode.id);
    if (!p) { p = loadCheck(mode); loaded.set(mode.id, p); }
    return p;
};

/**
 * Every applicable check of the given modes over one run. A detector that throws
 * yields `unknown`, never a pass, so a broken check can't hide a failure.
 */
export async function runChecksOnRun(target: CheckableRun, modes: FailureMode[]): Promise<CheckRecord[]> {
    const records: CheckRecord[] = [];
    const at = new Date().toISOString();
    for (const mode of modes) {
        if (!mode.detector) continue;
        let check: Check;
        try { check = await checkFor(mode); } catch (e) {
            records.push({ traceId: target.run.traceId, modeId: mode.id, slug: mode.slug, scope: mode.scope, result: 'unknown', evidence: `detector failed to load: ${e instanceof Error ? e.message : e}`, at });
            continue;
        }
        const inputs = mode.scope === 'call'
            ? target.calls.map(call => ({ input: call as CallRecord, call }))
            : [{ input: { run: target.run, result: target.result, calls: target.calls }, call: undefined }];
        for (const { input, call } of inputs) {
            if (!check.appliesTo(input)) continue;
            let out: CheckResult;
            try { out = await check.run(input); } catch (e) { out = { result: 'unknown', evidence: `detector threw: ${e instanceof Error ? e.message : e}` }; }
            records.push({ traceId: target.run.traceId, modeId: mode.id, slug: mode.slug, scope: mode.scope, ...(call && { callId: call.callId, label: call.label }), result: out.result, evidence: out.evidence, at });
        }
    }
    return records;
}

/** One verdict per mode for a run: fired if any record fired, passed if any passed, else unknown. */
export function verdictBySlug(records: CheckRecord[]): Record<string, 'pass' | 'fail' | 'unknown'> {
    const out: Record<string, 'pass' | 'fail' | 'unknown'> = {};
    for (const r of records) {
        const prev = out[r.slug];
        if (r.result === 'fail' || prev === 'fail') out[r.slug] = 'fail';
        else if (r.result === 'pass' || prev === 'pass') out[r.slug] = 'pass';
        else out[r.slug] = 'unknown';
    }
    return out;
}
