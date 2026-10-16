import { describe, expect, it } from 'vitest';
import type { DetectorCase, FailureMode } from '../registry/schema.js';
import type { Check } from './check.js';
import { runDetectorCases } from './runDetectorCases.js';

const mode: FailureMode = {
    id: 'FM-9999', slug: 'fires_on_bad', title: 't', definition: 'd', suite: 's', scope: 'call',
    severity: 'minor', impact: 'silent', status: 'guarded', detector: { kind: 'code', module: 'unused.ts' },
};

/** Fires on "bad", passes on "good", throws on "boom". */
const check: Check = {
    id: 'fires_on_bad',
    scope: 'call',
    appliesTo: () => true,
    run: async x => {
        const text = (x as { response: { text: string } }).response.text;
        if (text === 'boom') throw new Error('kaboom');
        return { result: text === 'bad' ? 'fail' : 'pass' };
    },
};

const kase = (kind: DetectorCase['kind'], text: string): DetectorCase => ({ kind, input: { response: { text } } });
const oks = async (cases: DetectorCase[]) => (await runDetectorCases(mode, cases, check)).map(o => o.ok);

describe('runDetectorCases', () => {
    it('requires must-fire to fire and must-not-fire to stay silent', async () => {
        expect(await oks([kase('must-fire', 'bad'), kase('must-fire', 'good'), kase('must-not-fire', 'good'), kase('must-not-fire', 'bad')]))
            .toEqual([true, false, true, false]);
    });

    it('is strict about documented limitations', async () => {
        expect(await oks([kase('known-miss', 'good'), kase('known-miss', 'bad'), kase('known-false-alarm', 'bad'), kase('known-false-alarm', 'good')]))
            .toEqual([true, false, true, false]);
    });

    it('counts a throwing detector as a failure, even where silence was expected', async () => {
        const [out] = await runDetectorCases(mode, [kase('must-not-fire', 'boom')], check);
        expect(out).toMatchObject({ ok: false, why: 'detector threw: kaboom' });
    });

    it('fails every case when the detector does not load', async () => {
        const broken = { ...mode, detector: { kind: 'code' as const, module: 'src/evals/checks/nope.ts' } };
        const out = await runDetectorCases(broken, [kase('must-not-fire', 'good')]);
        expect(out[0].ok).toBe(false);
        expect(out[0].why).toMatch(/failed to load/);
    });

    it('loads a code detector by its export name and checks it matches the entry', async () => {
        const truncated: FailureMode = { ...mode, slug: 'output_truncated', detector: { kind: 'code', module: 'src/evals/checks/stopReasonTruncated.ts' } };
        const input = { label: 'x', request: { model: 'm', max_tokens: 1, messages: [] }, response: { text: '', stopReason: 'model_context_window_exceeded' } };
        expect((await runDetectorCases(truncated, [{ kind: 'must-fire', input }]))[0].ok).toBe(true);

        const misnamed = { ...truncated, slug: 'something_else' };
        expect((await runDetectorCases(misnamed, [{ kind: 'must-fire', input }]))[0].why).toMatch(/expected the slug "something_else"/);
    });
});
