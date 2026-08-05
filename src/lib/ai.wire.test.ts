// Wire-level check for the structured-outputs request shape.
//
// structuredOutputParams is unit-tested in ai.test.ts, but that only proves the
// fragment aiChat builds. The parameter still has to survive the SDK: because
// `output_config` is not on the SDK's stable request type, it is spread in
// untyped and reaches the wire only as long as the SDK forwards unknown keys.
// A quiet drop there would disable structured outputs everywhere with no type
// error and no test failure, so assert against the bytes actually sent.
//
// Runs against a throwaway localhost server (the SDK honours ANTHROPIC_BASE_URL),
// so it needs no API key. The server answers 400, which classifyTransientError
// treats as non-transient — aiChat fails fast instead of retrying.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';

type Captured = { headers: http.IncomingHttpHeaders; body: any };

let server: http.Server;
let captured: Captured | null = null;

const SCHEMA = { type: 'object', properties: { name: { type: 'string' } } } as const;

beforeAll(async () => {
    server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', chunk => (raw += chunk));
        req.on('end', () => {
            captured = { headers: req.headers, body: JSON.parse(raw || '{}') };
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                type: 'error',
                error: { type: 'invalid_request_error', message: 'wire probe' },
            }));
        });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

    const { port } = server.address() as import('net').AddressInfo;
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-wire-probe';
});

afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

describe('structured-outputs request shape', () => {

    it('puts the schema under output_config.format, with no beta header', async () => {
        const { aiChat } = await import('./ai.js');

        await expect(aiChat({
            systemPrompt: 'sys',
            userPrompt: 'usr',
            outputFormat: { type: 'json_schema', schema: SCHEMA },
        })).rejects.toBeTruthy();

        expect(captured!.body.output_config).toEqual({
            format: { type: 'json_schema', schema: SCHEMA },
        });
        // The deprecated pair: top-level parameter and the beta header that gated it.
        expect(captured!.body.output_format).toBeUndefined();
        expect(captured!.headers['anthropic-beta']).toBeUndefined();
    }, 30_000);

    it('carries the same params through the batch path', async () => {
        captured = null;
        const { aiChat } = await import('./ai.js');

        await expect(aiChat({
            systemPrompt: 'sys',
            userPrompt: 'usr',
            batchFirst: true,
            outputFormat: { type: 'json_schema', schema: SCHEMA },
        })).rejects.toBeTruthy();

        expect(captured!.body.requests[0].params.output_config).toEqual({
            format: { type: 'json_schema', schema: SCHEMA },
        });
        expect(captured!.headers['anthropic-beta']).toBeUndefined();
    }, 30_000);

    it('omits output_config entirely when no schema is requested', async () => {
        captured = null;
        const { aiChat } = await import('./ai.js');

        await expect(aiChat({ systemPrompt: 'sys', userPrompt: 'usr' })).rejects.toBeTruthy();

        expect(captured!.body).not.toHaveProperty('output_config');
    }, 30_000);
});
