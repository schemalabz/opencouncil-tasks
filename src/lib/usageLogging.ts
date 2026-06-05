import Anthropic from '@anthropic-ai/sdk';
import { formatTokenCount } from '../utils.js';
import { addUsage, type UsageStats } from './ai.js';

/**
 * Log token usage for a single operation or phase
 * @param label Human-readable label for the operation
 * @param usage Token usage statistics
 * @param detailed Whether to show detailed metrics
 */
export function logUsage(label: string, usage: Anthropic.Messages.Usage, detailed = false): void {
    const cacheCreation = usage.cache_creation_input_tokens || 0;
    const cacheRead = usage.cache_read_input_tokens || 0;
    const hasCacheMetrics = cacheCreation > 0 || cacheRead > 0;

    console.log(`   📊 ${label}: ${formatTokenCount(usage.input_tokens)} input, ${formatTokenCount(usage.output_tokens)} output`);

    // Always show cache metrics when present (not just in detailed mode)
    if (hasCacheMetrics) {
        if (cacheCreation > 0) {
            console.log(`      💾 Cache write: ${formatTokenCount(cacheCreation)}`);
        }
        if (cacheRead > 0) {
            console.log(`      ⚡ Cache read: ${formatTokenCount(cacheRead)}`);
        }
    }

    if (detailed) {
        // Other detailed metrics can be added here in the future
    }
}

/**
 * Log token usage breakdown across multiple phases with totals
 * @param title Section title (e.g., "TOTAL TOKEN USAGE")
 * @param phases Array of labeled usage statistics for each phase
 */
export function logMultiPhaseUsage(
    title: string,
    phases: ({ label: string } & UsageStats)[]
): void {
    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(title);
    console.log('═══════════════════════════════════════════════════════════');

    // Calculate totals
    let totalUsage = phases[0]?.usage || {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        cache_creation: null,
        server_tool_use: null,
        service_tier: null
    };

    for (let i = 1; i < phases.length; i++) {
        totalUsage = addUsage(totalUsage, phases[i].usage);
    }

    // Log individual phases with model, mode, and per-phase cache stats
    phases.forEach(({ label, usage, resolvedModel, batchMode }) => {
        const tags: string[] = [];
        if (resolvedModel) tags.push(resolvedModel);
        if (batchMode) tags.push('batch');
        const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';

        const details: string[] = [];
        const cacheWrite = usage.cache_creation_input_tokens || 0;
        const cacheRead = usage.cache_read_input_tokens || 0;
        if (cacheWrite > 0 || cacheRead > 0) {
            details.push(`cache: ${formatTokenCount(cacheWrite)} write, ${formatTokenCount(cacheRead)} read`);
        }
        const webSearches = usage.server_tool_use?.web_search_requests || 0;
        if (webSearches > 0) {
            details.push(`${webSearches} web searches`);
        }
        const detailStr = details.length > 0 ? ` (${details.join(', ')})` : '';

        console.log(`   ${label}${tagStr}: ${formatTokenCount(usage.input_tokens)}/${formatTokenCount(usage.output_tokens)}${detailStr}`);
    });

    // Separator
    console.log(`   ─────────────────────────────────────────────────────────`);

    // Log totals
    const totalInput = totalUsage.input_tokens;
    const totalOutput = totalUsage.output_tokens;
    const cacheCreation = totalUsage.cache_creation_input_tokens || 0;
    const cacheRead = totalUsage.cache_read_input_tokens || 0;

    // Note: cache_creation_input_tokens is a subset of input_tokens (for billing purposes)
    // Total tokens = input_tokens (non-cached) + cache_read_input_tokens (cached) + output_tokens
    const totalTokens = totalInput + cacheRead + totalOutput;

    console.log(`   Input:  ${formatTokenCount(totalInput)}`);
    console.log(`   Output: ${formatTokenCount(totalOutput)}`);

    // Show cache savings if prompt caching was used
    if (cacheCreation > 0 || cacheRead > 0) {
        console.log('');
        console.log('   💰 Cache Savings:');
        if (cacheCreation > 0) {
            console.log(`      Cache writes: ${formatTokenCount(cacheCreation)}`);
        }
        if (cacheRead > 0) {
            console.log(`      Cache reads:  ${formatTokenCount(cacheRead)}`);
        }

        // Calculate net savings (tokens read from cache minus tokens written to cache)
        const netSavings = cacheRead - cacheCreation;
        if (netSavings > 0) {
            console.log(`      Net savings:  ${formatTokenCount(netSavings)} tokens`);

            // Calculate efficiency (what percentage of prompt tokens were served from cache)
            const totalPromptTokens = totalInput + cacheRead;
            const efficiency = ((cacheRead / totalPromptTokens) * 100).toFixed(1);
            console.log(`      Efficiency:   ${efficiency}% of prompt tokens cached`);
        }
    }

    console.log('');
    console.log(`   Total:  ${formatTokenCount(totalTokens)}`);
    console.log('═══════════════════════════════════════════════════════════');
}
