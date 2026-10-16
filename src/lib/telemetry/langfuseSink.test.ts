import { describe, expect, it, vi } from 'vitest';
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { LangfuseOtelSpanAttributes as A } from '@langfuse/tracing';
import { createLangfuseSink } from './langfuseSink.js';
import type { RunState } from './context.js';
import type { RunOutcome } from './sink.js';
import type { CallBlob, CallRecord } from '../llm/callRecord.js';

const TRACE_ID = 'ab'.repeat(16);

function call(label: string, phase: string | undefined, startedAt: string, finishedAt: string): CallRecord {
    return {
        v: 1, callId: label, traceId: TRACE_ID, label, phase, cacheKey: `key-${label}`, startedAt, finishedAt,
        request: {
            model: 'claude-sonnet-5', max_tokens: 1000, system: { hash: 'f'.repeat(64) },
            messages: [{ role: 'user', content: [
                { type: 'text', text: 'hi' },
                { type: 'document', source: { type: 'blob', sha256: 'd'.repeat(64), media_type: 'application/pdf', bytes: 1234 } },
            ] }],
            output_config: { effort: 'high' },
        },
        response: {
            servedModel: 'claude-sonnet-5', stopReason: 'end_turn', text: 'hello', latencyMs: 10, batchMode: false,
            usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 },
        },
    };
}

function state(calls: CallRecord[]): RunState {
    return {
        run: {
            traceId: TRACE_ID, taskType: 'demo', taskVersion: 3, taskId: 'task-1', meeting: 'chania/m1',
            env: 'development', input: { meetingId: 'm1', transcript: [1, 2, 3] }, startedAt: '2026-10-01T10:00:00.000Z',
        },
        phases: [{ id: 'p', name: 'Phase 1', startedAt: '2026-10-01T10:00:01.000Z', endedAt: '2026-10-01T10:00:05.000Z' }],
        calls,
    };
}

async function emit(runState: RunState, outcome: RunOutcome, environment?: string, blobs: CallBlob[] = []): Promise<ReadableSpan[]> {
    const exporter = new InMemorySpanExporter();
    const processor = new LangfuseSpanProcessor({ exporter, exportMode: 'immediate', publicKey: 'pk', secretKey: 'sk', baseUrl: 'http://127.0.0.1:9', environment });
    const sink = createLangfuseSink({ processor })!;
    for (const c of runState.calls) sink.onCall!(runState.run, c, { blobs });
    await sink.onRunEnd!(runState, outcome);
    await sink.flush!();
    return exporter.getFinishedSpans();
}

const ms = (t: [number, number]) => t[0] * 1000 + t[1] / 1e6;
const ok: RunOutcome = { status: 'success', result: { subjects: [] }, endedAt: '2026-10-01T10:00:06.000Z' };

describe('createLangfuseSink', () => {
    it('is disabled without Langfuse keys', () => {
        vi.stubEnv('LANGFUSE_PUBLIC_KEY', '');
        vi.stubEnv('LANGFUSE_SECRET_KEY', '');
        expect(createLangfuseSink()).toBeNull();
        vi.unstubAllEnvs();
    });

    it('emits the run back-dated as one trace: root, phase, and a generation per call', async () => {
        const spans = await emit(state([
            call('first', 'Phase 1', '2026-10-01T10:00:02.000Z', '2026-10-01T10:00:03.000Z'),
            call('second', 'Phase 1', '2026-10-01T10:00:03.000Z', '2026-10-01T10:00:04.500Z'),
        ]), ok);

        expect(spans).toHaveLength(4);
        expect(new Set(spans.map(s => s.spanContext().traceId))).toEqual(new Set([TRACE_ID]));

        const byName = new Map(spans.map(s => [s.name, s]));
        const root = byName.get('demo')!, phase = byName.get('Phase 1')!, gen = byName.get('second')!;
        expect(phase.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
        for (const g of [byName.get('first')!, gen]) {
            expect(g.attributes[A.OBSERVATION_TYPE]).toBe('generation');
            expect(g.attributes[A.OBSERVATION_MODEL]).toBe('claude-sonnet-5');
            expect(g.parentSpanContext?.spanId).toBe(phase.spanContext().spanId);
        }

        expect(ms(root.startTime)).toBe(Date.parse('2026-10-01T10:00:00.000Z'));
        expect(ms(root.endTime)).toBe(Date.parse(ok.endedAt));
        expect(ms(phase.endTime)).toBe(Date.parse('2026-10-01T10:00:05.000Z'));
        expect(ms(gen.startTime)).toBe(Date.parse('2026-10-01T10:00:03.000Z'));
        expect(ms(gen.endTime)).toBe(Date.parse('2026-10-01T10:00:04.500Z'));

        for (const s of spans) {
            expect(s.attributes[A.TRACE_NAME]).toBe('demo');
            expect(s.attributes[A.TRACE_TAGS]).toEqual(expect.arrayContaining(['task:demo', 'version:3', 'meeting:chania/m1', 'city:chania']));
            expect(s.attributes[A.TRACE_SESSION_ID]).toBe('demo:chania/m1');
        }

        expect(JSON.parse(gen.attributes[A.OBSERVATION_USAGE_DETAILS] as string)).toEqual({ input: 100, output: 20, cache_read_input_tokens: 50 });
        expect(JSON.parse(gen.attributes[A.OBSERVATION_COST_DETAILS] as string).total).toBeGreaterThan(0);
        expect(gen.attributes[A.OBSERVATION_INPUT]).toContain(`[pdf ${'d'.repeat(12)} 1234 bytes]`);
        expect(JSON.parse(root.attributes[A.OBSERVATION_INPUT] as string)).toEqual({ meetingId: 'm1', transcriptCount: 3 });
        expect(JSON.parse(root.attributes[A.TRACE_OUTPUT] as string)).toEqual({ subjects: [] });
    });

    // The process-wide environment would file an eval replay run from a dev machine under development.
    it("tags every span with the run's own environment, over the process default", async () => {
        const evalRun = state([call('a', 'Phase 1', '2026-10-01T10:00:02.000Z', '2026-10-01T10:00:03.000Z')]);
        evalRun.run.env = 'eval';
        const spans = await emit(evalRun, ok, 'development');
        expect(new Set(spans.map(s => s.attributes['langfuse.environment']))).toEqual(new Set(['eval']));
    });

    it("puts the system prompt's text in each generation's input", async () => {
        const blob: CallBlob = { sha256: 'f'.repeat(64), data: Buffer.from('Είσαι βοηθός.'), mediaType: 'text/plain; charset=utf-8' };
        const spans = await emit(state([call('a', 'Phase 1', '2026-10-01T10:00:02.000Z', '2026-10-01T10:00:03.000Z')]), ok, undefined, [blob]);
        expect(JSON.parse(spans.find(s => s.name === 'a')!.attributes[A.OBSERVATION_INPUT] as string).system).toBe('Είσαι βοηθός.');
    });

    it('parents a call with no matching phase to the root', async () => {
        const spans = await emit(state([call('loose', undefined, '2026-10-01T10:00:05.000Z', '2026-10-01T10:00:05.500Z')]), ok);
        const root = spans.find(s => s.name === 'demo')!;
        expect(spans.find(s => s.name === 'loose')!.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    });

    it('marks a failed run as an error', async () => {
        const spans = await emit(state([]), { status: 'error', error: 'boom', endedAt: ok.endedAt });
        const root = spans.find(s => s.name === 'demo')!;
        expect(root.attributes[A.OBSERVATION_LEVEL]).toBe('ERROR');
        expect(root.attributes[A.OBSERVATION_STATUS_MESSAGE]).toBe('boom');
        expect(root.attributes[A.TRACE_TAGS]).toContain('status:error');
    });

    it('replaces an oversized result with a summary so the root still lands', async () => {
        const huge = { transcript: 'x'.repeat(900_000) };
        const spans = await emit(state([]), { ...ok, result: huge });
        const output = JSON.parse(spans.find(s => s.name === 'demo')!.attributes[A.OBSERVATION_OUTPUT] as string);
        expect(output).toMatchObject({ resultTruncated: true, resultSizeBytes: expect.any(Number) });
    });
});
