import { describe, it, expect } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { classifyTransientError, formatApiError, addUsage, NO_USAGE, continuationPrompt, cutToLineBoundary } from './ai.js';

// ===========================================================================
// cutToLineBoundary — truncated partials stitch at line boundaries so the
// continuation regenerates the cut line instead of resuming mid-word
// ===========================================================================

describe('cutToLineBoundary', () => {

    it('drops the trailing incomplete line', () => {
        expect(cutToLineBoundary('1. ένα\n2. δύο\n3. τρ')).toBe('1. ένα\n2. δύο\n');
    });

    it('returns single-line output unchanged (byte-exact stitch fallback)', () => {
        const singleLine = '{"key": "value", "tru';
        expect(cutToLineBoundary(singleLine)).toBe(singleLine);
    });

    it('keeps a partial that already ends at a line boundary intact', () => {
        expect(cutToLineBoundary('1. ένα\n2. δύο\n')).toBe('1. ένα\n2. δύο\n');
    });
});

// ===========================================================================
// continuationPrompt — continuation goes in a user turn; trailing-assistant
// prefill returns 400 on Claude 4.6+ models
// ===========================================================================

describe('continuationPrompt', () => {

    it('echoes only the tail of the partial to anchor the continuation point', () => {
        const partial = 'x'.repeat(300) + '37. Καλημέρα σας';
        const prompt = continuationPrompt(partial);

        expect(prompt).toContain('37. Καλημέρα σας');
        expect(prompt).not.toContain('x'.repeat(250));
    });

    it('instructs the model not to repeat or restart numbering', () => {
        const prompt = continuationPrompt('1. ένα\n2. δύο\n3. τρ');

        expect(prompt).toContain('Do not repeat');
        expect(prompt).toContain('do not restart any numbering');
    });
});

// Helper: build SDK error instances using the SDK's own factory.
function makeApiError(status: number, errorType: string, errorMessage: string) {
    const body = { type: 'error', error: { type: errorType, message: errorMessage } };
    const headers = new Headers({ 'request-id': `req_test_${status}` });
    return Anthropic.APIError.generate(status, body, undefined, headers);
}

// ===========================================================================
// classifyTransientError
// ===========================================================================

describe('classifyTransientError', () => {

    it('classifies InternalServerError as server', () => {
        expect(classifyTransientError(makeApiError(500, 'api_error', 'Internal server error'))).toBe('server');
    });

    it('classifies APIConnectionError as connection', () => {
        expect(classifyTransientError(new Anthropic.APIConnectionError({ message: 'fail' }))).toBe('connection');
    });

    it('does not classify RateLimitError as transient (handled separately)', () => {
        expect(classifyTransientError(makeApiError(429, 'rate_limit_error', 'Rate limited'))).toBe(false);
    });

    it('does not classify BadRequestError as transient', () => {
        expect(classifyTransientError(makeApiError(400, 'invalid_request_error', 'bad'))).toBe(false);
    });

    it('returns false for plain errors', () => {
        expect(classifyTransientError(new Error('boom'))).toBe(false);
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

    it('always sets non-aggregatable detail fields to null (except server_tool_use)', () => {
        const result = addUsage(NO_USAGE, NO_USAGE);

        expect(result.cache_creation).toBeNull();
        expect(result.server_tool_use).toEqual({ web_search_requests: 0 });
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

import { vi } from 'vitest';
import { BatchPromotedError, executeBatch } from './ai.js';
import { TaskCancelledError, newTaskControl, runWithTaskControl } from './taskControl.js';

// ===========================================================================
// executeBatch — cancellation and promotion against a fake Anthropic client
// ===========================================================================

const FAKE_MESSAGE = {
    content: [{ type: 'text', text: 'hello' }],
    stop_reason: 'end_turn',
    usage: NO_USAGE,
};

const FAKE_PARAMS = { model: 'test', max_tokens: 10, system: 's', messages: [] } as any;

function fakeBatchClient(overrides: Partial<Record<'create' | 'retrieve' | 'cancel' | 'results', any>> = {}) {
    const batches = {
        create: vi.fn(async () => ({ id: 'msgbatch_test', created_at: new Date().toISOString() })),
        retrieve: vi.fn(async () => ({
            id: 'msgbatch_test', processing_status: 'ended', created_at: new Date().toISOString(),
        request_counts: { processing: 0, succeeded: 1, errored: 0, canceled: 0, expired: 0 },
        })),
        cancel: vi.fn(async () => ({ id: 'msgbatch_test', processing_status: 'canceling' })),
        results: vi.fn(async () => (async function* () {
            yield { custom_id: 'request-1', result: { type: 'succeeded', message: FAKE_MESSAGE } };
        })()),
        ...overrides,
    };
    return { client: { messages: { batches } } as any, batches };
}

describe('executeBatch cancellation & promotion', () => {

    it('cancel: cancels the Anthropic batch and throws TaskCancelledError', async () => {
        const { client, batches } = fakeBatchClient();
        const control = newTaskControl('task_1');
        control.cancel.abort(); // pre-aborted → poll wakes immediately

        await expect(
            runWithTaskControl(control, () => executeBatch(FAKE_PARAMS, {}, client))
        ).rejects.toThrow(TaskCancelledError);
        expect(batches.cancel).toHaveBeenCalledWith('msgbatch_test');
    });

    it('promote, cancel wins: throws BatchPromotedError so the caller retries via streaming', async () => {
        const { client, batches } = fakeBatchClient({
            results: vi.fn(async () => (async function* () {
                yield { custom_id: 'request-1', result: { type: 'canceled' } };
            })()),
        });
        const control = newTaskControl('task_2');
        control.promote.abort();
        control.llmMode = 'streaming';

        await expect(
            runWithTaskControl(control, () => executeBatch(FAKE_PARAMS, {}, client))
        ).rejects.toThrow(BatchPromotedError);
        expect(batches.cancel).toHaveBeenCalledWith('msgbatch_test');
    });

    it('promote, request already succeeded: returns the paid result instead of retrying', async () => {
        const { client } = fakeBatchClient(); // default results yield 'succeeded'
        const control = newTaskControl('task_3');
        control.promote.abort();
        control.llmMode = 'streaming';

        const message = await runWithTaskControl(control, () => executeBatch(FAKE_PARAMS, {}, client));
        expect(message).toEqual(FAKE_MESSAGE);
    });

    it('completes normally without any task control (CLI behavior)', async () => {
        vi.useFakeTimers();
        try {
            const { client } = fakeBatchClient();
            const pending = executeBatch(FAKE_PARAMS, {}, client);
            await vi.advanceTimersByTimeAsync(60_000);
            expect(await pending).toEqual(FAKE_MESSAGE);
        } finally {
            vi.useRealTimers();
        }
    });
});
