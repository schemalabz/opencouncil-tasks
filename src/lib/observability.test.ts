import { afterEach, describe, expect, it } from 'vitest';
import { runWithTaskTrace, withPhaseSpan } from './observability.js';
import { configureSinks, emitCall } from './telemetry/telemetry.js';
import type { RunInfo, RunState } from './telemetry/context.js';
import type { RunOutcome, TelemetrySink } from './telemetry/sink.js';
import type { CallRecord } from './llm/callRecord.js';

const OPTS = { taskType: 'test', version: 1, input: {}, callbackUrl: 'https://opencouncil.gr/api/cities/chania/meetings/m1/taskStatuses/ts1', taskId: 'task-1' };

function captureSink() {
    const runs: RunInfo[] = [];
    const ends: Array<{ state: RunState; outcome: RunOutcome }> = [];
    const sink: TelemetrySink = {
        name: 'capture',
        onRunStart: run => { runs.push(run); },
        onRunEnd: (state, outcome) => { ends.push({ state, outcome }); },
    };
    configureSinks([sink]);
    return { runs, ends };
}

afterEach(() => configureSinks(null));

describe('runWithTaskTrace', () => {
    it('returns the task result and starts a run with the task identity', async () => {
        const { runs } = captureSink();
        await expect(runWithTaskTrace(OPTS, async () => 42)).resolves.toBe(42);
        expect(runs[0]).toMatchObject({ taskType: 'test', taskVersion: 1, taskId: 'task-1' });
    });

    it('rethrows the task error and ends the run as an error', async () => {
        const { ends } = captureSink();
        await expect(runWithTaskTrace(OPTS, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
        expect(ends[0].outcome).toMatchObject({ status: 'error', error: 'boom' });
    });
});

describe('withPhaseSpan', () => {
    it('attributes calls made inside it to the phase', async () => {
        const { ends } = captureSink();
        const call: CallRecord = {
            v: 1, callId: 'c', cacheKey: 'k', startedAt: 't0', finishedAt: 't1',
            request: { model: 'm', max_tokens: 1, messages: [] },
        };
        await runWithTaskTrace(OPTS, () => withPhaseSpan('Phase 1', async () => { emitCall(call); }));
        expect(ends[0].state.calls[0].phase).toBe('Phase 1');
    });
});
