import { sha256OfValue, shortSha } from "../hash.js";
import { sleep, throwIfAborted } from "../deadline.js";
import type { AsrProvider, AudioArtifact, AudioTransport, NormalizedWord, ProviderContext, ProviderIdentity, ProviderResult } from "../types.js";
import { ProviderError } from "../types.js";
import { readFile } from "fs/promises";
import { extname } from "path";
import { ensurePublicUrl, type PublicAudioHandle } from "../audio.js";

/**
 * Our own adapter (`artifact-ct2-cleanpack-cont-s47`) on a RunPod serverless
 * endpoint.
 *
 * Async `/run` + `/status/{id}` + `/cancel/{id}`, never `/runsync`: runsync's
 * wait caps at 300 s and a 15-minute production segment needs about 7 minutes on
 * this endpoint, so the synchronous call would return a "timeout" for a job that
 * is going to succeed — and then bill for it while nobody is listening.
 *
 * Provenance (spec §4.5): an `op: "provenance"` call is made once per process
 * and recorded in the trace, because "the same endpoint id" is not the same
 * thing as "the same model.bin" — the identity that must match the benchmark
 * manifest is the container digest and the ct2 weights hash, not the alias.
 */

export const OCASR_SCHEMA_REV = "ocasr-words/1";
const POLL_INTERVAL_MS = 3_000;

/**
 * RunPod documents 10 MB for /run (20 MB for /runsync). Base64 costs
 * 4*ceil(n/3) bytes plus the JSON envelope, so the raw-audio ceiling is just
 * under 7.5 MB. The cap here is on the SERIALIZED BODY, checked before the
 * request is built, with headroom left for the envelope.
 *
 * A 15-minute 16 kHz mono 16-bit segment is about 28.8 MB and cannot use this
 * path. It fails as `inline_payload_too_large` and the segment takes the Scribe
 * fallback: transcoding or splitting it to fit would change the audio the model
 * hears, and that is a different measurement, not a smaller request.
 */
export const OCASR_MAX_INLINE_BODY_BYTES = 9_000_000;

export const OCASR_REQUEST_PARAMS = {
    word_timestamps: true,
    language: "el",
} as const;

export interface OcAsrWord {
    word?: string;
    text?: string;
    start?: number | null;
    end?: number | null;
    prob?: number | null;
    confidence?: number | null;
}

export interface OcAsrOutput {
    words?: OcAsrWord[];
    segments?: { words?: OcAsrWord[] }[];
    /**
     * What the endpoint actually returns: the OpenCouncil Transcript schema.
     * Measured live 2026-09-07 — before that this parser looked only at `words`
     * and `segments`, found neither, and every real call produced an empty
     * stream, which the route correctly turned into a Scribe fallback. A replay
     * bundle built from a hand-written shape cannot catch that.
     */
    transcription?: { utterances?: { words?: OcAsrWord[] }[] };
    text?: string;
}

export function normalizeOcAsrWords(output: OcAsrOutput): NormalizedWord[] {
    const words = output.words
        ?? (output.transcription?.utterances ?? []).flatMap((utterance) => utterance.words ?? [])
        ?? [];
    const fallback = words.length > 0 ? words : (output.segments ?? []).flatMap((segment) => segment.words ?? []);
    return fallback
        .map((word) => ({
            raw: (word.word ?? word.text ?? "").trim(),
            start: word.start ?? null,
            end: word.end ?? null,
            conf: word.prob ?? word.confidence ?? null,
        }))
        .filter((word) => word.raw.length > 0);
}

interface RunPodStatus {
    status: string;
    output?: unknown;
    error?: unknown;
}

export class OcAsrProvider implements AsrProvider {
    readonly id = "ours" as const;
    private provenance?: Record<string, unknown>;

    constructor(private readonly fetchImpl: typeof fetch = fetch) { }

    private endpoint(): { base: string; key: string } {
        const key = process.env.RUNPOD_API_KEY;
        const id = process.env.OC_ASR_ENDPOINT_ID;
        if (!key) throw new ProviderError("ours", "RUNPOD_API_KEY is not set", "missing_credentials");
        if (!id) throw new ProviderError("ours", "OC_ASR_ENDPOINT_ID is not set", "missing_credentials");
        return { base: `https://api.runpod.ai/v2/${id}`, key };
    }

    /** Container digest, model.bin sha, decode options — for the trace, cached per process. */
    async getProvenance(ctx: ProviderContext): Promise<Record<string, unknown>> {
        if (this.provenance) return this.provenance;
        const output = await this.runJob({ op: "provenance" }, ctx);
        this.provenance = (output ?? {}) as Record<string, unknown>;
        return this.provenance;
    }

    async identify(_audio: AudioArtifact, ctx: ProviderContext): Promise<ProviderIdentity> {
        // Provenance is what makes the cache key mean "the same weights", not
        // "the same endpoint alias" — but an endpoint that cannot answer must
        // not block transcription, so a failure degrades the key, loudly.
        await this.getProvenance(ctx).catch((error) => {
            console.warn(`[fusion] oc-asr provenance unavailable for cache key: ${error}`);
            return {};
        });
        return this.identity(ctx.transport);
    }

    /**
     * Takes the transport of the call being identified. One provider instance
     * serves every concurrent segment, so reading it from a field would let a
     * URL request and an upload request swap identities across a network wait,
     * and an identity is half the component cache key.
     */
    identity(transport: AudioTransport): ProviderIdentity {
        const provenance = this.provenance ?? {};
        return {
            model: String(provenance.model_bin_sha256 ?? provenance.model ?? process.env.OC_ASR_ENDPOINT_ID ?? "oc-asr"),
            paramsSha: shortSha(sha256OfValue({ ...OCASR_REQUEST_PARAMS, provenance, transport })),
            schemaRev: OCASR_SCHEMA_REV,
        };
    }

    async transcribe(audio: AudioArtifact, ctx: ProviderContext): Promise<ProviderResult> {
        throwIfAborted(ctx.signal);
        const startedAt = Date.now();

        // Admission first, before any upload and before Soniox has been given
        // work that would only be thrown away: an oversized segment cannot use
        // this transport at all, and the sooner it says so the cheaper it is.
        let source: Record<string, unknown>;
        let published: PublicAudioHandle | undefined;
        if (ctx.transport === "bytes") {
            if (!audio.path) {
                throw new ProviderError("ours", "byte transport needs a local audio path", "no_audio_path");
            }
            const projected = Math.ceil(audio.sizeBytes / 3) * 4 + 512;
            if (projected > OCASR_MAX_INLINE_BODY_BYTES) {
                throw new ProviderError("ours",
                    `inline body would be about ${projected} bytes, over the `
                    + `${OCASR_MAX_INLINE_BODY_BYTES} limit for RunPod /run; this segment needs `
                    + "a bucket, and must not be transcoded or split to fit",
                    "inline_payload_too_large");
            }
            source = { audioBase64: (await readFile(audio.path)).toString("base64"), suffix: extname(audio.path) || ".wav" };
        } else {
            published = await ensurePublicUrl(audio, { signal: ctx.signal });
            // `audioUrl`, not `url`. Measured against the live endpoint on
            // 2026-09-07: `url` is rejected with "input needs either 'audioUrl'
            // or 'audioBase64'". The replay gate cannot see this, because a fake
            // provider never reaches RunPod.
            source = { audioUrl: published.url };
        }

        try {
            await this.getProvenance(ctx).catch((error) => {
                // Provenance is evidence, not a gate: losing it must not lose the
                // transcription, but the trace has to say that it is missing.
                console.warn(`[fusion] oc-asr provenance unavailable: ${error}`);
                return {};
            });
            const output = (await this.runJob({ ...OCASR_REQUEST_PARAMS, ...source }, ctx)) as OcAsrOutput;
            return {
                providerId: "ours",
                identity: this.identity(ctx.transport),
                raw: output,
                rawSha256: sha256OfValue(output),
                words: normalizeOcAsrWords(output),
                elapsedMs: Date.now() - startedAt,
            };
        } finally {
            if (published) await published.release();
        }
    }

    private async runJob(input: Record<string, unknown>, ctx: ProviderContext): Promise<unknown> {
        const { base, key } = this.endpoint();
        const started = await this.call<{ id?: string; status?: string; output?: unknown }>(base, key, "POST", "/run", ctx, { input });
        const jobId = started.id;
        if (!jobId) {
            throw new ProviderError("ours", `RunPod /run returned no job id: ${JSON.stringify(started).slice(0, 300)}`, "provider_error");
        }

        try {
            for (; ;) {
                throwIfAborted(ctx.signal);
                const status = await this.call<RunPodStatus>(base, key, "GET", `/status/${jobId}`, ctx);
                if (status.status === "COMPLETED") {
                    return status.output;
                }
                if (status.status === "FAILED" || status.status === "CANCELLED" || status.status === "TIMED_OUT") {
                    throw new ProviderError("ours", `RunPod job ${status.status}: ${JSON.stringify(status.error ?? "").slice(0, 300)}`, "provider_error");
                }
                await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, ctx.deadlineAt - Date.now())), ctx.signal);
                if (Date.now() >= ctx.deadlineAt) {
                    throw new ProviderError("ours", "deadline exceeded while polling", "deadline");
                }
            }
        } catch (error) {
            // A job we stop waiting for keeps running — and billing — unless it
            // is cancelled explicitly.
            await this.cancelQuietly(base, key, jobId);
            throw error;
        }
    }

    private async call<T>(base: string, key: string, method: string, path: string, ctx: ProviderContext, body?: unknown): Promise<T> {
        throwIfAborted(ctx.signal);
        const response = await this.fetchImpl(`${base}${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${key}`,
                ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: ctx.signal,
        });
        if (!response.ok) {
            const text = await response.text().catch(() => "");
            throw new ProviderError("ours", `${method} ${path} returned ${response.status}: ${text.slice(0, 300)}`, `http_${response.status}`);
        }
        return (await response.json()) as T;
    }

    private async cancelQuietly(base: string, key: string, jobId: string): Promise<void> {
        try {
            await this.fetchImpl(`${base}/cancel/${jobId}`, {
                method: "POST",
                headers: { Authorization: `Bearer ${key}` },
                signal: AbortSignal.timeout(15_000),
            });
        } catch (error) {
            console.warn(`[fusion] failed to cancel RunPod job ${jobId}: ${error}`);
        }
    }
}
