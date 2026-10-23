import type { CallRecord } from '../../lib/llm/callRecord.js';
import { loadDetectorCases } from '../registry/registry.js';
import type { DetectorCase, DetectorCaseKind, FailureMode } from '../registry/schema.js';
import { loadCheck, type Check, type CheckResult, type TaskOutput } from './check.js';

export type DetectorCaseOutcome = { case: DetectorCase; ok: boolean; got?: CheckResult; why?: string };

/**
 * Whether the detector must fire on each kind. Known misses and known false alarms
 * are strict, as in pytest's xfail(strict=True): when the documented limitation goes
 * away the case fails, so someone promotes it instead of it rotting.
 */
const MUST_FIRE: Record<DetectorCaseKind, boolean> = {
    'must-fire': true,
    'must-not-fire': false,
    'known-miss': false,
    'known-false-alarm': true,
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
        const fired = got.result === 'fail';
        const ok = fired === MUST_FIRE[c.kind];
        outcomes.push({ case: c, ok, got, ...(!ok && { why: WHY[c.kind] }) });
    }
    return outcomes;
}
