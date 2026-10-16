import { describe, expect, it } from 'vitest';
import { runFromLangfuseTrace, type LangfuseTrace } from './langfuseImport.js';
import { cassetteFromCalls } from '../llm/cassette.js';

const trace: LangfuseTrace = {
    id: '73a398db-aed8-494d-93d6-5cede0d29148',
    name: 'summarize',
    timestamp: '2026-10-10T18:22:50.706Z',
    environment: 'production',
    tags: ['city:athens', 'meeting:athens/oct8_2026', 'task:summarize', 'version:6'],
    input: { transcriptCount: 741 },
    output: { resultTruncated: true, resultSizeBytes: 1370203 },
    latency: 60,
    observations: [
        { id: 'root', type: 'SPAN', name: 'summarize', isRootObservation: true, startTime: '2026-10-10T18:22:50.706Z' },
        { id: 'span-1', type: 'SPAN', name: 'Phase 3: Enrichment', startTime: '2026-10-10T19:48:40.000Z', endTime: '2026-10-10T19:49:27.000Z' },
        {
            id: 'gen-1', type: 'GENERATION', name: 'subject-context-search:Κάγκελα', parentObservationId: 'span-1',
            startTime: '2026-10-10T19:48:46.367Z', endTime: '2026-10-10T19:49:20.120Z', level: 'DEFAULT', model: 'claude-sonnet-4-5-20250929',
            input: [{ role: 'system', content: 'You are a helpful assistant' }, { role: 'user', content: 'Θέμα: Κάγκελα' }],
            output: 'Δυστυχώς δεν βρέθηκαν πληροφορίες.',
            metadata: { maxTokens: 64000, stopReason: 'end_turn', batchMode: false },
            latency: 33.753, usageDetails: { input: 44564, output: 1220, web_search_requests: 3 },
        },
        { id: 'gen-2', type: 'GENERATION', name: 'contributions:x', startTime: '2026-10-10T19:40:00.000Z', level: 'ERROR', statusMessage: 'overloaded', model: 'claude-opus-4-6', input: [], output: null },
    ],
};

describe('runFromLangfuseTrace', () => {
    const { state, outcome, blobs } = runFromLangfuseTrace(trace);

    it('maps the trace to a run under the same id without dashes, keeping its tags', () => {
        expect(state.run).toMatchObject({ traceId: '73a398dbaed8494d93d65cede0d29148', taskType: 'summarize', taskVersion: 6, meeting: 'athens/oct8_2026', env: 'production' });
        // A truncated result is no result: checks that need it must say unknown, not pass.
        expect(outcome).toEqual({ status: 'success', endedAt: '2026-10-10T18:23:50.706Z' });
        expect(state.phases.map(p => p.name)).toEqual(['Phase 3: Enrichment']);
    });

    it('keeps each generation verbatim with its phase, the system prompt stored as a blob', () => {
        const ctx = state.calls.find(c => c.callId === 'gen-1')!;
        expect(ctx).toMatchObject({ label: 'subject-context-search:Κάγκελα', phase: 'Phase 3: Enrichment', importedFrom: 'langfuse' });
        expect(ctx.request).toMatchObject({ model: 'claude-sonnet-4-5-20250929', max_tokens: 64000, messages: [{ role: 'user', content: 'Θέμα: Κάγκελα' }] });
        expect(blobs.map(b => b.data.toString())).toContain('You are a helpful assistant');
        expect(ctx.response).toMatchObject({ text: 'Δυστυχώς δεν βρέθηκαν πληροφορίες.', stopReason: 'end_turn', latencyMs: 33753, usage: { input_tokens: 44564, output_tokens: 1220, server_tool_use: { web_search_requests: 3 } } });
        expect(state.calls.find(c => c.callId === 'gen-2')!.error).toEqual({ class: 'ImportedError', message: 'overloaded' });
    });

    it('reads the { system, messages } input the telemetry sink writes', () => {
        const generation = { ...trace.observations[2], id: 'gen-3', input: { system: 'You are a helpful assistant', messages: [{ role: 'user', content: [{ type: 'text', text: 'Θέμα' }] }] } };
        const imported = runFromLangfuseTrace({ ...trace, observations: [generation] });
        expect(imported.state.calls[0].request.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Θέμα' }] }]);
        expect(imported.blobs.map(b => b.data.toString())).toContain('You are a helpful assistant');
    });

    it('is never served by a cassette', () => {
        expect(cassetteFromCalls(state.calls).remaining()).toBe(0);
    });
});
