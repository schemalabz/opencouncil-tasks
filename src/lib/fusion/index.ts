import crypto from "crypto";
import type { CityLanguage, Transcript } from "../../types.js";
import { FusionCache } from "./cache.js";
import { loadFusionConfig, type FusionConfig, type FusionMode } from "./config.js";
import { createProviders, type ProviderSet } from "./providers/index.js";
import { FusionTranscriber, type FuseSegmentResult, type FusionModel } from "./FusionTranscriber.js";
import { ShadowFusionQueue } from "./shadow.js";
import { TraceWriter } from "./trace.js";
import { RawTranscriptLog } from "./rawLog.js";
import { artifactFromUrl, artifactFromFile } from "./audio.js";
import type { AudioArtifact } from "./types.js";

/**
 * Composition root. The configuration is read once, here, and everything else
 * takes it as an argument — so a test can build a whole fusion stack without
 * touching process.env, and production cannot end up with two different
 * opinions about what mode it is in.
 */

export interface FusionRuntime {
    config: FusionConfig;
    cache: FusionCache;
    trace: TraceWriter;
    /** The three raw per-system word streams. Disabled unless configured. */
    rawLog: RawTranscriptLog;
    shadowQueue: ShadowFusionQueue;
    transcriberFor(language: CityLanguage | undefined): FusionTranscriber;
    effectiveMode(): FusionMode;
    effectiveCanaryPercent(): number;
}

let runtime: FusionRuntime | undefined;

export function createFusionRuntime(config: FusionConfig): FusionRuntime {
    const cache = new FusionCache(config.cacheDir);
    const trace = new TraceWriter(config.traceDir);
    const rawLog = new RawTranscriptLog(config.rawLogDir, { maxBytes: config.rawLogMaxBytes });
    const shadowQueue = new ShadowFusionQueue(trace);

    // One provider set per language, not one per segment. OcAsrProvider caches
    // the model's provenance on the instance, so a fresh set every call means
    // one extra RunPod round trip before every single segment.
    const providerSets = new Map<string, ProviderSet>();
    const providersFor = (language: CityLanguage | undefined): ProviderSet => {
        const key = language ?? "";
        let set = providerSets.get(key);
        if (!set) {
            set = createProviders(config, language);
            providerSets.set(key, set);
        }
        return set;
    };

    return {
        config,
        cache,
        trace,
        rawLog,
        shadowQueue,
        transcriberFor: (language) => new FusionTranscriber({
            config,
            providers: providersFor(language),
            cache,
            trace,
            rawLog,
        }),
        effectiveMode: () => config.mode,
        effectiveCanaryPercent: () => config.canaryPercent,
    };
}

/** Built on first use; `loadFusionConfig` throws on an invalid value. */
export function getFusionRuntime(): FusionRuntime {
    if (!runtime) {
        runtime = createFusionRuntime(loadFusionConfig());
    }
    return runtime;
}

/** Test hook — drops the process-wide runtime so the next call rebuilds it. */
export function resetFusionRuntime(): void {
    runtime = undefined;
}

/**
 * Deterministic, meeting-level canary allocation. Meeting-level because a
 * meeting whose segments come from two different systems is neither a control
 * nor a treatment — the transcript would be a mixture nobody evaluated.
 *
 * No meeting key ⇒ never canary. Guessing a key from a URL would silently
 * reallocate every time a URL changed.
 */
export function isCanarySelected(meetingKey: string | undefined, canaryPercent: number): boolean {
    if (!meetingKey || canaryPercent <= 0) return false;
    if (canaryPercent >= 100) return true;
    const digest = crypto.createHash("sha256").update(meetingKey).digest();
    return digest.readUInt32BE(0) % 100 < canaryPercent;
}

export interface SegmentRequest {
    audioUrl: string;
    label?: string;
    language?: CityLanguage;
    meetingKey?: string;
    signal?: AbortSignal;
}

/**
 * `on` path: fuse this segment, or return the exact Scribe transcript when the
 * failure matrix says to. Throws only when Scribe itself is unusable, which is
 * the existing per-segment retry's business.
 */
export async function transcribeSegmentFused(
    request: SegmentRequest,
    model: FusionModel = "fusion-rules",
    rt: FusionRuntime = getFusionRuntime(),
): Promise<Transcript> {
    const audio = await artifactFromUrl(request.audioUrl, { signal: request.signal });
    try {
        const result = await rt.transcriberFor(request.language).fuseSegment({
            audio,
            model,
            language: request.language,
            label: request.label,
            signal: request.signal,
        });
        return result.transcript;
    } finally {
        await audio.cleanup();
    }
}

/**
 * `shadow` path: one Scribe call in total. Its result is what the caller gets,
 * and the very same result is handed to the background fusion run — paying for
 * Scribe twice would make the shadow both more expensive and less comparable.
 */
export async function transcribeSegmentShadow(
    request: SegmentRequest,
    rt: FusionRuntime = getFusionRuntime(),
): Promise<Transcript> {
    const audio = await artifactFromUrl(request.audioUrl, { signal: request.signal });
    const transcriber = rt.transcriberFor(request.language);

    let scribeOnly: FuseSegmentResult;
    try {
        scribeOnly = await transcriber.fuseSegment({
            audio,
            model: "scribe",
            language: request.language,
            label: request.label,
            signal: request.signal,
        });
    } catch (error) {
        await audio.cleanup();
        throw error;
    }

    const outcome = rt.shadowQueue.enqueue({
        audioSha256: audio.sha256,
        run: async () => {
            try {
                await transcriber.fuseSegment({
                    audio: stripCleanup(audio),
                    model: "fusion-rules",
                    language: request.language,
                    label: request.label,
                    scribeResult: scribeOnly.scribeResult,
                });
            } finally {
                await audio.cleanup();
            }
        },
    });
    if (outcome === "dropped_capacity") {
        await audio.cleanup();
    }

    // The returned transcript is Scribe's own, unannotated: shadow mode must be
    // invisible in the output, or it is not a shadow.
    return stripFusionMetadata(scribeOnly.transcript);
}

function stripFusionMetadata(transcript: Transcript): Transcript {
    const { provider, fallbackReason, fusionConfigSha, timingEstimatedRate, ...metadata } = transcript.metadata;
    return { ...transcript, metadata };
}

function stripCleanup(audio: AudioArtifact & { cleanup?: unknown }): AudioArtifact {
    const { path, canonicalUrl, sha256, sizeBytes, mime, durationSec } = audio;
    return { path, canonicalUrl, sha256, sizeBytes, mime, durationSec };
}

export { artifactFromFile, artifactFromUrl, FusionTranscriber, loadFusionConfig };
export type { FusionModel, FusionConfig, FusionMode };
