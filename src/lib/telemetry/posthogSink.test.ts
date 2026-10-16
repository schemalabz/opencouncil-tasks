import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiMetricEvent, createPosthogSink, posthogCapture } from './posthogSink.js';
import { configureSinks, emitCall, runWithTelemetry, withPhase } from './telemetry.js';
import type { CallRecord } from '../llm/callRecord.js';

type Wire = { event: string; distinct_id: string; timestamp?: string; uuid: string; properties: Record<string, unknown> };
type Sent = { path: string; body: { batch: Wire[] } };

function spySend() {
    const sent: Sent[] = [];
    const send = vi.fn(async (path: string, body: unknown) => { sent.push({ path, body: body as Sent['body'] }); });
    return { sent, send, events: () => sent.flatMap(s => s.body.batch) };
}

const call = (label: string, over: Partial<CallRecord> = {}, response: Partial<NonNullable<CallRecord['response']>> = {}): CallRecord => ({
    v: 1, callId: `call-${label}`, label, cacheKey: `key-${label}`,
    startedAt: '2026-10-11T10:00:00.000Z', finishedAt: '2026-10-11T10:00:02.000Z',
    request: {
        model: 'claude-sonnet-4-6', max_tokens: 100, system: { hash: 'abcdef0123456789abcdef' },
        output_config: { effort: 'low' },
        messages: [{ role: 'user', content: [
            { type: 'text', text: 'hello' },
            { type: 'document', source: { type: 'blob', sha256: '0123456789abcdef0123', media_type: 'application/pdf', bytes: 2048 } },
        ] }],
    },
    response: {
        servedModel: 'claude-sonnet-4-6', stopReason: 'end_turn', text: 'out',
        usage: { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        latencyMs: 2000, batchMode: false, ...response,
    },
    ...over,
});

const start = { taskType: 'summarize', taskVersion: 3, taskId: 'task-1', env: 'eval' as const, meeting: 'chania/aug5', eval: { runId: 'run-9', caseId: 'case-2', rep: 1 } };

afterEach(() => { configureSinks(null); vi.restoreAllMocks(); });

describe('createPosthogSink', () => {
    it('is off without a project token', () => {
        vi.stubEnv('POSTHOG_PROJECT_TOKEN', '');
        expect(createPosthogSink()).toBeNull();
        vi.unstubAllEnvs();
    });

    it('sends one run as a trace, a phase span and generations parented to the phase', async () => {
        const { sent, send, events } = spySend();
        configureSinks([createPosthogSink({ send })!]);
        await runWithTelemetry({ ...start, traceId: 'f'.repeat(32) }, async () => {
            await withPhase('Phase 1', async () => { emitCall(call('one')); emitCall(call('two')); });
        });

        const all = events();
        const byType = (t: string) => all.filter(e => e.event === t);
        expect(byType('$ai_generation')).toHaveLength(2);
        expect(byType('$ai_span')).toHaveLength(1);
        expect(byType('$ai_trace')).toHaveLength(1);
        expect(new Set(all.map(e => e.properties.$ai_trace_id))).toEqual(new Set(['f'.repeat(32)]));

        const span = byType('$ai_span')[0];
        expect(span.properties).toMatchObject({ $ai_parent_id: 'f'.repeat(32), $ai_span_name: 'Phase 1' });
        for (const g of byType('$ai_generation')) expect(g.properties.$ai_parent_id).toBe(span.properties.$ai_span_id);

        const gen = byType('$ai_generation')[0];
        expect(gen.timestamp).toBe('2026-10-11T10:00:02.000Z');
        expect(gen.properties).toMatchObject({
            $ai_span_id: 'call-one', $ai_generation_id: 'call-one', $ai_span_name: 'one',
            $ai_model: 'claude-sonnet-4-6', $ai_provider: 'anthropic', $ai_latency: 2, $ai_http_status: 200, $ai_is_error: false,
            $ai_input: [{ role: 'system', content: '[system abcdef012345]' }, { role: 'user', content: 'hello\n[pdf 0123456789ab 2048 bytes]' }],
            $ai_output_choices: [{ role: 'assistant', content: 'out' }],
            effort: 'low', cache_key: 'key-one', $ai_stop_reason: 'end_turn',
        });
        expect(byType('$ai_trace')[0].properties).toMatchObject({ $ai_span_name: 'summarize', $ai_is_error: false });

        for (const e of all) {
            expect(e.distinct_id).toBe('opencouncil-tasks');
            expect(e.properties).toMatchObject({
                $process_person_profile: false, 'service.name': 'opencouncil-tasks', 'deployment.environment.name': 'eval',
                task_type: 'summarize', task_version: 3, task_id: 'task-1', meeting: 'chania/aug5', city: 'chania',
                eval_run_id: 'run-9', eval_case_id: 'case-2', eval_rep: 1,
            });
        }
        expect(sent.filter(s => s.path === '/i/v0/ai/batch/').flatMap(s => s.body.batch).every(e => e.event === '$ai_generation')).toBe(true);
        expect(sent.filter(s => s.path === '/batch/').flatMap(s => s.body.batch).map(e => e.event).sort()).toEqual(['$ai_span', '$ai_trace']);
    });

    it('puts cost only on generations, split input/output and halved for batch calls', async () => {
        const { send, events } = spySend();
        configureSinks([createPosthogSink({ send })!]);
        await runWithTelemetry(start, async () => {
            await withPhase('P', async () => { emitCall(call('b', {}, { batchMode: true })); });
        });
        const gen = events().find(e => e.event === '$ai_generation')!;
        expect(gen.properties.$ai_input_cost_usd).toBeCloseTo(1.5, 6);
        expect(gen.properties.$ai_output_cost_usd).toBeCloseTo(0.75, 6);
        expect(gen.properties.$ai_total_cost_usd).toBeCloseTo(2.25, 6);
        for (const e of events().filter(e => e.event !== '$ai_generation')) {
            expect(Object.keys(e.properties).filter(k => k.includes('cost'))).toEqual([]);
        }
    });

    it('sends a large output untruncated, but drops content from an event over the 8 MiB cap', async () => {
        const { send, events } = spySend();
        const sink = createPosthogSink({ send })!;
        sink.onCall!(undefined, call('big', {}, { text: 'x'.repeat(200_000) }), {});
        sink.onCall!(undefined, call('huge', {}, { text: 'y'.repeat(9 * 1024 * 1024) }), {});
        await sink.flush!();
        const [big, huge] = events();
        expect((big.properties.$ai_output_choices as Array<{ content: string }>)[0].content).toHaveLength(200_000);
        expect(huge.properties.$ai_content_dropped).toBe(true);
        expect(JSON.stringify(huge).length).toBeLessThan(8 * 1024 * 1024);
        expect(huge.properties.$ai_input_cost_usd).toBeGreaterThan(0);
    });

    it('marks a failed call as an error', async () => {
        const { send, events } = spySend();
        const sink = createPosthogSink({ send })!;
        sink.onCall!(undefined, { ...call('e'), response: undefined, error: { class: 'APIError', message: 'overloaded' } }, {});
        await sink.flush!();
        expect(events()[0].properties).toMatchObject({ $ai_is_error: true, $ai_error: 'APIError: overloaded', $ai_http_status: 500, $ai_trace_id: 'call-e' });
    });

    it('logs and drops a failing send instead of throwing', async () => {
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        const sink = createPosthogSink({ send: async () => { throw new Error('down'); } })!;
        sink.onCall!(undefined, call('x'), {});
        await expect(sink.flush!()).resolves.toBeUndefined();
        expect(err).toHaveBeenCalled();
    });
});

describe('posthogCapture', () => {
    it('chunks requests to at most 100 events', async () => {
        const { sent, send } = spySend();
        await posthogCapture(Array.from({ length: 150 }, (_, i) => ({ event: 'eval_comparison', properties: { i } })), send);
        expect(sent.map(s => s.body.batch.length)).toEqual([100, 50]);
    });

    it('sends metric values as strings so a zero score still shows', async () => {
        const { send, events } = spySend();
        await posthogCapture([aiMetricEvent({ traceId: 't', name: 'coverage', value: 0, parentId: 'g' })], send);
        expect(events()[0]).toMatchObject({ event: '$ai_metric', properties: { $ai_trace_id: 't', $ai_metric_name: 'coverage', $ai_metric_value: '0', $ai_parent_id: 'g' } });
    });
});
