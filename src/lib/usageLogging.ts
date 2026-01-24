import Anthropic from '@anthropic-ai/sdk';
import { formatTokenCount } from '../utils.js';
import { addUsage } from './ai.js';

/**
 * Log token usage for a single operation or phase
 * @param label Human-readable label for the operation
 * @param usage Token usage statistics
 * @param detailed Whether to show cache details
 */
export function logUsage(label: string, usage: Anthropic.Messages.Usage, detailed = false): void {
    console.log(`   📊 ${label}: ${formatTokenCount(usage.input_tokens)} input, ${formatTokenCount(usage.output_tokens)} output`);

    if (detailed) {
        const cacheCreation = usage.cache_creation_input_tokens || 0;
        const cacheRead = usage.cache_read_input_tokens || 0;

        if (cacheCreation > 0) {
            console.log(`      Cache creation: ${formatTokenCount(cacheCreation)}`);
        }
        if (cacheRead > 0) {
            console.log(`      Cache read: ${formatTokenCount(cacheRead)}`);
        }
    }
}

/**
 * Log token usage breakdown across multiple phases with totals
 * @param title Section title (e.g., "TOTAL TOKEN USAGE")
 * @param phases Array of labeled usage statistics for each phase
 */
export function logMultiPhaseUsage(
    title: string,
    phases: { label: string; usage: Anthropic.Messages.Usage }[]
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

    // Log individual phases
    phases.forEach(({ label, usage }) => {
        console.log(`   ${label}: ${formatTokenCount(usage.input_tokens)}/${formatTokenCount(usage.output_tokens)}`);
    });

    // Separator
    console.log(`   ─────────────────────────────────────────────────────────`);

    // Log totals
    const totalInput = totalUsage.input_tokens;
    const totalOutput = totalUsage.output_tokens;
    const cacheCreation = totalUsage.cache_creation_input_tokens || 0;
    const cacheRead = totalUsage.cache_read_input_tokens || 0;

    console.log(`   Input:  ${formatTokenCount(totalInput)}`);
    console.log(`   Output: ${formatTokenCount(totalOutput)}`);

    if (cacheCreation > 0) {
        console.log(`   Cache creation: ${formatTokenCount(cacheCreation)}`);
    }
    if (cacheRead > 0) {
        console.log(`   Cache read: ${formatTokenCount(cacheRead)}`);
    }

    console.log(`   Total:  ${formatTokenCount(totalInput + totalOutput + cacheCreation + cacheRead)}`);
    console.log('═══════════════════════════════════════════════════════════');
}
