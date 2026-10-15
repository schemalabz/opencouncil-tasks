import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { canonicalJson, computeCacheKey, requestEffort, sanitizeParams } from './cacheKey.js';

type Params = Anthropic.Messages.MessageCreateParamsNonStreaming;
const base: Params = {
    model: 'claude-haiku-4-5-20251001', max_tokens: 1024, temperature: 0,
    system: 'You read decisions.', messages: [{ role: 'user', content: 'Read it.' }],
    output_config: { format: { type: 'json_schema', schema: { type: 'object', properties: { a: { type: 'string' } } } } },
} as Params;
const keyOf = (p: Params) => computeCacheKey(sanitizeParams(p).request);
const pdfMessage = (bytes: string): Params['messages'][number] => ({
    role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(bytes).toString('base64') } }],
});

describe('canonicalJson', () => {
    it('is independent of key order and drops undefined', () => {
        expect(canonicalJson({ b: 1, a: { d: 2, c: undefined } })).toBe(canonicalJson({ a: { d: 2 }, b: 1 }));
    });
});

describe('computeCacheKey', () => {
    it('is stable for the same request, whatever the key order', () => {
        expect(keyOf(base)).toBe(keyOf({ messages: base.messages, max_tokens: 1024, model: base.model, temperature: 0, system: base.system, output_config: base.output_config } as Params));
    });
    it.each<[string, Partial<Params>]>([
        ['model', { model: 'claude-haiku-5-5' }],
        ['effort', { output_config: { ...base.output_config, effort: 'medium' } } as Partial<Params>],
        ['max_tokens', { max_tokens: 2048 }],
        ['system prompt', { system: 'Different.' }],
        ['message text', { messages: [{ role: 'user', content: 'Read it!' }] }],
        ['output schema', { output_config: { format: { type: 'json_schema', schema: { type: 'object' } } } } as Partial<Params>],
        ['document', { messages: [pdfMessage('%PDF-1'), { role: 'user', content: 'Read it.' }] }],
        ['an SDK field it was never told about', { tool_choice: { type: 'auto' } } as Partial<Params>],
    ])('changes when the %s changes', (_name, change) => {
        expect(keyOf({ ...base, ...change } as Params)).not.toBe(keyOf(base));
    });
    it('ignores prompt-caching hints', () => {
        const cached = { ...base, system: [{ type: 'text', text: 'You read decisions.', cache_control: { type: 'ephemeral' } }] } as Params;
        expect(keyOf(cached)).toBe(keyOf(base));
    });
});

describe('sanitizeParams', () => {
    it('replaces documents, the system prompt and the schema by hashes', () => {
        const pdf = '%PDF-1.7 fake';
        const { request, blobs } = sanitizeParams({ ...base, messages: [pdfMessage(pdf), { role: 'user', content: 'Read it.' }] } as Params);
        const json = JSON.stringify(request);
        expect(json).not.toContain(Buffer.from(pdf).toString('base64'));
        expect(json).not.toContain('You read decisions.');
        expect((request.messages[0].content as any[])[0]).toMatchObject({ type: 'document', source: { type: 'blob', media_type: 'application/pdf', bytes: pdf.length } });
        expect(blobs.map(b => b.mediaType).sort()).toEqual(['application/json', 'application/pdf', 'text/plain; charset=utf-8']);
    });
    it('stores identical content once', () => {
        const { blobs } = sanitizeParams({ ...base, output_config: undefined, messages: [pdfMessage('same'), pdfMessage('same')] } as Params);
        expect(blobs.filter(b => b.mediaType === 'application/pdf')).toHaveLength(1);
    });
    it('exposes the effort level', () => {
        expect(requestEffort(sanitizeParams({ ...base, output_config: { effort: 'high' } } as Params).request)).toBe('high');
    });
});
