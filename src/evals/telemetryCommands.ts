import type { Command } from 'commander';
import { openArchive } from '../lib/archive/store.js';
import { requireArchivedRun } from '../lib/runs/fetch.js';
import { getLangfuseClient } from '../lib/observability.js';
import { parseIntOption } from '../cliOptions.js';
import { POSTHOG_READ_ENV, posthogQuery, posthogReadConfig } from '../lib/telemetry/posthogQuery.js';

type SinkCount = { sink: string; generations: number | null; note?: string };

async function langfuseCount(traceId: string): Promise<SinkCount> {
    const client = getLangfuseClient();
    if (!client) return { sink: 'langfuse', generations: null, note: 'LANGFUSE_* not set' };
    try {
        const trace = await client.api.trace.get(traceId);
        return { sink: 'langfuse', generations: trace.observations.filter(o => o.type === 'GENERATION').length };
    } catch (e) {
        return { sink: 'langfuse', generations: 0, note: (e as Error).message.slice(0, 80) };
    }
}

async function posthogCount(traceId: string): Promise<SinkCount> {
    const config = posthogReadConfig();
    if (!config) return { sink: 'posthog', generations: null, note: `${POSTHOG_READ_ENV} not set` };
    try {
        const out = await posthogQuery(config)(`select count() from events where event = '$ai_generation' and properties.$ai_trace_id = '${traceId.replace(/[^0-9a-f]/g, '')}' and timestamp > now() - interval 30 day`);
        return { sink: 'posthog', generations: Number(out.results[0]?.[0] ?? 0) };
    } catch (e) {
        return { sink: 'posthog', generations: 0, note: (e as Error).message.slice(0, 80) };
    }
}

export function registerTelemetryCommands(evalCmd: Command): void {
    evalCmd.command('telemetry')
        .description('Telemetry sink checks')
        .command('verify <traceId>')
        .description('Check that every call of an archived run reached Langfuse and PostHog under the same trace id')
        .option('--wait <seconds>', 'keep polling while a sink is behind (PostHog ingestion takes minutes)', parseIntOption, 0)
        .action(async (traceId: string, o: { wait: number }) => {
            const archived = await requireArchivedRun(traceId, openArchive());
            const expected = archived.calls.length;
            const deadline = Date.now() + o.wait * 1000;
            let counts: SinkCount[];
            for (;;) {
                counts = await Promise.all([langfuseCount(traceId), posthogCount(traceId)]);
                if (counts.every(c => c.generations === null || c.generations === expected) || Date.now() > deadline) break;
                await new Promise(r => setTimeout(r, 15_000));
            }
            console.log(`archive    ${expected} calls (${archived.run.taskType}, env ${archived.run.env})`);
            for (const c of counts) console.log(`${c.sink.padEnd(10)} ${c.generations ?? '-'} generations${c.note ? ` (${c.note})` : ''}${c.generations === expected ? ' ✓' : ''}`);
            if (counts.some(c => c.generations !== null && c.generations !== expected)) process.exitCode = 1;
        });
}
