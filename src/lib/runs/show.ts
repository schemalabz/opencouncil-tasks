import { openArchive, type ArchiveStore } from '../archive/store.js';
import type { CallRecord } from '../llm/callRecord.js';
import { summarizeTaskInput } from '../observability.js';
import { callCostUsd, callsCostUsd } from '../pricing.js';
import { requireArchivedRun } from './fetch.js';

function duration(start?: string, end?: string): string {
    if (!start || !end) return 'running';
    const seconds = (new Date(end).getTime() - new Date(start).getTime()) / 1000;
    if (seconds < 10) return `${seconds.toFixed(1)}s`;
    const whole = Math.round(seconds);
    return whole >= 90 ? `${Math.floor(whole / 60)}m${whole % 60}s` : `${whole}s`;
}

const num = (value: unknown): number => (typeof value === 'number' ? value : 0);

/** One line of token counters from an API `usage` object. */
export function formatUsage(usage?: Record<string, unknown> | null): string {
    if (!usage) return '';
    const serverTools = (usage.server_tool_use ?? {}) as Record<string, unknown>;
    const outputDetails = (usage.output_tokens_details ?? {}) as Record<string, unknown>;
    const parts = [`${num(usage.input_tokens).toLocaleString()} in`, `${num(usage.output_tokens).toLocaleString()} out`];
    const optional: [number, string][] = [
        [num(usage.cache_creation_input_tokens), 'cache-write'],
        [num(usage.cache_read_input_tokens), 'cache-read'],
        [num(serverTools.web_search_requests), 'searches'],
        [num(serverTools.web_fetch_requests), 'fetches'],
        [num(outputDetails.thinking_tokens), 'thinking'],
    ];
    for (const [count, what] of optional) if (count) parts.push(`${count.toLocaleString()} ${what}`);
    return parts.join(', ');
}

function formatCall(call: CallRecord, indent: string): string {
    const r = call.response;
    const tags = [r?.batchMode && '[batch]', r?.replayed ? '[replayed]' : r?.cacheHit && '[cached]'].filter(Boolean).join(' ');
    const cost = callCostUsd(call);
    const fields = [
        call.label ?? call.callId,
        duration(call.startedAt, call.finishedAt),
        `${r?.servedModel ?? call.request.model}${tags ? ` ${tags}` : ''}`,
        ...(cost ? [`$${cost.toFixed(3)}`] : []),
    ];
    const error = call.error ? ` ⚠ ${call.error.class}: ${call.error.message}` : '';
    const lines = [`${indent}${fields.join(' | ')}${error}`];
    const usage = formatUsage(r?.usage);
    if (usage) lines.push(`${indent}  ${usage}`);
    return lines.join('\n');
}

/** Print a human-readable view of an archived run: header, input, output and its calls by phase. */
export async function showRun(traceId: string, store: ArchiveStore = openArchive()): Promise<void> {
    const { run, outcome, phases, calls, result } = await requireArchivedRun(traceId, store);
    const spend = callsCostUsd(calls);

    console.log(`${run.taskType}  ${run.traceId}`);
    console.log(`  meeting:  ${run.meeting ?? '-'} | version: ${run.taskVersion ?? '-'} | env: ${run.env}`);
    console.log(`  started:  ${run.startedAt}`);
    console.log(`  latency:  ${duration(run.startedAt, outcome.endedAt)} | status: ${outcome.status} | cost: $${spend.usd.toFixed(3)} (${spend.live} live of ${calls.length} calls)`);
    if (outcome.error) console.log(`  error:    ${outcome.error}`);
    console.log(`  input:    ${JSON.stringify(summarizeTaskInput(run.input ?? null)).slice(0, 300)}`);

    if (result === undefined) {
        console.log(`  output:   (none${outcome.status === 'success' ? ' archived — results over 20 MB are left out' : ''})`);
    } else if (result && typeof result === 'object' && !Array.isArray(result)) {
        const stats = Object.entries(result)
            .map(([key, value]) => Array.isArray(value) ? `${key}[${value.length}]` : key)
            .join(', ');
        console.log(`  output:   ${stats} (${Buffer.byteLength(JSON.stringify(result)).toLocaleString()} bytes)`);
    } else {
        console.log(`  output:   ${JSON.stringify(result).slice(0, 200)}`);
    }

    console.log('');
    // Calls name their phase, not a phase instance, so a repeated phase name lists its calls once.
    const printed = new Set<CallRecord>();
    for (const phase of phases) {
        console.log(`▸ ${phase.name} (${duration(phase.startedAt, phase.endedAt)})`);
        for (const call of calls.filter(c => c.phase === phase.name && !printed.has(c))) {
            printed.add(call);
            console.log(formatCall(call, '    '));
        }
    }
    for (const call of calls.filter(c => !printed.has(c))) console.log(formatCall(call, ''));
    if (calls.length === 0) console.log('(no LLM calls)');
}
