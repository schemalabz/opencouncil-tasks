import { describe, expect, it } from 'vitest';
import { cassetteFromCalls } from './cassette.js';
import type { CallRecord } from './callRecord.js';

const rec = (key: string, text: string): CallRecord => ({
    v: 1, callId: text, cacheKey: key, startedAt: 't', finishedAt: 't',
    request: { model: 'm', max_tokens: 1, messages: [] },
    response: { servedModel: 'm', stopReason: 'end_turn', text, content: [{ type: 'text', text }], usage: {}, latencyMs: 1, batchMode: false },
});

describe('cassetteFromCalls', () => {
    it('serves repeated requests in recorded order, then runs out', () => {
        const c = cassetteFromCalls([rec('k', 'first'), rec('k', 'second'), rec('j', 'other')]);
        expect((c.take('k')?.content[0] as any).text).toBe('first');
        expect((c.take('k')?.content[0] as any).text).toBe('second');
        expect(c.take('k')).toBeUndefined();
        expect(c.remaining()).toBe(1);
    });
});
