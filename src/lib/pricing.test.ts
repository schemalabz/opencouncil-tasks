import { describe, it, expect } from 'vitest';
import { callsCostUsd, costPartsUsd, costUsd } from './pricing.js';
import { makeCall } from './runs/fixtures.js';

describe('costUsd', () => {
    it('prices input, output and cache tokens per model', () => {
        expect(costUsd('claude-sonnet-4-6', { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0 }))
            .toBeCloseTo(3 + 1.5 + 0.3, 6);
    });
    it('uses the 0.05× cache-read multiplier on Sonnet 5.5', () => {
        expect(costUsd('claude-sonnet-5-5', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 })).toBeCloseTo(0.1, 6);
    });
    it('switches Haiku 5.5 to the long-prompt tier above 100K prompt tokens', () => {
        expect(costUsd('claude-haiku-5-5', { input_tokens: 200_000, output_tokens: 0 })).toBeCloseTo(0.1, 6);
        expect(costUsd('claude-haiku-5-5', { input_tokens: 50_000, output_tokens: 0 })).toBeCloseTo(0.005, 6);
    });
    it('halves the price for batch requests', () => {
        expect(costUsd('claude-haiku-4-5-20251001', { input_tokens: 1_000_000, output_tokens: 0 }, { batch: true })).toBeCloseTo(0.5, 6);
    });
    it('returns null for an unknown model', () => {
        expect(costUsd('claude-unknown-9', { input_tokens: 1, output_tokens: 1 })).toBeNull();
    });
});

describe('costPartsUsd', () => {
    it('puts cache reads and writes on the input side and halves both sides for batch', () => {
        const parts = costPartsUsd('claude-sonnet-4-6', { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 }, { batch: true });
        expect(parts!.input).toBeCloseTo((3 + 0.3 + 3.75) / 2, 6);
        expect(parts!.output).toBeCloseTo(1.5 / 2, 6);
    });
});

describe('callsCostUsd', () => {
    it('counts only calls that reached the model', () => {
        // $0.15 live, half that in batch; a served recording and a failed call cost nothing.
        const calls = [makeCall('a'), makeCall('b', { batchMode: true }), makeCall('c', { cacheHit: true }), makeCall('d', { error: 'overloaded' })];
        const spend = callsCostUsd(calls);
        expect(spend.live).toBe(2);
        expect(spend.usd).toBeCloseTo(0.225, 6);
    });
});
