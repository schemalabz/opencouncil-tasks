import { AsyncLocalStorage } from 'node:async_hooks';
import type { Cassette } from './cassette.js';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type CallOverrides = { model?: string; effort?: Effort; maxTokens?: number };

/**
 * How aiChat treats calls in the current async context. Production runs with the
 * default; evaluation runs set a policy around each case.
 */
export type CallPolicy = {
    mode: 'live' | 'replay';
    /** Label globs that still call the model while everything else replays. */
    live?: string[];
    /**
     * Serve a stored response when one exists. Unset defers to the call site (the
     * decision readers ask for it); false forces fresh samples, as repeats need.
     */
    cacheRead?: boolean;
    /** Store every live response so it can be replayed later. */
    cacheWrite: boolean;
    /** Label glob → request overrides; the first matching glob wins. */
    overrides?: Record<string, CallOverrides>;
    /** Replay strictly from this recorded run; without it, any recording of the request serves. */
    cassette?: Cassette;
    /** A replayed call with no recording: fail (default) or call the model and record it. */
    onMiss?: 'error' | 'live';
    /** Shared spend ceiling: once reached, the next live call fails instead of spending more. */
    budget?: { limitUsd: number; spentUsd: number };
};

export const DEFAULT_POLICY: CallPolicy = { mode: 'live', cacheWrite: true };

/** Runs `fn` without serving any stored response (the CLI's --skip-cache). */
export function withoutCacheReads<R>(fn: () => Promise<R>): Promise<R> {
    return runWithCallPolicy({ ...getCallPolicy(), cacheRead: false }, fn);
}

const storage = new AsyncLocalStorage<CallPolicy>();

export function getCallPolicy(): CallPolicy {
    return storage.getStore() ?? DEFAULT_POLICY;
}

export function runWithCallPolicy<R>(policy: CallPolicy, fn: () => Promise<R>): Promise<R> {
    return storage.run(policy, fn);
}

const globCache = new Map<string, RegExp>();
export function matchesGlob(label: string, glob: string): boolean {
    let re = globCache.get(glob);
    if (!re) {
        re = new RegExp('^' + glob.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
        globCache.set(glob, re);
    }
    return re.test(label);
}

export function resolveOverrides(label: string | undefined, policy: CallPolicy = getCallPolicy()): CallOverrides {
    if (!policy.overrides) return {};
    const name = label ?? 'aiChat';
    for (const [glob, overrides] of Object.entries(policy.overrides)) {
        if (matchesGlob(name, glob)) return overrides;
    }
    return {};
}

export function shouldReplay(label: string | undefined, policy: CallPolicy = getCallPolicy()): boolean {
    if (policy.mode !== 'replay') return false;
    const name = label ?? 'aiChat';
    return !(policy.live ?? []).some(glob => matchesGlob(name, glob));
}

export class BudgetExceededError extends Error {
    constructor(public readonly limitUsd: number, public readonly spentUsd: number) {
        super(`Spend ceiling reached: $${spentUsd.toFixed(2)} of $${limitUsd.toFixed(2)}`);
        this.name = 'BudgetExceededError';
    }
}

/** An unpriced model would count as free under a spend ceiling and never stop. */
export class UnpricedModelError extends Error {
    constructor(public readonly model: string) {
        super(`No price for ${model} in pricing.ts; a spend ceiling cannot be enforced on it`);
        this.name = 'UnpricedModelError';
    }
}

/** A replayed call had no recording: the run can't be reproduced without the network. */
export class ReplayMissError extends Error {
    constructor(public readonly cacheKey: string, public readonly label?: string) {
        super(`No recorded response for ${label ?? 'aiChat'} (cacheKey ${cacheKey.slice(0, 12)}…); replay needs a matching recording`);
        this.name = 'ReplayMissError';
    }
}
