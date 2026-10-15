import type { CallRecord } from '../../lib/llm/callRecord.js';
import { loadDetectorCases } from '../registry/registry.js';
import type { DetectorCase, DetectorCaseKind, FailureMode } from '../registry/schema.js';
import { loadCheck, type Check, type CheckResult, type TaskOutput } from './check.js';

export type DetectorCaseOutcome = { case: DetectorCase; ok: boolean; got?: CheckResult; why?: string };

/**
 * What the detector must return on each kind. Known misses and known false alarms
 * are strict, as in pytest's xfail(strict=True): when the documented limitation goes
 * away the case fails, so someone promotes it instead of it rotting. `unknown` is never
 * silence: a detector that stops recognising its input would otherwise pass every case
 * that expects it to stay quiet. A case that wants `unknown` says so with `expect`.
 */
const EXPECTED: Record<DetectorCaseKind, 'pass' | 'fail'> = {
    'must-fire': 'fail',
    'must-not-fire': 'pass',
    'known-miss': 'pass',
    'known-false-alarm': 'fail',
};

const WHY: Record<DetectorCaseKind, string> = {
    'must-fire': 'did not fire',
    'must-not-fire': 'fired',
    'known-miss': 'fired on a known miss: the limitation is gone, make it a must-fire case',
    'known-false-alarm': 'stayed silent on a known false alarm: the limitation is gone, make it a must-not-fire case',
};

/** `check` overrides the mode's own detector (for tests). A detector that throws is never a pass. */
export async function runDetectorCases(mode: FailureMode, cases: DetectorCase[] = loadDetectorCases(mode), check?: Check): Promise<DetectorCaseOutcome[]> {
    let detector: Check;
    try {
        detector = check ?? await loadCheck(mode);
    } catch (e) {
        return cases.map(c => ({ case: c, ok: false, why: `detector failed to load: ${(e as Error).message}` }));
    }

    const outcomes: DetectorCaseOutcome[] = [];
    for (const c of cases) {
        const input = c.input as CallRecord | TaskOutput;
        let got: CheckResult;
        try {
            got = detector.appliesTo(input) ? await detector.run(input) : { result: 'unknown', evidence: 'not applicable' };
        } catch (e) {
            outcomes.push({ case: c, ok: false, why: `detector threw: ${(e as Error).message}` });
            continue;
        }
        const expected = c.expect ?? EXPECTED[c.kind];
        const ok = got.result === expected;
        const why = got.result === 'unknown' || expected === 'unknown'
            ? `returned ${got.result}${got.evidence ? ` (${got.evidence})` : ''}, expected ${expected}`
            : WHY[c.kind];
        outcomes.push({ case: c, ok, got, ...(!ok && { why }) });
    }
    return outcomes;
}
