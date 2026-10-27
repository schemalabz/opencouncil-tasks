import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FailureMode } from '../registry/schema.js';

const aiChat = vi.fn();
vi.mock('../../lib/ai.js', () => ({ aiChat: (...args: unknown[]) => aiChat(...args) }));

const { judgeCheck, sampled } = await import('./judge.js');

const promptFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'judge-')), 'prompt.md');
fs.writeFileSync(promptFile, 'You review subject contexts.');

const mode = (sample: number): FailureMode => ({
    id: 'FM-9998', slug: 'vague_context', title: 't', definition: 'The context says nothing specific.', boundary: 'Short but specific is fine.',
    suite: 'summarize.context', scope: 'call', severity: 'minor', impact: 'visible', status: 'candidate',
    detector: { kind: 'judge', prompt: promptFile, model: 'claude-haiku-4-5', sample },
});

const call = (callId: string) => ({ v: 1, callId, label: 'subject-context-search:x', request: { model: 'm', max_tokens: 1, messages: [] }, cacheKey: 'k', response: { text: 'Some context.' }, startedAt: '', finishedAt: '' }) as never;

describe('judgeCheck', () => {
    beforeEach(() => {
        aiChat.mockReset();
        aiChat.mockResolvedValue({ result: { verdict: 'fail', evidence: '«nothing specific»' } });
    });

    it('asks the configured model with the prompt file, definition and boundary, cached and labelled by slug', async () => {
        const out = await judgeCheck(mode(1)).run(call('c1'));
        expect(out).toEqual({ result: 'fail', evidence: '«nothing specific»' });
        const opts = aiChat.mock.calls[0][0];
        expect(opts).toMatchObject({ label: 'judge:vague_context', model: 'claude-haiku-4-5', cache: 'use', userPrompt: 'Some context.', outputFormat: { type: 'json_schema' } });
        expect(opts.systemPrompt).toContain('You review subject contexts.');
        expect(opts.systemPrompt).toContain('The context says nothing specific.');
        expect(opts.systemPrompt).toContain('Short but specific is fine.');
    });

    it('skips unsampled calls without calling the model', async () => {
        expect(await judgeCheck(mode(0)).run(call('c1'))).toEqual({ result: 'unknown', evidence: 'not sampled' });
        expect(aiChat).not.toHaveBeenCalled();
    });

    it('samples deterministically at roughly the configured rate', () => {
        const ids = Array.from({ length: 2000 }, (_, i) => `call-${i}`);
        const hits = ids.filter(id => sampled(id, 0.2)).length;
        expect(hits / ids.length).toBeGreaterThan(0.17);
        expect(hits / ids.length).toBeLessThan(0.23);
        expect(ids.map(id => sampled(id, 0.2))).toEqual(ids.map(id => sampled(id, 0.2)));
    });
});
