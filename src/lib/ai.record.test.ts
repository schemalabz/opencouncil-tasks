import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallRecord } from './llm/callRecord.js';
import { costUsd } from './pricing.js';

// aiChat builds its SDK client at import time and the SDK captures the ambient
// fetch then, so the module is re-imported under the stub (as in ai.test.ts).
let aiChat: typeof import('./ai.js').aiChat;
let telemetry: typeof import('./telemetry/telemetry.js');
let policy: typeof import('./llm/callPolicy.js');
let fetchMock: ReturnType<typeof vi.fn>;
const records: CallRecord[] = [];
const env = { ...process.env };

function sseResponse(text: string, model = 'claude-haiku-5-5', stopReason = 'end_turn'): Response {
    const events = [
        ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } }],
        ['message_stop', { type: 'message_stop' }],
    ];
    const body = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const probe = () => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'probe' } }), { status: 400, headers: { 'content-type': 'application/json' } });
const lastBody = () => JSON.parse(String((fetchMock.mock.calls.at(-1) as [string, RequestInit])[1].body));

beforeAll(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-rec-'));
    process.env.DATA_DIR = path.join(tmp, 'data');
    process.env.ARCHIVE_URL = `file://${path.join(tmp, 'archive')}`;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.resetModules();
    ({ aiChat } = await import('./ai.js'));
    telemetry = await import('./telemetry/telemetry.js');
    policy = await import('./llm/callPolicy.js');
    telemetry.configureSinks([{ name: 'capture', onCall: (_run, call) => { records.push(call); } }]);
});

afterAll(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    process.env = env;
});

beforeEach(() => { fetchMock.mockReset(); records.length = 0; });

describe('aiChat recording and policy', () => {
    it('records a live call with model, effort, usage and cache key, and stores the response', async () => {
        fetchMock.mockImplementation(async () => sseResponse('{"a":1}'));
        const out = await aiChat<{ a: number }>({ systemPrompt: 'sys-live', userPrompt: 'u', model: 'claude-sonnet-5-5', effort: 'medium', label: 'probe-live' });
        expect(out.result).toEqual({ a: 1 });
        expect(records).toHaveLength(1);
        const r = records[0];
        expect(r.label).toBe('probe-live');
        expect(r.request).toMatchObject({ model: 'claude-sonnet-5-5', output_config: { effort: 'medium' } });
        expect(r.response).toMatchObject({ servedModel: 'claude-haiku-5-5', stopReason: 'end_turn', text: '{"a":1}', cacheHit: false });
        expect(r.cacheKey).toMatch(/^[0-9a-f]{64}$/);

        fetchMock.mockReset();
        const again = await aiChat<{ a: number }>({ systemPrompt: 'sys-live', userPrompt: 'u', model: 'claude-sonnet-5-5', effort: 'medium', label: 'probe-live', cache: 'use' });
        expect(again.result).toEqual({ a: 1 });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(records[1].response?.cacheHit).toBe(true);
    });

    it('applies a per-label model override and drops the temperature the new model rejects', async () => {
        fetchMock.mockImplementation(async () => probe());
        await policy.runWithCallPolicy({ ...policy.DEFAULT_POLICY, overrides: { 'decision-reading': { model: 'claude-sonnet-5-5', maxTokens: 2048 } } }, () =>
            expect(aiChat({ systemPrompt: 's', userPrompt: 'u', model: 'claude-haiku-4-5-20251001', label: 'decision-reading', maxTokens: 1024 })).rejects.toThrow());
        expect(lastBody()).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 2048 });
        expect(lastBody().temperature).toBeUndefined();
        expect(records.at(-1)?.error?.message).toBeTruthy();
    });

    it('records a refusal as a failed call, with the response it billed', async () => {
        fetchMock.mockImplementation(async () => sseResponse('{"partial', 'claude-haiku-5-5', 'refusal'));
        await expect(aiChat({ systemPrompt: 'sys-refusal', userPrompt: 'u', label: 'x' })).rejects.toThrow(/declined/);
        expect(records).toHaveLength(1);
        expect(records[0].error?.message).toMatch(/declined/);
        expect(records[0].response?.stopReason).toBe('refusal');
    });

    it('refuses a model it cannot price when a spend ceiling is set', async () => {
        await policy.runWithCallPolicy({ ...policy.DEFAULT_POLICY, budget: { limitUsd: 1, spentUsd: 0 } }, () =>
            expect(aiChat({ systemPrompt: 's', userPrompt: 'u', model: 'claude-unpriced-9', label: 'x' })).rejects.toThrow(/No price for claude-unpriced-9/));
        expect(fetchMock).not.toHaveBeenCalled();
        expect(records.at(-1)?.error?.class).toBe('UnpricedModelError');
    });

    it('replays a recorded response without the network', async () => {
        fetchMock.mockImplementation(async () => sseResponse('"recorded"'));
        await aiChat({ systemPrompt: 'sys-replay', userPrompt: 'u', label: 'phase-a' });
        fetchMock.mockReset();
        const replayed = await policy.runWithCallPolicy({ mode: 'replay', cacheRead: true, cacheWrite: false }, () =>
            aiChat({ systemPrompt: 'sys-replay', userPrompt: 'u', label: 'phase-a' }));
        expect(replayed.result).toBe('recorded');
        expect(fetchMock).not.toHaveBeenCalled();
        expect(records.at(-1)?.response).toMatchObject({ cacheHit: true, replayed: true });
    });

    it('replays strictly from a cassette, in recorded order', async () => {
        const { cassetteFromCalls } = await import('./llm/cassette.js');
        fetchMock.mockImplementation(async () => sseResponse('"one"'));
        await aiChat({ systemPrompt: 'sys-cassette', userPrompt: 'u', label: 'p' });
        fetchMock.mockImplementation(async () => sseResponse('"two"'));
        await aiChat({ systemPrompt: 'sys-cassette', userPrompt: 'u', label: 'p' });
        const cassette = cassetteFromCalls(records.slice(-2));
        fetchMock.mockReset();
        const [a, b] = await policy.runWithCallPolicy({ mode: 'replay', cacheRead: true, cacheWrite: false, cassette }, async () => [
            (await aiChat({ systemPrompt: 'sys-cassette', userPrompt: 'u', label: 'p' })).result,
            (await aiChat({ systemPrompt: 'sys-cassette', userPrompt: 'u', label: 'p' })).result,
        ]);
        expect([a, b]).toEqual(['one', 'two']);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('fails a replayed call that has no recording, and keeps live globs live', async () => {
        await expect(policy.runWithCallPolicy({ mode: 'replay', cacheRead: true, cacheWrite: false }, () =>
            aiChat({ systemPrompt: 'never-recorded', userPrompt: 'u', label: 'phase-b' }))).rejects.toThrow(/No recorded response/);
        expect(fetchMock).not.toHaveBeenCalled();

        fetchMock.mockImplementation(async () => sseResponse('"live"'));
        const live = await policy.runWithCallPolicy({ mode: 'replay', live: ['phase-c*'], cacheRead: true, cacheWrite: false }, () =>
            aiChat({ systemPrompt: 'never-recorded', userPrompt: 'u', label: 'phase-c:1' }));
        expect(live.result).toBe('live');
    });
});

// Lets the fire-and-forget response-store write land before the next lookup.
const settle = () => new Promise(r => setTimeout(r, 50));
const liveCost = (model: string) => costUsd(model, { input_tokens: 10, output_tokens: 5 })!;

describe('aiChat under a spend ceiling', () => {
    it('refuses a live call once the ceiling is reached, and records why', async () => {
        const budget = { limitUsd: 0.5, spentUsd: 0.5 };
        await policy.runWithCallPolicy({ ...policy.DEFAULT_POLICY, budget }, () =>
            expect(aiChat({ systemPrompt: 'budget-1', userPrompt: 'u', model: 'claude-haiku-5-5', label: 'x' })).rejects.toThrow(/Spend ceiling reached/));
        expect(fetchMock).not.toHaveBeenCalled();
        // The runner finds swallowed ceilings by this class in the call records.
        expect(records.at(-1)?.error?.class).toBe('BudgetExceededError');
    });

    it('charges a live call to the shared budget and a cache hit nothing', async () => {
        fetchMock.mockImplementation(async () => sseResponse('"fresh"'));
        const budget = { limitUsd: 10, spentUsd: 0 };
        await policy.runWithCallPolicy({ ...policy.DEFAULT_POLICY, budget }, () =>
            aiChat({ systemPrompt: 'budget-2', userPrompt: 'u', model: 'claude-haiku-5-5', label: 'x' }));
        expect(budget.spentUsd).toBeCloseTo(liveCost('claude-haiku-5-5'), 12);
        await settle();
        fetchMock.mockReset();
        const hit = await policy.runWithCallPolicy({ ...policy.DEFAULT_POLICY, cacheRead: true, budget }, () =>
            aiChat({ systemPrompt: 'budget-2', userPrompt: 'u', model: 'claude-haiku-5-5', label: 'x' }));
        expect(fetchMock).not.toHaveBeenCalled();
        expect(hit.usage.output_tokens).toBe(0);
        expect(budget.spentUsd).toBeCloseTo(liveCost('claude-haiku-5-5'), 12);
    });

    it('charges a served snapshot id the price table lacks at the requested model', async () => {
        fetchMock.mockImplementation(async () => sseResponse('"x"', 'claude-sonnet-5-5-20261001'));
        const budget = { limitUsd: 10, spentUsd: 0 };
        await policy.runWithCallPolicy({ ...policy.DEFAULT_POLICY, budget }, () =>
            aiChat({ systemPrompt: 'dated', userPrompt: 'u', model: 'claude-sonnet-5-5', label: 'x' }));
        expect(budget.spentUsd).toBeCloseTo(liveCost('claude-sonnet-5-5'), 12);
    });
});

describe('aiChat response store', () => {
    it('never stores a max_tokens response, so a replay of it misses', async () => {
        fetchMock.mockImplementation(async () => sseResponse('{"cut', 'claude-haiku-5-5', 'max_tokens'));
        const outputFormat = { type: 'json_schema', schema: { type: 'object' } } as never;
        await expect(aiChat({ systemPrompt: 'trunc', userPrompt: 'u', model: 'claude-haiku-5-5', label: 'x', outputFormat })).rejects.toThrow(/hit max_tokens/);
        await settle();
        fetchMock.mockReset();
        await expect(policy.runWithCallPolicy({ mode: 'replay', cacheRead: true, cacheWrite: false }, () =>
            aiChat({ systemPrompt: 'trunc', userPrompt: 'u', model: 'claude-haiku-5-5', label: 'x', outputFormat }))).rejects.toThrow(/No recorded response/);
        expect(records.at(-1)?.error?.class).toBe('ReplayMissError');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('never serves a tool-using call from the cache while live', async () => {
        fetchMock.mockImplementation(async () => sseResponse('"searched"'));
        const tools = [{ type: 'web_search_20250305', name: 'web_search' }] as never;
        await aiChat({ systemPrompt: 'tools', userPrompt: 'u', model: 'claude-haiku-5-5', label: 'x', tools });
        await settle();
        fetchMock.mockClear();
        await aiChat({ systemPrompt: 'tools', userPrompt: 'u', model: 'claude-haiku-5-5', label: 'x', tools, cache: 'use' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
