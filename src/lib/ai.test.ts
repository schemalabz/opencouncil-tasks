import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { classifyTransientError, formatApiError, addUsage, NO_USAGE, continuationPrompt, cutToLineBoundary, BatchPromotedError, executeBatch } from './ai.js';
import { TaskCancelledError, newTaskControl, runWithTaskControl } from './taskControl.js';

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
        expect(result.server_tool_use).toEqual({ web_search_requests: 0, web_fetch_requests: 0 });
        // Absent on both sides stays absent, so "no thinking tokens" and "the
        // model never reported any" don't collapse into the same zero.
        expect(result.output_tokens_details).toBeNull();
        expect(result.inference_geo).toBeNull();
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

    const withDetails = (thinking: number, geo: string | null) => ({
        ...NO_USAGE, output_tokens_details: { thinking_tokens: thinking }, inference_geo: geo,
    });

    it('sums thinking tokens when either side reports them', () => {
        expect(addUsage(withDetails(10, null), withDetails(5, null)).output_tokens_details)
            .toEqual({ thinking_tokens: 15 });
        // One side reporting is enough to produce a total.
        expect(addUsage(withDetails(7, null), NO_USAGE).output_tokens_details)
            .toEqual({ thinking_tokens: 7 });
    });

    it('keeps the first non-null inference_geo', () => {
        expect(addUsage(withDetails(0, 'us'), withDetails(0, 'eu')).inference_geo).toBe('us');
        expect(addUsage(NO_USAGE, withDetails(0, 'eu')).inference_geo).toBe('eu');
    });

});

// ===========================================================================
// Request shape at the wire — `output_config` is typed on the request, so tsc
// catches a wrong shape under it but not a misspelled key: excess-property
// checks don't apply to spread expressions, so `output_confg` would compile and
// silently disable structured outputs everywhere. Types also say nothing about
// the beta header that used to gate the feature, or about whether the batch and
// streaming→batch fallback call sites re-send the same params. Assert the bytes.
//
// fetch is stubbed (as in ElevenLabsAlign.test.ts) rather than a server stood
// up, so nothing binds a socket and no API key is involved.
// ===========================================================================

describe('request shape at the wire', () => {

    type Captured = { url: string; headers: Record<string, string>; body: any };

    let aiChat: typeof import('./ai.js').aiChat;
    let fetchMock: ReturnType<typeof vi.fn>;
    const originalApiKey = process.env.ANTHROPIC_API_KEY;

    const SCHEMA = { type: 'object', properties: { name: { type: 'string' } } } as const;
    const FORMAT = { type: 'json_schema', schema: SCHEMA } as const;

    const errorResponse = (status: number, message: string) => new Response(
        JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }),
        { status, headers: { 'content-type': 'application/json' } },
    );
    /** 400 is non-transient per classifyTransientError, so aiChat fails fast. */
    const probeResponse = () => errorResponse(400, 'wire probe');

    /** Fails by naming the actual problem — no request was made — rather than
     *  dereferencing undefined inside whichever assertion happens to run first. */
    function lastRequest(): Captured {
        const call = fetchMock.mock.calls.at(-1);
        if (!call) throw new Error('aiChat made no request');
        const [url, init] = call as [string, RequestInit];
        return {
            url: String(url),
            headers: Object.fromEntries(new Headers(init.headers).entries()),
            body: JSON.parse(String(init.body ?? '{}')),
        };
    }

    beforeAll(async () => {
        fetchMock = vi.fn().mockResolvedValue(probeResponse());
        vi.stubGlobal('fetch', fetchMock);

        // The stub never checks credentials, but the SDK refuses to build a request
        // without one ("Could not resolve authentication method"), so a placeholder is
        // required for the request to reach fetch at all. Locally dotenv would supply
        // a real key and mask this; CI has no .env.
        process.env.ANTHROPIC_API_KEY = 'sk-ant-wire-probe';

        // Re-imported under the stub rather than using the module already imported at
        // the top of this file: ai.ts builds its Anthropic client at module scope and
        // the SDK captures the ambient fetch in the constructor (client.js —
        // `this.fetch = options.fetch ?? getDefaultFetch()`). Without resetting the
        // registry first, aiChat would hold the real fetch, and dotenv would have
        // handed it a working key to reach the live API with.
        vi.resetModules();
        ({ aiChat } = await import('./ai.js'));
    });

    beforeEach(() => {
        fetchMock.mockClear();
        fetchMock.mockResolvedValue(probeResponse());
    });

    afterAll(() => {
        vi.unstubAllGlobals();
        vi.resetModules();
        // Assigning undefined would store the string "undefined", so an
        // originally-unset variable has to be deleted rather than reassigned.
        if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = originalApiKey;
    });

    it('puts the schema under output_config.format, with no beta header', async () => {
        // Rejects with the stub's own 400 — which also proves the request was built
        // and dispatched, rather than failing somewhere earlier.
        await expect(aiChat({ systemPrompt: 'sys', userPrompt: 'usr', outputFormat: FORMAT }))
            .rejects.toThrow(/wire probe/);

        expect(lastRequest().body.output_config).toEqual({ format: FORMAT });
        // The deprecated pair: top-level parameter and the beta header that gated it.
        expect(lastRequest().body.output_format).toBeUndefined();
        expect(lastRequest().headers['anthropic-beta']).toBeUndefined();
    });

    it('carries the same params through the batch path', async () => {
        await expect(aiChat({ systemPrompt: 'sys', userPrompt: 'usr', batchFirst: true, outputFormat: FORMAT }))
            .rejects.toThrow(/wire probe/);

        expect(lastRequest().body.requests[0].params.output_config).toEqual({ format: FORMAT });
        expect(lastRequest().headers['anthropic-beta']).toBeUndefined();
    });

    it('omits output_config entirely when no schema is requested', async () => {
        await expect(aiChat({ systemPrompt: 'sys', userPrompt: 'usr' })).rejects.toThrow(/wire probe/);

        expect(lastRequest().body).not.toHaveProperty('output_config');
        expect(lastRequest().headers['anthropic-beta']).toBeUndefined();
    });

    it('sends the same params to the batch endpoint when streaming falls back', async () => {
        // The fallback in aiChat re-sends requestParams to the batch endpoint after
        // streaming exhausts its retries. It is a separate call site from batchFirst
        // above, and nothing else covers it. 500 is a `server` transient error, so
        // this costs two backoffs (30s then 60s) that fake timers collapse.
        fetchMock.mockResolvedValue(errorResponse(500, 'upstream boom'));
        vi.useFakeTimers();
        try {
            const assertion = expect(
                aiChat({ systemPrompt: 'sys', userPrompt: 'usr', outputFormat: FORMAT })
            ).rejects.toThrow();
            await vi.runAllTimersAsync();
            await assertion;
        } finally {
            vi.useRealTimers();
        }

        const last = lastRequest();
        expect(last.url).toContain('/v1/messages/batches');
        expect(last.body.requests[0].params.output_config).toEqual({ format: FORMAT });
    });
});

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

// ===========================================================================
// Connection drops — the shape classifyTransientError depends on
//
// When the TCP connection dies mid-stream, undici throws `TypeError:
// terminated`. The SDK's MessageStream rewraps that as a bare AnthropicError
// carrying the original as `.cause`, and classifyTransientError sniffs exactly
// that shape. Nothing in the type system holds it together, so an SDK upgrade
// can break it silently: a dropped connection would stop counting as transient,
// and a long summarize would fail outright instead of retrying and then falling
// back to batch.
//
// These drive the real SDK rather than hand-building the wrapper, so they
// detect a change in how it wraps. The client is local to the test with
// maxRetries 0 — going through aiChat's own retry loop instead would add ~15s
// of backoff for nothing.
// ===========================================================================

describe('classifyTransientError on a stream the SDK tore down', () => {

    /** A 200 whose body dies partway, the way a dropped connection presents. */
    function terminatingStreamResponse() {
        const enc = new TextEncoder();
        return new Response(new ReadableStream({
            start(c) {
                c.enqueue(enc.encode('event: message_start\ndata: ' + JSON.stringify({
                    type: 'message_start',
                    message: {
                        id: 'msg_probe', type: 'message', role: 'assistant',
                        model: 'claude-haiku-4-5-20251001', content: [],
                        stop_reason: null, stop_sequence: null,
                        usage: { input_tokens: 1, output_tokens: 1 },
                    },
                }) + '\n\n'));
                c.error(new TypeError('terminated'));
            },
        }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }

    it('classifies what the SDK rejects with as a connection error', async () => {
        const client = new Anthropic({
            apiKey: 'sk-ant-wire-probe',
            maxRetries: 0,
            fetch: (async () => terminatingStreamResponse()) as unknown as typeof fetch,
        });

        const error = await client.messages
            .stream({ model: 'claude-haiku-4-5-20251001', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] })
            .finalMessage()
            .then(() => { throw new Error('expected the stream to reject'); }, (e: unknown) => e);

        // Guard the premise: if this stops being the terminated path, the
        // assertion below would pass or fail for unrelated reasons.
        expect(String(error)).toMatch(/terminated/);
        expect(classifyTransientError(error)).toBe('connection');
    });
});
