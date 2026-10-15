import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, getCallPolicy, matchesGlob, resolveOverrides, runWithCallPolicy, shouldReplay, type CallPolicy } from './callPolicy.js';

describe('callPolicy', () => {
    it('defaults to live with recording on', () => {
        expect(getCallPolicy()).toEqual(DEFAULT_POLICY);
    });
    it('scopes a policy to its async context', async () => {
        const p: CallPolicy = { mode: 'replay', cacheRead: true, cacheWrite: false };
        await runWithCallPolicy(p, async () => { expect(getCallPolicy().mode).toBe('replay'); });
        expect(getCallPolicy().mode).toBe('live');
    });
    it('matches label globs', () => {
        expect(matchesGlob('contributions:Δημοτικό', 'contributions:*')).toBe(true);
        expect(matchesGlob('decision-extraction:partial', 'decision-extraction')).toBe(false);
        expect(matchesGlob('decision-extraction:partial', 'decision-extraction*')).toBe(true);
    });
    it('takes the first matching override', () => {
        const p: CallPolicy = { ...DEFAULT_POLICY, overrides: { 'decision-reading': { model: 'claude-haiku-5-5' }, '*': { model: 'x' } } };
        expect(resolveOverrides('decision-reading', p)).toEqual({ model: 'claude-haiku-5-5' });
        expect(resolveOverrides('member-match', p)).toEqual({ model: 'x' });
        expect(resolveOverrides('member-match', DEFAULT_POLICY)).toEqual({});
    });
    it('replays everything except live labels', () => {
        const p: CallPolicy = { mode: 'replay', live: ['contributions:*'], cacheRead: true, cacheWrite: true };
        expect(shouldReplay('batch-processing:1/3', p)).toBe(true);
        expect(shouldReplay('contributions:Θέμα', p)).toBe(false);
        expect(shouldReplay('anything', DEFAULT_POLICY)).toBe(false);
    });
});
