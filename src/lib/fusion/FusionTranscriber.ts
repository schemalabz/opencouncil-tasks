import crypto from "crypto";
import type { CityLanguage, Transcript } from "../../types.js";
import { scribeResponseToTranscript, type ScribeResponse } from "../ScribeTranscribe.js";
import { fusionConfigSha, type FusionConfig } from "./config.js";
import { FusionCache, componentCacheKey, fusionCacheKey } from "./cache.js";
import { sha256OfValue } from "./hash.js";
import { resolveAudioTransport } from "./audio.js";
import { createDeadline } from "./deadline.js";
import { runFusionPython, fusionEngineRevision } from "./fusePy.js";
import { buildFusedTranscript } from "./toTranscript.js";
import { TraceWriter, type TraceComponent } from "./trace.js";
import type { ProviderSet } from "./providers/index.js";
import {
    FusionEngineError, PROVIDER_IDS, ProviderError, ScribeUnavailableError,
    type AudioArtifact, type FusionArm, type FusionInput, type FusionOutput,
    type NormalizedWord, type ProviderContext, type ProviderId, type ProviderResult,
} from "./types.js";

/**
 * The fusion provider. Everything that is hard about running three recognisers
 * for one segment lives here — cache, one shared deadline, the failure matrix,
 * the subprocess, the trace — so that the route and transcribe.ts stay thin
 * adapters over one implementation rather than two subtly different ones.
 *
 * The failure matrix (spec §4.5, tightened by the Codex review) is the part to
 * read first, because it is where a plausible-looking shortcut does damage:
 *
 *   three valid                      → fuse
 *   Scribe valid, any aux missing,
 *     invalid or late                → EXACT Scribe transcript. Never two-system
 *                                      fusion: that configuration has never been
 *                                      evaluated as a system.
 *   Scribe failed or unusable        → segment error; transcribe.ts's existing
 *                                      retry handles it, and the aux results
 *                                      stay cached so the retry re-pays Scribe only
 *   fuse.py failed / oversized /
 *     wrong sha / broken timing      → exact Scribe transcript
 *   Scribe genuinely empty           → that exact empty result
 */

export type FusionModel = "scribe" | "fusion-rules" | "fusion-policy-opus" | "fusion-policy-sonnet";

export const FUSION_MODELS: FusionModel[] = ["scribe", "fusion-rules", "fusion-policy-opus", "fusion-policy-sonnet"];

const POLICY_LLM_MODELS: Record<string, string> = {
    "fusion-policy-opus": "claude-opus-4-1",
    "fusion-policy-sonnet": "claude-sonnet-4-6",
};

export function isPolicyModel(model: FusionModel): boolean {
    return model === "fusion-policy-opus" || model === "fusion-policy-sonnet";
}

export interface FuseSegmentRequest {
    audio: AudioArtifact;
    model: FusionModel;
    language?: CityLanguage;
    label?: string;
    requestId?: string;
    signal?: AbortSignal;
    /** Reuse an already-paid Scribe call (shadow mode makes exactly one). */
    scribeResult?: ProviderResult;
}

export interface FuseSegmentResult {
    transcript: Transcript;
    outcome: "fused" | "scribe-fallback" | "scribe-only";
    fallbackReason?: string;
    requestId: string;
    audioSha256: string;
    /** The Scribe result this segment used, so a shadow run can reuse it. */
    scribeResult?: ProviderResult;
}

export interface FusionTranscriberDeps {
    config: FusionConfig;
    providers: ProviderSet;
    cache: FusionCache;
    trace: TraceWriter;
    runFusion?: typeof runFusionPython;
}

/**
 * Text chunking, frozen 2026-09-04. Python's own default is 800, and at 800 a
 * segment-sized input (2500 normalized tokens per system, ~20 minutes of
 * council audio) takes 260.6 s — over four times the 60 s resource gate,
 * because alignment cost grows far faster than chunk length. Measured on one
 * fuse.py call per value, same input, `tests/fusion/measure_chunking.py`:
 *
 *     max_tokens   800    400    240    160    120     80
 *     wall s     260.6   75.7   40.0   26.3   20.1   14.7
 *     peak RSS    340 MB at every value — time is the binding constraint
 *
 * 120 is the value whose text cost is already measured over all 391 benchmark
 * windows: +0.00009 WER against unchunked, against a 0.002 gate. 240 also fits
 * the time gate, but its ΔWER has not been measured and no sweep was run to
 * pick a winner — the config is frozen before the blind run, not tuned on it.
 *
 * This must be sent explicitly. Omitting it does not mean "no chunking"; it
 * means Python's 800.
 */
export const PRODUCTION_CHUNKING = { max_tokens: 120, anchor_n: 3, search_radius: 200 } as const;

export class FusionTranscriber {
    private readonly config: FusionConfig;
    private readonly runFusion: typeof runFusionPython;

    constructor(private readonly deps: FusionTranscriberDeps) {
        this.config = deps.config;
        this.runFusion = deps.runFusion ?? runFusionPython;
    }

    /** The single entry point. Both the route and transcribe.ts come through here. */
    async fuseSegment(request: FuseSegmentRequest): Promise<FuseSegmentResult> {
        const requestId = request.requestId ?? crypto.randomUUID();
        const startedAt = Date.now();
        const language = request.language ?? "el";
        const arm = armFor(request.model);
        const llm = this.llmEnvelopeFor(request.model);

        const deadline = createDeadline(startedAt + this.config.deadlineMs, request.signal);
        const ctx: ProviderContext = {
            signal: deadline.signal,
            deadlineAt: deadline.deadlineAt,
            label: request.label,
            transport: resolveAudioTransport(request.audio, this.config.audioTransport),
        };

        const components: TraceComponent[] = [];
        let pythonMs: number | undefined;
        let pythonStderrTail: string | undefined;

        try {
            const results = await this.collectProviders(request, ctx, requestId, components);
            const scribe = results.scribe;

            // --- Scribe validity decides whether there is anything at all ----
            if (!scribe.ok) {
                await this.writeTrace({
                    requestId, arm, audio: request.audio, components, startedAt,
                    outcome: "failed", fallbackReason: scribe.reason, pythonMs, pythonStderrTail, llm,
                });
                throw new ScribeUnavailableError(`Scribe unusable for this segment: ${scribe.detail}`, scribe.reason);
            }

            const scribeTranscript = () => scribeResponseToTranscript(
                scribe.result.raw as ScribeResponse,
                scribe.result.elapsedMs / 1000,
                request.label ?? "",
            );

            if (scribe.empty) {
                // Silence is a real answer. Fusing three empty streams would
                // invent structure that nothing heard.
                const transcript = annotate(scribeTranscript(), "scribe-fallback", "scribe_empty", this.configSha(arm, llm));
                await this.writeTrace({
                    requestId, arm, audio: request.audio, components, startedAt,
                    outcome: "scribe-only", fallbackReason: "scribe_empty", pythonMs, pythonStderrTail, llm,
                });
                return { transcript, outcome: "scribe-only", fallbackReason: "scribe_empty", requestId, audioSha256: request.audio.sha256, scribeResult: scribe.result };
            }

            if (request.model === "scribe") {
                const transcript = annotate(scribeTranscript(), "scribe", undefined, this.configSha(arm, llm));
                await this.writeTrace({
                    requestId, arm: "scribe", audio: request.audio, components, startedAt, outcome: "scribe-only", llm,
                });
                return { transcript, outcome: "scribe-only", requestId, audioSha256: request.audio.sha256, scribeResult: scribe.result };
            }

            // --- Any aux problem ⇒ exact Scribe, never two-system fusion -----
            const auxFailure = results.auxFailure;
            if (auxFailure) {
                const transcript = annotate(scribeTranscript(), "scribe-fallback", auxFailure, this.configSha(arm, llm));
                await this.writeTrace({
                    requestId, arm, audio: request.audio, components, startedAt,
                    outcome: "scribe-fallback", fallbackReason: auxFailure, llm,
                });
                return { transcript, outcome: "scribe-fallback", fallbackReason: auxFailure, requestId, audioSha256: request.audio.sha256, scribeResult: scribe.result };
            }

            // --- Three valid streams: fuse ----------------------------------
            const systems: Record<ProviderId, ProviderResult> = {
                scribe: scribe.result,
                soniox: results.soniox!,
                ours: results.ours!,
            };
            const words: Record<ProviderId, NormalizedWord[]> = {
                scribe: systems.scribe.words,
                soniox: systems.soniox.words,
                ours: systems.ours.words,
            };

            try {
                const { output, elapsedMs, stderrTail } = await this.fuse(request, arm, llm, systems, ctx, requestId);
                pythonMs = elapsedMs;
                pythonStderrTail = stderrTail;

                const transcript = buildFusedTranscript({
                    fusion: output,
                    words,
                    language,
                    audioDurationSec: request.audio.durationSec ?? (scribe.result.raw as ScribeResponse).audio_duration_secs ?? undefined,
                    transcriptionTimeSeconds: (Date.now() - startedAt) / 1000,
                    provider: providerLabel(request.model),
                    fusionConfigSha: this.configSha(arm, llm),
                });

                await this.writeTrace({
                    requestId, arm, audio: request.audio, components, startedAt, outcome: "fused",
                    pythonMs, pythonStderrTail, timingEstimatedRate: transcript.metadata.timingEstimatedRate,
                    fusionConfig: output.config, llm,
                });
                return { transcript, outcome: "fused", requestId, audioSha256: request.audio.sha256, scribeResult: scribe.result };
            } catch (error) {
                if (!(error instanceof FusionEngineError)) throw error;
                const transcript = annotate(scribeTranscript(), "scribe-fallback", error.reason, this.configSha(arm, llm));
                await this.writeTrace({
                    requestId, arm, audio: request.audio, components, startedAt,
                    outcome: "scribe-fallback", fallbackReason: error.reason,
                    fallbackDetail: error.message.slice(0, 400), pythonMs, pythonStderrTail, llm,
                });
                console.warn(`[fusion] ${request.label ?? request.audio.sha256.slice(0, 12)}: falling back to Scribe (${error.reason}): ${error.message}`);
                return { transcript, outcome: "scribe-fallback", fallbackReason: error.reason, requestId, audioSha256: request.audio.sha256, scribeResult: scribe.result };
            }
        } finally {
            deadline.dispose();
        }
    }

    /* ---------------------------------------------------------------- */

    private llmEnvelopeFor(model: FusionModel): { model: string } | null {
        if (!isPolicyModel(model)) return null;
        if (this.config.llm !== "on") {
            // Startup grants the LLM or nothing does. A request cannot buy it.
            throw new FusionEngineError(`model ${model} requires FUSION_LLM=on`, "llm_disabled");
        }
        return { model: POLICY_LLM_MODELS[model] };
    }

    private configSha(arm: FusionArm, llm: { model: string } | null): string {
        return fusionConfigSha(this.config, {
            arm,
            guard: true,
            llm,
            chunking: PRODUCTION_CHUNKING,
            engineRev: fusionEngineRevision(this.config.repoRoot),
        });
    }

    /**
     * All three providers, one shared deadline, `Promise.allSettled`. Each call
     * is raced against the deadline itself so that a provider which never
     * settles cannot hold the segment open — and so a late result cannot arrive
     * after the fallback decision and change it.
     */
    private async collectProviders(
        request: FuseSegmentRequest,
        ctx: ProviderContext,
        requestId: string,
        components: TraceComponent[],
    ): Promise<{
        scribe: { ok: true; result: ProviderResult; empty: boolean } | { ok: false; reason: string; detail: string };
        soniox?: ProviderResult;
        ours?: ProviderResult;
        auxFailure?: string;
    }> {
        const wanted: ProviderId[] = request.model === "scribe" ? ["scribe"] : [...PROVIDER_IDS];

        const settled = await Promise.allSettled(wanted.map((id) => withDeadline(id, ctx, (async () => {
            if (id === "scribe" && request.scribeResult) {
                components.push(traceComponent(request.scribeResult, true));
                return request.scribeResult;
            }
            const provider = this.deps.providers[id];
            const identity = await provider.identify(request.audio, ctx);
            const key = componentCacheKey({ audioSha256: request.audio.sha256, providerId: id, identity });
            const { value, cacheHit } = await this.deps.cache.getOrCreate(
                "component", key, () => provider.transcribe(request.audio, ctx), requestId,
            );
            components.push(traceComponent(value, cacheHit));
            return value;
        })())));

        const byId = new Map<ProviderId, PromiseSettledResult<ProviderResult>>();
        wanted.forEach((id, index) => byId.set(id, settled[index]));

        const scribeSettled = byId.get("scribe")!;
        if (scribeSettled.status === "rejected") {
            const reason = scribeSettled.reason instanceof ProviderError ? scribeSettled.reason.reason : "scribe_failed";
            components.push(errorComponent("scribe", String(scribeSettled.reason)));
            return { scribe: { ok: false, reason, detail: String(scribeSettled.reason) } };
        }

        const scribeResult = scribeSettled.value;
        const scribeText = ((scribeResult.raw as ScribeResponse)?.text ?? "").trim();
        if (scribeResult.words.length === 0 && scribeText.length > 0) {
            // Text without a word stream is not a transcript we can time or
            // fuse — and it is the shape a truncated or schema-drifted response
            // takes, so it must fail loudly rather than fuse two systems.
            return { scribe: { ok: false, reason: "scribe_no_word_stream", detail: "response has text but no word stream" } };
        }
        const empty = scribeResult.words.length === 0;

        if (request.model === "scribe") {
            return { scribe: { ok: true, result: scribeResult, empty } };
        }

        let auxFailure: string | undefined;
        const aux: Partial<Record<ProviderId, ProviderResult>> = {};
        for (const id of ["soniox", "ours"] as const) {
            const outcome = byId.get(id)!;
            if (outcome.status === "rejected") {
                const reason = outcome.reason instanceof ProviderError ? outcome.reason.reason : "provider_failed";
                components.push(errorComponent(id, String(outcome.reason)));
                auxFailure ??= `aux_${id}_${reason}`;
                continue;
            }
            if (outcome.value.words.length === 0) {
                auxFailure ??= `aux_${id}_empty`;
                continue;
            }
            aux[id] = outcome.value;
        }

        return { scribe: { ok: true, result: scribeResult, empty }, soniox: aux.soniox, ours: aux.ours, auxFailure };
    }

    private async fuse(
        request: FuseSegmentRequest,
        arm: FusionArm,
        llm: { model: string } | null,
        systems: Record<ProviderId, ProviderResult>,
        ctx: ProviderContext,
        requestId: string,
    ): Promise<{ output: FusionOutput; elapsedMs: number; stderrTail: string }> {
        const engineRev = fusionEngineRevision(this.config.repoRoot);
        const key = fusionCacheKey({
            wordListShas: {
                scribe: hashWords(systems.scribe.words),
                soniox: hashWords(systems.soniox.words),
                ours: hashWords(systems.ours.words),
            },
            normalizerRev: engineRev,
            chunkingRev: sha256OfValue({ engineRev, chunking: PRODUCTION_CHUNKING }),
            arm,
            guard: true,
            policySha: engineRev,
            llmEnvelopeSha: llm ? llm.model : null,
        });

        const input: FusionInput = {
            schema: "oc-fusion-in/1",
            audio_sha256: request.audio.sha256,
            // Order is fixed by the contract: scribe, soniox, ours.
            systems: PROVIDER_IDS.map((id) => ({
                id,
                params_sha: systems[id].identity.paramsSha,
                words: systems[id].words,
            })),
            config: { arm, guard: true, llm, chunking: { ...PRODUCTION_CHUNKING } },
        };

        let elapsedMs = 0;
        let stderrTail = "";
        const { value } = await this.deps.cache.getOrCreate<FusionOutput>("fusion", key, async () => {
            const result = await this.runFusion(input, {
                pythonBin: this.config.pythonBin,
                repoRoot: this.config.repoRoot,
                signal: ctx.signal,
                deadlineAt: ctx.deadlineAt,
            });
            elapsedMs = result.elapsedMs;
            stderrTail = result.stderrTail;
            return result.output;
        }, requestId);

        return { output: value, elapsedMs, stderrTail };
    }

    private async writeTrace(input: {
        requestId: string;
        arm: FusionArm | "scribe";
        audio: AudioArtifact;
        components: TraceComponent[];
        startedAt: number;
        outcome: "fused" | "scribe-fallback" | "scribe-only" | "failed";
        fallbackReason?: string;
        fallbackDetail?: string;
        pythonMs?: number;
        pythonStderrTail?: string;
        timingEstimatedRate?: number;
        fusionConfig?: Record<string, unknown>;
        /** The same envelope the transcript was hashed with. Passing null here
         *  while the transcript used a real one would make the trace a record
         *  of a configuration that never ran. */
        llm: { model: string } | null;
    }): Promise<void> {
        await this.deps.trace.write({
            schema: "oc-fusion-trace/1",
            requestId: input.requestId,
            createdAt: new Date().toISOString(),
            audioSha256: input.audio.sha256,
            arm: input.arm,
            mode: this.config.mode,
            configSha: this.configSha(input.arm === "scribe" ? "rules" : input.arm, input.llm),
            components: input.components,
            timings: { totalMs: Date.now() - input.startedAt, pythonMs: input.pythonMs },
            outcome: input.outcome,
            fallbackReason: input.fallbackReason,
            fallbackDetail: input.fallbackDetail,
            timingEstimatedRate: input.timingEstimatedRate,
            fusionConfig: input.fusionConfig,
            pythonStderrTail: input.pythonStderrTail,
        });
    }
}

/* -------------------------------------------------------------------- */

export function armFor(model: FusionModel): FusionArm {
    if (model === "fusion-rules" || model === "scribe") return "rules";
    return "policy";
}

function providerLabel(model: FusionModel): NonNullable<Transcript["metadata"]["provider"]> {
    return model === "scribe" ? "scribe" : model;
}

/**
 * The fallback transcript is the Scribe transcript — same utterances, same
 * words, same numbers — with metadata that says so. Only the metadata is added;
 * nothing about the transcription itself is re-derived, because "exact Scribe
 * fallback" has to mean exact.
 */
function annotate(
    transcript: Transcript,
    provider: NonNullable<Transcript["metadata"]["provider"]>,
    fallbackReason: string | undefined,
    fusionConfigSha: string,
): Transcript {
    return {
        ...transcript,
        metadata: { ...transcript.metadata, provider, fallbackReason, fusionConfigSha },
    };
}

/**
 * A provider that ignores the shared signal must not be able to hold the
 * segment open past the deadline — and, just as importantly, a result that
 * arrives after the fallback decision must not be able to change it. Losing the
 * race is final: the promise below is abandoned, not awaited later.
 */
function withDeadline<T>(id: ProviderId, ctx: ProviderContext, work: Promise<T>): Promise<T> {
    const expiry = new Promise<never>((_resolve, reject) => {
        const fire = () => reject(new ProviderError(id, `${id} did not finish before the shared deadline`, "deadline"));
        if (ctx.signal.aborted) {
            fire();
            return;
        }
        ctx.signal.addEventListener("abort", fire, { once: true });
    });
    // Swallow the late rejection of the abandoned side so it cannot surface as
    // an unhandled rejection after the segment is already decided.
    work.catch(() => { });
    return Promise.race([work, expiry]);
}

function hashWords(words: NormalizedWord[]): string {
    return crypto.createHash("sha256").update(JSON.stringify(words)).digest("hex").slice(0, 16);
}

function traceComponent(result: ProviderResult, cacheHit: boolean): TraceComponent {
    return {
        providerId: result.providerId,
        model: result.identity.model,
        paramsSha: result.identity.paramsSha,
        schemaRev: result.identity.schemaRev,
        rawSha256: result.rawSha256,
        wordCount: result.words.length,
        elapsedMs: result.elapsedMs,
        cacheHit,
    };
}

function errorComponent(providerId: ProviderId, error: string): TraceComponent {
    return {
        providerId,
        model: "unknown",
        paramsSha: "unknown",
        schemaRev: "unknown",
        rawSha256: "unknown",
        wordCount: 0,
        elapsedMs: 0,
        cacheHit: false,
        error: error.slice(0, 500),
    };
}
