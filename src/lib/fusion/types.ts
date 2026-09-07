/**
 * Shared types for the three-system ASR fusion provider.
 *
 * The Python boundary (fusion/fuse.py, contract in fusion/CONTRACT.md) owns
 * alignment and island rules. Everything in src/lib/fusion owns provider
 * orchestration, timing, and transcript assembly.
 */

/** The three recognisers, in the order fuse.py requires them. */
export const PROVIDER_IDS = ["scribe", "soniox", "ours"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Fusion arms that can be requested. `policy` needs FUSION_LLM=on. */
export type FusionArm = "W" | "rules" | "policy";

/**
 * Audio is always file-backed or URL-backed, never carried as a whole buffer:
 * a 15-minute segment is ~15 MB and four concurrent arms would hold four copies.
 */
export interface AudioArtifact {
    /** Local file path, when the bytes live on this machine. */
    path?: string;
    /** Publicly fetchable URL, when one already exists (transcribe.ts always has one). */
    canonicalUrl?: string;
    sha256: string;
    sizeBytes: number;
    mime: string;
    durationSec?: number;
}

/** One provider-native word, normalized to the shape fuse.py consumes. */
export interface NormalizedWord {
    raw: string;
    start: number | null;
    end: number | null;
    conf: number | null;
}

/**
 * Identity of the exact model + configuration that produced a result. This is
 * half the component cache key: a params change must miss the cache, not
 * silently serve a result from a different system.
 */
export interface ProviderIdentity {
    /** Exact model id/alias, e.g. "scribe_v2", "stt-async-v5", a ct2 model.bin sha. */
    model: string;
    /** sha256 of the canonical request parameters (decode options, hints, ...). */
    paramsSha: string;
    /** Version of *our* parsing of this provider's response shape. */
    schemaRev: string;
}

export interface ProviderResult {
    providerId: ProviderId;
    identity: ProviderIdentity;
    /** Provider-native response, stored verbatim so a replay bundle is faithful. */
    raw: unknown;
    /** sha256 of the canonical raw response — goes in the trace, joins arms. */
    rawSha256: string;
    words: NormalizedWord[];
    /** Wall time of the provider call in milliseconds, as measured when it ran. */
    elapsedMs: number;
}

export interface ProviderContext {
    signal: AbortSignal;
    /** Absolute epoch-ms deadline shared by all three providers and the subprocess. */
    deadlineAt: number;
    label?: string;
    /**
     * How the audio reaches each provider, decided ONCE for the segment before
     * any provider is dispatched. It is not re-derived per provider: three
     * parallel calls inspecting an artifact that `ensurePublicUrl` mutates would
     * let timing choose the transport, and two of them could take different
     * paths for the same segment.
     */
    transport: AudioTransport;
}

export type AudioTransport = "url" | "bytes";

export interface AsrProvider {
    readonly id: ProviderId;
    /**
     * The identity this provider *would* produce for this audio, resolved
     * before the call so it can key the component cache. Cheap and idempotent:
     * static for Scribe and Soniox, one memoized provenance call for ours.
     */
    identify(audio: AudioArtifact, ctx: ProviderContext): Promise<ProviderIdentity>;
    transcribe(audio: AudioArtifact, ctx: ProviderContext): Promise<ProviderResult>;
}

/* ------------------------------------------------------------------ */
/* fuse.py boundary (oc-fusion-in/1 → oc-fusion/1)                      */
/* ------------------------------------------------------------------ */

export interface FusionInputSystem {
    id: ProviderId;
    params_sha: string;
    words: NormalizedWord[];
}

export interface FusionInput {
    schema: "oc-fusion-in/1";
    audio_sha256: string;
    systems: FusionInputSystem[];
    config: {
        arm: FusionArm;
        guard: boolean;
        llm: { model: string } | null;
        chunking?: Record<string, unknown>;
    };
}

export interface FusionToken {
    i: number;
    text: string;
    norm: string;
    src: ProviderId;
    /** Index into the source system's input `words`. */
    src_word: number;
    col: number;
    island: string | null;
    stage: "agree" | "rule" | "llm";
    agreement: number;
    alternatives?: unknown;
    /**
     * Optional: index of the Scribe word occupying the same column, when
     * Scribe has a token there but did not win it. Not in the frozen contract;
     * see docs/fusion-provider.md ("contract ambiguities"). When absent, a
     * non-Scribe token in a Scribe-occupied column is timed by interpolation
     * instead of by "scribe-column", which is a strictly safer estimate.
     */
    scribe_word?: number | null;
}

export interface FusionOutput {
    schema: "oc-fusion/1";
    audio_sha256: string;
    config: Record<string, unknown> & {
        arm?: string;
        guard?: boolean;
        policy_sha?: string | null;
        llm_envelope_sha?: string | null;
        code_rev?: string;
        normalizer_rev?: string;
    };
    tokens: FusionToken[];
    islands?: unknown[];
    dropped?: unknown[];
    stats?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Timing                                                              */
/* ------------------------------------------------------------------ */

export type TimingSource = "scribe-native" | "scribe-column" | "interpolated" | "unaligned";

export interface TimedWord {
    word: string;
    start: number;
    end: number;
    /** Provider confidence, same semantics as today's Word.confidence. */
    confidence: number;
    /** Column agreement from fusion: 1.0 / 0.67 / 0.33. Never merged into confidence. */
    fusionAgreement?: number;
    timingSource: TimingSource;
    timingEstimated: boolean;
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/**
 * The fusion engine produced nothing usable: non-zero exit, invalid JSON,
 * schema violation, wrong audio_sha256, or a broken timing invariant.
 * Always resolves to an exact Scribe fallback, never to a silent repair.
 */
export class FusionEngineError extends Error {
    constructor(message: string, readonly reason: string) {
        super(message);
        this.name = "FusionEngineError";
    }
}

/** Scribe itself failed or returned an unusable word stream — the segment fails. */
export class ScribeUnavailableError extends Error {
    constructor(message: string, readonly reason: string) {
        super(message);
        this.name = "ScribeUnavailableError";
    }
}

/** A provider call failed. Aux failures downgrade to Scribe fallback. */
export class ProviderError extends Error {
    constructor(readonly providerId: ProviderId, message: string, readonly reason: string) {
        super(message);
        this.name = "ProviderError";
    }
}

/** A replay bundle did not contain the requested (sha, provider) pair. */
export class ReplayMissError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ReplayMissError";
    }
}
