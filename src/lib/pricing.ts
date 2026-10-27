import type { CallRecord } from './llm/callRecord.js';

// List prices, USD per million tokens (platform.claude.com/docs/en/about-claude/pricing, 2026-10-08).
// Cache writes are billed at 1.25× input; cache reads at `cacheReadMult` × input.
export type ModelPrice = {
    in: number;
    out: number;
    cacheReadMult: number;
    /** Haiku 5.5 bills a prompt above `aboveTokens` at a higher rate for the whole request. */
    longPrompt?: { aboveTokens: number; in: number; out: number };
};

export type UsageLike = {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
    server_tool_use?: { web_search_requests?: number | null } | null;
};

export const PRICES: Record<string, ModelPrice> = {
    'claude-haiku-4-5-20251001': { in: 1, out: 5, cacheReadMult: 0.1 },
    'claude-haiku-4-5': { in: 1, out: 5, cacheReadMult: 0.1 },
    'claude-haiku-5-5': { in: 0.1, out: 0.5, cacheReadMult: 0.1, longPrompt: { aboveTokens: 100_000, in: 0.5, out: 2.5 } },
    'claude-sonnet-4-5-20250929': { in: 3, out: 15, cacheReadMult: 0.1 },
    'claude-sonnet-4-6': { in: 3, out: 15, cacheReadMult: 0.1 },
    'claude-sonnet-5': { in: 2, out: 10, cacheReadMult: 0.1 },
    'claude-sonnet-5-5': { in: 2, out: 10, cacheReadMult: 0.05 },
    'claude-opus-4-6': { in: 5, out: 25, cacheReadMult: 0.1 },
    'claude-opus-4-7': { in: 5, out: 25, cacheReadMult: 0.1 },
    'claude-opus-4-8': { in: 5, out: 25, cacheReadMult: 0.1 },
    'claude-opus-5': { in: 5, out: 25, cacheReadMult: 0.1 },
    'claude-opus-5-5': { in: 4, out: 20, cacheReadMult: 0.05 },
    'claude-fable-5-1': { in: 10, out: 50, cacheReadMult: 0.025 },
};

const CACHE_WRITE_MULT = 1.25;
// Anthropic's web-search list price, $10 per 1,000 searches: a per-search fee, outside the token tiers and the batch discount.
const WEB_SEARCH_USD = 10 / 1000;

export type CostParts = { input: number; output: number; tools: number };

export const totalUsd = (parts: CostParts): number => parts.input + parts.output + parts.tools;

export const isPriced = (model: string): boolean => model in PRICES;

/** List-price cost of one request split into its input side (cache reads and writes included), output side and paid server tools; null when the model is not priced here. */
export function costPartsUsd(model: string, usage: UsageLike, opts: { batch?: boolean } = {}): CostParts | null {
    const p = PRICES[model];
    if (!p) return null;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    const promptTokens = usage.input_tokens + cacheRead + cacheWrite;
    const tier = p.longPrompt && promptTokens > p.longPrompt.aboveTokens ? p.longPrompt : p;
    const discount = opts.batch ? 2 : 1;
    return {
        input: (usage.input_tokens * tier.in + cacheRead * tier.in * p.cacheReadMult + cacheWrite * tier.in * CACHE_WRITE_MULT) / 1e6 / discount,
        output: usage.output_tokens * tier.out / 1e6 / discount,
        tools: (usage.server_tool_use?.web_search_requests ?? 0) * WEB_SEARCH_USD,
    };
}

/** List-price cost of one request; null when the model is not priced here. */
export function costUsd(model: string, usage: UsageLike, opts: { batch?: boolean } = {}): number | null {
    const parts = costPartsUsd(model, usage, opts);
    return parts && totalUsd(parts);
}

/**
 * Spend of one call, split as `costPartsUsd` splits it. A cache hit or replay cost nothing (its
 * usage is what the original call billed). Null with no response, no token counts, or a model
 * not priced here. A served snapshot id the table lacks is priced as the requested model, which
 * a spend ceiling checked before the call.
 */
export function callCostPartsUsd(call: CallRecord): CostParts | null {
    const r = call.response;
    if (!r) return null;
    if (r.cacheHit) return { input: 0, output: 0, tools: 0 };
    const usage = r.usage as UsageLike;
    if (typeof usage?.input_tokens !== 'number' || typeof usage.output_tokens !== 'number') return null;
    return costPartsUsd(r.servedModel, usage, { batch: r.batchMode }) ?? costPartsUsd(call.request.model, usage, { batch: r.batchMode });
}

/** `callCostPartsUsd` as one total. */
export function callCostUsd(call: CallRecord): number | null {
    const parts = callCostPartsUsd(call);
    return parts && totalUsd(parts);
}

/** Spend of the calls that actually reached the model (cache hits and replays cost nothing). */
export function callsCostUsd(calls: CallRecord[]): { usd: number; live: number } {
    let usd = 0; let live = 0;
    for (const c of calls) {
        if (!c.response || c.response.cacheHit) continue;
        live++;
        usd += callCostUsd(c) ?? 0;
    }
    return { usd, live };
}
