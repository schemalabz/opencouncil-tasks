import { describe, it, expect } from 'vitest';
import { isTransientError, addUsage, NO_USAGE } from './ai.js';
import type Anthropic from '@anthropic-ai/sdk';

// ===========================================================================
// isTransientError — Classifies errors as transient (retryable) vs permanent
//
// The AI client retries transient errors (socket closures, connection resets)
// with exponential backoff, but throws permanent errors immediately.
// This classification is critical: false positives waste time retrying
// unrecoverable errors, false negatives fail requests that would succeed
// on retry.
// ===========================================================================

describe('isTransientError', () => {

    describe('socket errors — remote server closed the connection', () => {

        it('detects UND_ERR_SOCKET (undici socket closure, e.g. Anthropic server timeout)', () => {
            const error = { cause: { code: 'UND_ERR_SOCKET' } };
            expect(isTransientError(error)).toBe(true);
        });

        it('detects ECONNRESET at top level', () => {
            const error = { code: 'ECONNRESET' };
            expect(isTransientError(error)).toBe(true);
        });

        it('detects ECONNRESET nested in cause (wrapped by SDK)', () => {
            const error = { cause: { code: 'ECONNRESET' } };
            expect(isTransientError(error)).toBe(true);
        });
    });

    describe('"terminated" errors — Anthropic SDK wraps socket errors', () => {

        it('detects "terminated" at top-level message', () => {
            const error = { message: 'terminated' };
            expect(isTransientError(error)).toBe(true);
        });

        it('detects "terminated" in cause.message', () => {
            const error = { cause: { message: 'terminated' } };
            expect(isTransientError(error)).toBe(true);
        });
    });

    describe('non-transient errors — should NOT be retried', () => {

        it('rejects authentication errors', () => {
            const error = { status: 401, message: 'Invalid API key' };
            expect(isTransientError(error)).toBe(false);
        });

        it('rejects validation errors', () => {
            const error = { status: 400, message: 'Invalid request' };
            expect(isTransientError(error)).toBe(false);
        });

        it('rejects generic errors with no matching shape', () => {
            const error = new Error('Something unexpected');
            expect(isTransientError(error)).toBe(false);
        });

        it('rejects null/undefined', () => {
            expect(isTransientError(null)).toBe(false);
            expect(isTransientError(undefined)).toBe(false);
        });

        it('rejects empty object', () => {
            expect(isTransientError({})).toBe(false);
        });
    });
});

// ===========================================================================
// addUsage — Accumulates token usage across multiple AI calls
//
// Each AI call returns a Usage object with token counts. addUsage combines
// them into a running total. The tricky part: cache fields are nullable in
// the Anthropic SDK type, so the function must coalesce nulls to 0 before
// summing. The non-aggregatable fields (cache_creation, server_tool_use)
// are intentionally set to null since per-call details don't make sense
// in a total.
// ===========================================================================

describe('addUsage', () => {

    it('sums input and output tokens', () => {
        const a = { ...NO_USAGE, input_tokens: 100, output_tokens: 50 };
        const b = { ...NO_USAGE, input_tokens: 200, output_tokens: 75 };

        const result = addUsage(a, b);

        expect(result.input_tokens).toBe(300);
        expect(result.output_tokens).toBe(125);
    });

    it('sums cache token fields, treating null as 0', () => {
        // First call created cache, second call read from it
        const a: Anthropic.Messages.Usage = {
            ...NO_USAGE,
            input_tokens: 1000,
            output_tokens: 100,
            cache_creation_input_tokens: 500,
            cache_read_input_tokens: null,
        };
        const b: Anthropic.Messages.Usage = {
            ...NO_USAGE,
            input_tokens: 200,
            output_tokens: 100,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: 500,
        };

        const result = addUsage(a, b);

        expect(result.cache_creation_input_tokens).toBe(500);
        expect(result.cache_read_input_tokens).toBe(500);
    });

    it('handles both cache fields being null (no caching used)', () => {
        const result = addUsage(NO_USAGE, NO_USAGE);

        expect(result.cache_creation_input_tokens).toBe(0);
        expect(result.cache_read_input_tokens).toBe(0);
    });

    it('always sets non-aggregatable detail fields to null', () => {
        // cache_creation and server_tool_use contain per-call details
        // that don't make sense to aggregate across calls
        const result = addUsage(NO_USAGE, NO_USAGE);

        expect(result.cache_creation).toBeNull();
        expect(result.server_tool_use).toBeNull();
    });

    it('preserves the first non-null service_tier', () => {
        const a: Anthropic.Messages.Usage = { ...NO_USAGE, service_tier: 'standard' as any };
        const b: Anthropic.Messages.Usage = { ...NO_USAGE, service_tier: null };

        expect(addUsage(a, b).service_tier).toBe('standard');
        // Order matters: first non-null wins
        expect(addUsage(b, a).service_tier).toBe('standard');
    });

    it('is associative — (a + b) + c equals a + (b + c)', () => {
        const a: Anthropic.Messages.Usage = { ...NO_USAGE, input_tokens: 10, output_tokens: 5 };
        const b: Anthropic.Messages.Usage = { ...NO_USAGE, input_tokens: 20, output_tokens: 10 };
        const c: Anthropic.Messages.Usage = { ...NO_USAGE, input_tokens: 30, output_tokens: 15 };

        const leftAssoc = addUsage(addUsage(a, b), c);
        const rightAssoc = addUsage(a, addUsage(b, c));

        expect(leftAssoc.input_tokens).toBe(rightAssoc.input_tokens);
        expect(leftAssoc.output_tokens).toBe(rightAssoc.output_tokens);
    });
});
