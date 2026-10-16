import type { CallBlob, CallRecord } from '../llm/callRecord.js';
import { isCancellation } from '../taskControl.js';
import { getRunState, newSpanId, newTraceId, runWithRunState, type PhaseInfo, type RunInfo, type RunState } from './context.js';
import type { RunOutcome, TelemetrySink } from './sink.js';

type SinkFactory = () => TelemetrySink | null;

/** What a call carries besides its record: content referenced by hash. */
export type CallExtras = { blobs?: CallBlob[] };

const factories = new Map<string, SinkFactory>();
const runEndListeners: Array<(state: RunState, outcome: RunOutcome) => Promise<void> | void> = [];
let sinks: TelemetrySink[] | null = null;

/** Sink factories register themselves by name; TELEMETRY_SINKS picks which ones run. */
export function registerSinkFactory(name: string, factory: SinkFactory): void {
    factories.set(name, factory);
    sinks = null;
}

/** Overrides the env-derived sink list (tests, and callers that need an explicit set). */
export function configureSinks(explicit: TelemetrySink[] | null): void {
    sinks = explicit;
}

function wantedSinks(): string[] {
    return (process.env.TELEMETRY_SINKS ?? 'archive,langfuse,posthog').split(',').map(s => s.trim()).filter(Boolean);
}

/** Whether TELEMETRY_SINKS lets data reach this platform, for emitters that write to it outside a sink. */
export function sinkWanted(name: string): boolean {
    return wantedSinks().includes(name);
}

export function activeSinks(): TelemetrySink[] {
    if (sinks) return sinks;
    sinks = wantedSinks().flatMap(name => {
        const factory = factories.get(name);
        if (!factory) return [];
        try {
            const sink = factory();
            return sink ? [sink] : [];
        } catch (e) {
            console.error(`Telemetry sink ${name} failed to start:`, e);
            return [];
        }
    });
    return sinks;
}

/** Runs after every run's sinks have been told it ended (post-task checks hang off this). */
export function onRunEnd(listener: (state: RunState, outcome: RunOutcome) => Promise<void> | void): () => void {
    runEndListeners.push(listener);
    return () => {
        const i = runEndListeners.indexOf(listener);
        if (i >= 0) runEndListeners.splice(i, 1);
    };
}

function safe(sink: TelemetrySink, hook: string, fn: () => unknown): void {
    try {
        const out = fn();
        if (out instanceof Promise) out.catch(e => console.error(`Telemetry sink ${sink.name}.${hook} failed:`, e));
    } catch (e) {
        console.error(`Telemetry sink ${sink.name}.${hook} failed:`, e);
    }
}

const FLUSH_CEILING_MS = 10_000;

async function withCeiling(sink: TelemetrySink, hook: string, fn: () => Promise<void> | void): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const ceiling = new Promise<void>(resolve => {
        timer = setTimeout(() => {
            console.error(`Telemetry sink ${sink.name}.${hook} exceeded ${FLUSH_CEILING_MS}ms; abandoning it`);
            resolve();
        }, FLUSH_CEILING_MS);
    });
    try {
        await Promise.race([Promise.resolve().then(fn).catch(e => console.error(`Telemetry sink ${sink.name}.${hook} failed:`, e)), ceiling]);
    } finally {
        clearTimeout(timer);
    }
}

export function emitCall(call: CallRecord, extras: CallExtras = {}): void {
    const state = getRunState();
    const record: CallRecord = state ? { ...call, traceId: state.run.traceId, phase: call.phase ?? state.phase?.name } : call;
    state?.calls.push(record);
    for (const sink of activeSinks()) {
        if (sink.onCall) safe(sink, 'onCall', () => sink.onCall!(state?.run, record, extras));
    }
}

export async function withPhase<R>(name: string, fn: () => Promise<R>): Promise<R> {
    const state = getRunState();
    if (!state) return fn();
    const phase: PhaseInfo = { id: newSpanId(), name, startedAt: new Date().toISOString() };
    state.phases.push(phase);
    try {
        return await runWithRunState({ ...state, phase }, fn);
    } finally {
        phase.endedAt = new Date().toISOString();
        for (const sink of activeSinks()) {
            if (sink.onPhaseEnd) safe(sink, 'onPhaseEnd', () => sink.onPhaseEnd!(state.run, phase));
        }
    }
}

export type RunStart = Omit<RunInfo, 'traceId' | 'startedAt'> & { traceId?: string };

/**
 * Runs `fn` as one telemetry run: every aiChat call inside it is collected and
 * fanned out, and the sinks are flushed before returning. Sink failures and slow
 * flushes never change `fn`'s outcome.
 */
export async function runWithTelemetry<R>(start: RunStart, fn: () => Promise<R>): Promise<R> {
    const run: RunInfo = { ...start, traceId: start.traceId ?? newTraceId(), startedAt: new Date().toISOString() };
    const state: RunState = { run, phases: [], calls: [] };
    const active = activeSinks();
    for (const sink of active) {
        if (sink.onRunStart) safe(sink, 'onRunStart', () => sink.onRunStart!(run));
    }
    let outcome: RunOutcome;
    try {
        const result = await runWithRunState(state, fn);
        outcome = { status: 'success', result, endedAt: new Date().toISOString() };
        return result;
    } catch (error) {
        outcome = {
            status: isCancellation(error) ? 'cancelled' : 'error',
            error: error instanceof Error ? error.message : String(error),
            endedAt: new Date().toISOString(),
        };
        throw error;
    } finally {
        const ended = outcome!;
        await Promise.all(active.map(sink => sink.onRunEnd ? withCeiling(sink, 'onRunEnd', () => sink.onRunEnd!(state, ended)) : undefined));
        await Promise.all(active.map(sink => sink.flush ? withCeiling(sink, 'flush', () => sink.flush!()) : undefined));
        for (const listener of runEndListeners) {
            try {
                const out = listener(state, ended);
                if (out instanceof Promise) out.catch(e => console.error('Run-end listener failed:', e));
            } catch (e) {
                console.error('Run-end listener failed:', e);
            }
        }
    }
}

/** Flushes every sink (for calls made outside a run, e.g. ad-hoc CLI commands). */
export async function flushTelemetry(): Promise<void> {
    await Promise.all(activeSinks().map(sink => sink.flush ? withCeiling(sink, 'flush', () => sink.flush!()) : undefined));
}
