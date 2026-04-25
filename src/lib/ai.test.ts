import { describe, it, expect } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { isTransientError, formatApiError, addUsage, NO_USAGE } from './ai.js';

// Helper: build SDK error instances using the SDK's own factory.
function makeApiError(status: number, errorType: string, errorMessage: string): Anthropic.APIError {
    const body = { type: 'error', error: { type: errorType, message: errorMessage } };
    const headers = new Headers({ 'request-id': `req_test_${status}` });
    return Anthropic.APIError.generate(status, body, undefined, headers);
}

// ===========================================================================
// isTransientError
// ===========================================================================

describe('isTransientError', () => {

    it('retries InternalServerError (500)', () => {
        expect(isTransientError(makeApiError(500, 'api_error', 'Internal server error'))).toBe(true);
    });

    it('retries APIConnectionError', () => {
        expect(isTransientError(new Anthropic.APIConnectionError({ message: 'fail' }))).toBe(true);
    });

    it('does not retry RateLimitError (handled separately)', () => {
        expect(isTransientError(makeApiError(429, 'rate_limit_error', 'Rate limited'))).toBe(false);
    });

    it('does not retry BadRequestError', () => {
        expect(isTransientError(makeApiError(400, 'invalid_request_error', 'bad'))).toBe(false);
    });

    it('returns false for plain errors', () => {
        expect(isTransientError(new Error('boom'))).toBe(false);
    });
});

// ===========================================================================
// formatApiError — the string that reaches Discord via TaskManager
// ===========================================================================

describe('formatApiError', () => {

    it('extracts status, type, message, and request id from an API error', () => {
        const err = makeApiError(500, 'api_error', 'Internal server error');
        const result = formatApiError(err);

        expect(result.message).toBe('500 api_error: Internal server error (request: req_test_500)');
        expect(result.cause).toBe(err);
    });

    it('passes through non-SDK errors unchanged', () => {
        const err = new Error('disk full');
        expect(formatApiError(err)).toBe(err);
    });

    it('wraps non-Error values in an Error', () => {
        expect(formatApiError('string')).toBeInstanceOf(Error);
    });
});

// ===========================================================================
// addUsage
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
        const result = addUsage(NO_USAGE, NO_USAGE);

        expect(result.cache_creation).toBeNull();
        expect(result.server_tool_use).toBeNull();
    });

    it('preserves the first non-null service_tier', () => {
        const a: Anthropic.Messages.Usage = { ...NO_USAGE, service_tier: 'standard' as any };
        const b: Anthropic.Messages.Usage = { ...NO_USAGE, service_tier: null };

        expect(addUsage(a, b).service_tier).toBe('standard');
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
