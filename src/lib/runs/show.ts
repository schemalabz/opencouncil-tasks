import { getLangfuseClient } from '../observability.js';

type Observation = {
    id: string;
    type: string;
    name?: string | null;
    startTime?: string | Date | null;
    endTime?: string | Date | null;
    model?: string | null;
    parentObservationId?: string | null;
    usageDetails?: Record<string, number> | null;
    calculatedTotalCost?: number | null;
    metadata?: Record<string, unknown> | null;
    level?: string | null;
    statusMessage?: string | null;
};

function duration(start?: string | Date | null, end?: string | Date | null): string {
    if (!start || !end) return 'running';
    const seconds = Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000);
    return seconds >= 90 ? `${Math.floor(seconds / 60)}m${seconds % 60}s` : `${seconds}s`;
}

function formatUsage(usage?: Record<string, number> | null): string {
    if (!usage) return '';
    const parts = [`${(usage.input ?? 0).toLocaleString()} in`, `${(usage.output ?? 0).toLocaleString()} out`];
    if (usage.cache_creation_input_tokens) parts.push(`${usage.cache_creation_input_tokens.toLocaleString()} cache-write`);
    if (usage.cache_read_input_tokens) parts.push(`${usage.cache_read_input_tokens.toLocaleString()} cache-read`);
    if (usage.web_search_requests) parts.push(`${usage.web_search_requests} searches`);
    return parts.join(', ');
}

function formatGeneration(g: Observation, indent: string): string {
    const cost = g.calculatedTotalCost ? ` | $${g.calculatedTotalCost.toFixed(3)}` : '';
    const error = g.level === 'ERROR' ? ` ⚠ ${g.statusMessage ?? 'error'}` : '';
    const batch = (g.metadata as { batchMode?: boolean } | null)?.batchMode ? ' [batch]' : '';
    const lines = [`${indent}${g.name ?? 'generation'} | ${duration(g.startTime, g.endTime)} | ${g.model ?? '-'}${batch}${cost}${error}`];
    const usage = formatUsage(g.usageDetails);
    if (usage) lines.push(`${indent}  ${usage}`);
    return lines.join('\n');
}

/** Print a human-readable tree view of a traced run. */
export async function showRun(traceId: string): Promise<void> {
    const client = getLangfuseClient();
    if (!client) {
        throw new Error('Langfuse is not configured. Set LANGFUSE_SECRET_KEY/LANGFUSE_PUBLIC_KEY in .env.');
    }
    const { data: trace } = await client.fetchTrace(traceId);
    if (!trace || !('id' in trace)) {
        throw new Error(`Trace ${traceId} not found: ${JSON.stringify(trace).slice(0, 200)}`);
    }

    console.log(`${trace.name}  ${trace.id}`);
    console.log(`  tags:     ${(trace.tags ?? []).join(', ')}`);
    console.log(`  session:  ${trace.sessionId ?? '-'}`);
    console.log(`  started:  ${new Date(trace.timestamp).toISOString()}`);
    console.log(`  latency:  ${trace.latency ? Math.round(trace.latency) + 's' : '-'} | cost: ${trace.totalCost ? '$' + trace.totalCost.toFixed(3) : '-'}`);
    console.log(`  input:    ${JSON.stringify(trace.input ?? null).slice(0, 200)}`);

    const output = trace.output as Record<string, unknown> | null;
    const sizeBytes = (trace.metadata as { resultSizeBytes?: number } | null)?.resultSizeBytes;
    if (!output) {
        console.log('  output:   (none — running or completion update lost)');
    } else if (output.resultTruncated) {
        console.log(`  output:   truncated (${sizeBytes} bytes) — summary: ${JSON.stringify(output.resultSummary).slice(0, 200)}`);
    } else {
        const stats = Object.entries(output)
            .map(([key, value]) => Array.isArray(value) ? `${key}[${value.length}]` : key)
            .join(', ');
        console.log(`  output:   ${stats}${sizeBytes ? ` (${sizeBytes} bytes)` : ''}`);
    }

    const observations = ((trace.observations ?? []) as Observation[])
        .sort((a, b) => String(a.startTime ?? '').localeCompare(String(b.startTime ?? '')));
    const spans = observations.filter(o => o.type === 'SPAN');
    const generations = observations.filter(o => o.type === 'GENERATION');
    const events = observations.filter(o => o.type === 'EVENT');

    console.log('');
    for (const span of spans) {
        console.log(`▸ ${span.name} (${duration(span.startTime, span.endTime)})`);
        for (const g of generations.filter(g => g.parentObservationId === span.id)) {
            console.log(formatGeneration(g, '    '));
        }
    }
    for (const g of generations.filter(g => !g.parentObservationId)) {
        console.log(formatGeneration(g, ''));
    }
    for (const e of events) {
        console.log(`⚠ [${e.level ?? 'EVENT'}] ${e.name}: ${e.statusMessage ?? ''}`);
    }
    if (observations.length === 0) {
        console.log('(no observations — task makes no LLM calls, or is still starting)');
    }
}
