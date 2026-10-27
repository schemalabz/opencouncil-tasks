import { createHash } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import type { CallBlob, CallRequest } from './callRecord.js';

/**
 * JSON with sorted object keys and no whitespace; `undefined` members dropped.
 * Number and string serialisation is ECMAScript's, which is what RFC 8785 specifies.
 */
export function canonicalJson(value: unknown): string {
    return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortDeep);
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(value).sort()) {
            const v = (value as Record<string, unknown>)[key];
            if (v !== undefined) out[key] = sortDeep(v);
        }
        return out;
    }
    return value;
}

export function sha256Hex(data: string | Buffer): string {
    return createHash('sha256').update(data).digest('hex');
}

/** Bumped when the sanitisation below changes, so old recordings stop matching. */
const KEY_VERSION = 2;

/** Identity of a request: the sanitised parameters exactly as sent to the API. */
export function computeCacheKey(request: CallRequest): string {
    return sha256Hex(canonicalJson({ v: KEY_VERSION, request }));
}

/** Prompt-caching hints change billing, not the answer. */
function stripCacheControl(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stripCacheControl);
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) if (k !== 'cache_control') out[k] = stripCacheControl(v);
        return out;
    }
    return value;
}

/**
 * The request as sent, minus what can't or shouldn't be stored inline. Every
 * parameter is kept unless named here, so a new SDK field changes the key instead
 * of silently colliding (an allowlist is how LiteLLM came to serve one request's
 * answer to another). Large content moves to blobs: the system prompt, base64
 * documents and output schemas are stored once by hash.
 */
export function sanitizeParams(params: Anthropic.Messages.MessageCreateParamsNonStreaming): { request: CallRequest; blobs: CallBlob[] } {
    const blobs = new Map<string, CallBlob>();
    const addBlob = (data: Buffer, mediaType: string) => {
        const sha256 = sha256Hex(data);
        if (!blobs.has(sha256)) blobs.set(sha256, { sha256, data, mediaType });
        return sha256;
    };

    const { system, messages, output_config, ...rest } = stripCacheControl(params) as Anthropic.Messages.MessageCreateParamsNonStreaming;

    let systemRef: CallRequest['system'];
    if (system !== undefined) {
        const text = typeof system === 'string' ? system : system.map(b => b.text).join('\n\n');
        systemRef = { hash: addBlob(Buffer.from(text, 'utf8'), 'text/plain; charset=utf-8') };
    }

    const sanitizedMessages = messages.map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : m.content.map(block => {
            if (block.type === 'document' && block.source.type === 'base64') {
                const data = Buffer.from(block.source.data, 'base64');
                const { source, ...docRest } = block;
                return { ...docRest, type: 'document', source: { type: 'blob', sha256: addBlob(data, source.media_type), media_type: source.media_type, bytes: data.length } };
            }
            return block;
        }),
    }));

    let outputConfig: Record<string, unknown> | undefined;
    if (output_config) {
        const { format, ...configRest } = output_config as Record<string, unknown> & { format?: { schema?: unknown } & Record<string, unknown> };
        outputConfig = { ...configRest };
        if (format) {
            const { schema, ...formatRest } = format;
            outputConfig.format = schema === undefined ? formatRest
                : { ...formatRest, schema: { hash: addBlob(Buffer.from(canonicalJson(schema), 'utf8'), 'application/json') } };
        }
    }

    const request: CallRequest = { ...(rest as Record<string, unknown>), model: rest.model, max_tokens: rest.max_tokens, system: systemRef, messages: sanitizedMessages, output_config: outputConfig };
    return { request, blobs: [...blobs.values()] };
}

export function requestEffort(request: CallRequest): string | undefined {
    return (request.output_config as { effort?: string } | undefined)?.effort;
}
