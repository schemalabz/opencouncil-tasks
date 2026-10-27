import { Subject, SummarizeResult } from '../../types.js';
import { RunWithResult } from './types.js';
import type { ArchiveStore } from '../archive/store.js';
import type { CallRecord } from '../llm/callRecord.js';
import { createArchiveSink } from '../telemetry/archiveSink.js';
import { getRunState } from '../telemetry/context.js';
import { configureSinks, emitCall, runWithTelemetry, withPhase, type RunStart } from '../telemetry/telemetry.js';

export function makeSubject(overrides: Partial<Subject> & { id: string; name: string }): Subject {
    return {
        description: 'Περιγραφή θέματος.',
        agendaItemIndex: 1,
        introducedByPersonId: null,
        speakerContributions: [],
        topicImportance: 'normal',
        proximityImportance: 'none',
        location: null,
        topicLabel: 'Διοίκηση',
        context: null,
        discussedIn: null,
        ...overrides,
    };
}

export function makeRun(traceId: string, subjects: Subject[], extras?: Partial<SummarizeResult>): RunWithResult {
    return {
        info: {
            traceId,
            timestamp: '2026-06-10T12:00:00Z',
            name: 'summarize',
            meeting: 'dev/test',
            version: 'test',
            env: 'development',
            promptsHash: null,
            isError: false,
            isCancelled: false,
            totalCost: null,
            latencySeconds: null,
        },
        result: {
            speakerSegmentSummaries: [],
            subjects,
            utteranceDiscussionStatuses: [],
            ...extras,
        },
    };
}

export function makeCall(label: string, overrides: { model?: string; usage?: Record<string, unknown>; systemHash?: string; batchMode?: boolean; cacheHit?: boolean; replayed?: boolean; error?: string } = {}): CallRecord {
    const model = overrides.model ?? 'claude-haiku-4-5';
    return {
        v: 1, callId: label, label, cacheKey: label.padEnd(64, '0'),
        startedAt: '2026-10-11T00:00:00Z', finishedAt: '2026-10-11T00:00:03Z',
        request: { model, max_tokens: 10, system: { hash: overrides.systemHash ?? 'aa'.repeat(32) }, messages: [] },
        ...(overrides.error
            ? { error: { class: 'APIError', message: overrides.error } }
            : {
                response: {
                    servedModel: model, stopReason: 'end_turn', text: 'ok',
                    usage: overrides.usage ?? { input_tokens: 100_000, output_tokens: 10_000 },
                    latencyMs: 3000, batchMode: overrides.batchMode ?? false,
                    ...(overrides.cacheHit && { cacheHit: true }),
                    ...(overrides.replayed && { replayed: true }),
                },
            }),
    };
}

/**
 * Archives one run through the real telemetry path. The run's date comes from the
 * clock, so tests fake `Date` to place it.
 */
export async function archiveRun(store: ArchiveStore, start: Omit<RunStart, 'taskId'>, body: { phases?: Record<string, CallRecord[]>; calls?: CallRecord[]; result?: unknown; error?: string }): Promise<string> {
    configureSinks([createArchiveSink(store)]);
    let traceId = '';
    try {
        await runWithTelemetry({ taskId: 'test', ...start }, async () => {
            traceId = getRunState()!.run.traceId;
            for (const [name, calls] of Object.entries(body.phases ?? {})) {
                await withPhase(name, async () => { for (const c of calls) emitCall(c); });
            }
            for (const c of body.calls ?? []) emitCall(c);
            if (body.error) throw new Error(body.error);
            return body.result;
        });
    } catch (error) {
        if (!body.error) throw error;
    } finally {
        configureSinks(null);
    }
    return traceId;
}
