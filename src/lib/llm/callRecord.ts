/**
 * The request parameters exactly as sent to the API, except that the system
 * prompt, base64 documents and output schemas are replaced by blob hashes and
 * prompt-caching hints are dropped. Unknown SDK fields pass through verbatim.
 */
export type CallRequest = {
    model: string;
    max_tokens: number;
    system?: { hash: string };
    messages: Array<{ role: string; content: unknown }>;
    output_config?: Record<string, unknown>;
    [param: string]: unknown;
};

export type CallResponse = {
    servedModel: string;
    stopReason: string;
    text: string;
    /** Every content block as the API returned it (thinking, citations, server tool use). */
    content?: unknown[];
    usage: Record<string, unknown>;
    latencyMs: number;
    batchMode: boolean;
    promoted?: boolean;
    promotedReason?: string;
    cacheHit?: boolean;
    replayed?: boolean;
};

/**
 * Everything about one aiChat call. Written once per call and fanned out to every
 * telemetry sink; the archive copy is also what replay reads back.
 */
export type CallRecord = {
    v: 1;
    callId: string;
    traceId?: string;
    label?: string;
    phase?: string;
    request: CallRequest;
    cacheKey: string;
    response?: CallResponse;
    error?: { class: string; message: string };
    startedAt: string;
    finishedAt: string;
    /** Reconstructed from another system's trace: good for checks and reading, never for replay. */
    importedFrom?: 'langfuse';
};

/** Content stored once by hash beside the call record. */
export type CallBlob = { sha256: string; data: Buffer; mediaType: string };
