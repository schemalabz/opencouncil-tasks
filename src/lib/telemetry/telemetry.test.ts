import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureSinks, emitCall, runWithTelemetry, withPhase, onRunEnd } from './telemetry.js';
import type { TelemetrySink } from './sink.js';
import type { CallRecord } from '../llm/callRecord.js';
import { TaskCancelledError } from '../taskControl.js';

const call = (label: string): CallRecord => ({
    v: 1, callId: label, label, cacheKey: 'k', startedAt: 't0', finishedAt: 't1',
    request: { model: 'm', max_tokens: 1, system: { hash: 'h' }, messages: [] },
});

const start = { taskType: 'demo', taskVersion: 1, taskId: 't1', env: 'development' as const };

function recordingSink(name = 'rec'): TelemetrySink & { events: string[] } {
    const events: string[] = [];
    return {
        name, events,
        onRunStart: run => { events.push(`start:${run.traceId}`); },
        onCall: (run, c) => { events.push(`call:${c.label}:${run?.traceId}:${c.phase ?? '-'}`); },
        onPhaseEnd: (_run, phase) => { events.push(`phase:${phase.name}`); },
        onRunEnd: (state, outcome) => { events.push(`end:${state.run.traceId}:${outcome.status}:${state.calls.length}`); },
    };
}

afterEach(() => configureSinks(null));

describe('runWithTelemetry', () => {
    it('fans run, phase and call events out with one trace id', async () => {
        const sink = recordingSink();
        configureSinks([sink]);
        await runWithTelemetry({ ...start, traceId: 'a'.repeat(32) }, async () => {
            await withPhase('Phase 1', async () => { emitCall(call('one')); });
            emitCall(call('two'));
        });
        const id = 'a'.repeat(32);
        expect(sink.events).toEqual([`start:${id}`, `call:one:${id}:Phase 1`, 'phase:Phase 1', `call:two:${id}:-`, `end:${id}:success:2`]);
    });

    it('keeps the task result when a sink throws', async () => {
        const bad: TelemetrySink = { name: 'bad', onCall: () => { throw new Error('boom'); }, onRunEnd: () => { throw new Error('boom'); } };
        const good = recordingSink();
        configureSinks([bad, good]);
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const result = await runWithTelemetry(start, async () => { emitCall(call('x')); return 42; });
        expect(result).toBe(42);
        expect(good.events.some(e => e.startsWith('call:x'))).toBe(true);
        spy.mockRestore();
    });

    it('reports a cancelled run and rethrows', async () => {
        const sink = recordingSink();
        configureSinks([sink]);
        await expect(runWithTelemetry(start, async () => { throw new TaskCancelledError(); })).rejects.toBeInstanceOf(TaskCancelledError);
        expect(sink.events.at(-1)).toMatch(/:cancelled:0$/);
    });

    it('abandons a sink whose flush never finishes', async () => {
        vi.useFakeTimers();
        const hung: TelemetrySink = { name: 'hung', flush: () => new Promise(() => {}) };
        configureSinks([hung]);
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const done = runWithTelemetry(start, async () => 'ok');
        await vi.advanceTimersByTimeAsync(10_001);
        await expect(done).resolves.toBe('ok');
        spy.mockRestore();
        vi.useRealTimers();
    });

    it('notifies run-end listeners with the collected calls', async () => {
        configureSinks([]);
        const seen: number[] = [];
        const off = onRunEnd(state => { seen.push(state.calls.length); });
        await runWithTelemetry(start, async () => { emitCall(call('a')); emitCall(call('b')); });
        off();
        expect(seen).toEqual([2]);
    });
});
