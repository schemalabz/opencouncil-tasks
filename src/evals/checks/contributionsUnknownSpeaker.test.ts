import { describe, expect, it } from 'vitest';
import check from './contributionsUnknownSpeaker.js';

/** A batch call: keys for two of the subject's three speakers; the third (named, id key) is in another batch. */
const call = (ids: string[]) => ({
    v: 1, callId: 'c', label: 'contributions:Θέμα', cacheKey: 'k', startedAt: '', finishedAt: '',
    request: { model: 'm', max_tokens: 1, messages: [{ role: 'user', content: [
        '**Speaker: aaaa1111**', '- [u1] "α"', '', '**Speaker: name:Νίκος Π.**', '- [u2] "β"', '',
        'ΠΛΗΡΗΣ ΣΥΖΗΤΗΣΗ (ΓΙΑ ΠΛΑΙΣΙΟ)', '',
        '1. [Μαρία Κ.] (00:01:00): "α" [u1]', '2. [Νίκος Π.] (00:02:00): "β" [u2]', '3. [Γιώργος Λ.] (00:03:00): "γ" [u3]',
    ].join('\n') }] },
    response: { servedModel: 'm', stopReason: 'end_turn', text: JSON.stringify({ speakerContributions: ids.map(speakerId => ({ speakerId, text: 't' })) }), usage: {}, latencyMs: 1, batchMode: false },
}) as never;

describe('contributions_unknown_speaker in a batch call', () => {
    it('cannot tell whether an unknown id key belongs to a named speaker of another batch', async () => {
        expect(await check.run(call(['aaaa1111', 'bbbb2222']))).toMatchObject({ result: 'unknown' });
    });

    it('still fires on a near-miss of a given key, an id of another shape, or a name nobody in the discussion has', async () => {
        expect((await check.run(call(['aaaa1112']))).result).toBe('fail');
        expect((await check.run(call(['cmsdpbcch010y21ci334zqmv7']))).result).toBe('fail');
        expect((await check.run(call(['name:Άγνωστος']))).result).toBe('fail');
        expect((await check.run(call(['aaaa1111', 'name:Νίκος Π.', 'name:Γιώργος Λ.']))).result).toBe('pass');
    });
});
