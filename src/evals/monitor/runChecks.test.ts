import { describe, expect, it } from 'vitest';
import { loadModes } from '../registry/registry.js';
import { runChecksOnRun, verdictBySlug } from './runChecks.js';
import type { CallRecord } from '../../lib/llm/callRecord.js';
import type { RunInfo } from '../../lib/telemetry/context.js';

const run: RunInfo = { traceId: 'a'.repeat(32), taskType: 'summarize', taskVersion: 6, taskId: 't', env: 'production', startedAt: '2026-10-11T00:00:00Z', meeting: 'zografou/sep8_2026' };
const contextCall = (text: string, id: string): CallRecord => ({
    v: 1, callId: id, label: 'subject-context-search:Θέμα', cacheKey: id.padEnd(64, '0'), startedAt: 't', finishedAt: 't',
    request: { model: 'claude-sonnet-4-5-20250929', max_tokens: 10, messages: [] },
    response: { servedModel: 'claude-sonnet-4-5-20250929', stopReason: 'end_turn', text, content: [{ type: 'text', text }], usage: {}, latencyMs: 1, batchMode: false },
});

describe('runChecksOnRun', () => {
    it('runs a real registry detector over the calls it applies to', async () => {
        const modes = loadModes().filter(m => m.slug === 'context_disclaimer_preamble');
        const records = await runChecksOnRun({ run, calls: [
            contextCall('Δυστυχώς δεν μπόρεσα να ανακτήσω επαρκείς πληροφορίες για το θέμα.', 'c1'),
            contextCall('Το έργο αφορά την ανάπλαση της πλατείας και χρηματοδοτείται από το ΕΣΠΑ.', 'c2'),
        ] }, modes);
        expect(records.map(r => [r.callId, r.result])).toEqual([['c1', 'fail'], ['c2', 'pass']]);
        expect(verdictBySlug(records)).toEqual({ context_disclaimer_preamble: 'fail' });
    }, 30_000);

    it('turns a throwing detector into unknown, never a pass', async () => {
        const [mode] = loadModes().filter(m => m.slug === 'context_disclaimer_preamble');
        const broken = { ...mode, id: 'FM-9999', detector: { kind: 'code' as const, module: 'src/evals/checks/does-not-exist.ts' } };
        const records = await runChecksOnRun({ run, calls: [contextCall('x', 'c3')] }, [broken]);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ result: 'unknown', evidence: expect.stringMatching(/failed to load/) });
    });
});
