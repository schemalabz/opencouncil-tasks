import { sha256OfValue, shortSha } from "../hash.js";
import { sleep, throwIfAborted } from "../deadline.js";
import type { AsrProvider, AudioArtifact, AudioTransport, NormalizedWord, ProviderContext, ProviderIdentity, ProviderResult } from "../types.js";
import { ProviderError } from "../types.js";
import { readFile } from "fs/promises";
import path from "path";
import { ensurePublicUrl, type PublicAudioHandle } from "../audio.js";

/**
 * Soniox `stt-async-v5` over the async REST API (spec §4.5):
 *
 *   POST   /v1/transcriptions   {model, language_hints, audio_url}
 *   GET    /v1/transcriptions/{id}              poll until completed
 *   GET    /v1/transcriptions/{id}/transcript
 *   DELETE /v1/transcriptions/{id}              always
 *
 * We pass `audio_url` rather than uploading to POST /v1/files: by the time a
 * provider runs, the bytes are already public (either the caller's own URL or
 * one temporary `fusion-tmp/` object shared by all three providers), so a
 * second upload would buy nothing and leave a second thing to delete.
 *
 * The deletes are not housekeeping: the account allows 100 pending and 2000
 * stored transcriptions, so a run that leaks them stops working partway through
 * the next one. They go in a finally block for that reason.
 */

export const SONIOX_API_BASE = process.env.SONIOX_API_BASE || "https://api.soniox.com/v1";
export const SONIOX_MODEL = "stt-async-v5";
export const SONIOX_SCHEMA_REV = "soniox-tokens/1";

const POLL_INTERVAL_MS = 2_000;

export const SONIOX_REQUEST_PARAMS = {
    model: SONIOX_MODEL,
    language_hints: ["el"],
    enable_speaker_diarization: false,
    enable_language_identification: false,
} as const;

export function sonioxIdentity(transport: AudioTransport = "url"): ProviderIdentity {
    return {
        model: SONIOX_MODEL,
        // See scribe.ts: the transport is isolation, not a decode parameter.
        paramsSha: shortSha(sha256OfValue({ ...SONIOX_REQUEST_PARAMS, transport })),
        schemaRev: SONIOX_SCHEMA_REV,
    };
}

export interface SonioxToken {
    text: string;
    start_ms?: number | null;
    end_ms?: number | null;
    confidence?: number | null;
}

export interface SonioxTranscript {
    id?: string;
    text?: string;
    tokens: SonioxToken[];
}

/**
 * Soniox emits sub-word tokens with leading whitespace at word boundaries. A
 * "word" for fusion is therefore the run of tokens between whitespace starts;
 * its span is the first token's start to the last token's end, and its
 * confidence is the minimum over the run (the weakest piece decides whether the
 * word is trustworthy).
 */
export function normalizeSonioxTokens(transcript: SonioxTranscript): NormalizedWord[] {
    const words: NormalizedWord[] = [];
    let current: { text: string; start: number | null; end: number | null; conf: number | null } | null = null;

    const flush = () => {
        if (!current) return;
        const raw = current.text.trim();
        if (raw.length > 0) {
            words.push({ raw, start: current.start, end: current.end, conf: current.conf });
        }
        current = null;
    };

    for (const token of transcript.tokens ?? []) {
        const text = token.text ?? "";
        if (text.length === 0) continue;
        const start = token.start_ms == null ? null : token.start_ms / 1000;
        const end = token.end_ms == null ? null : token.end_ms / 1000;
        const conf = token.confidence ?? null;

        if (/^\s/.test(text) || current === null) {
            flush();
            current = { text: text.trimStart(), start, end, conf };
            continue;
        }
        current.text += text;
        if (end !== null) current.end = end;
        if (current.start === null) current.start = start;
        if (conf !== null) current.conf = current.conf === null ? conf : Math.min(current.conf, conf);
    }
    flush();
    return words;
}

function apiKey(): string {
    const key = process.env.SONIOX_API_KEY;
    if (!key) {
        throw new ProviderError("soniox", "SONIOX_API_KEY is not set", "missing_credentials");
    }
    return key;
}

export class SonioxProvider implements AsrProvider {
    readonly id = "soniox" as const;

    constructor(private readonly fetchImpl: typeof fetch = fetch) { }

    async identify(_audio: AudioArtifact, ctx: ProviderContext): Promise<ProviderIdentity> {
        return sonioxIdentity(ctx.transport);
    }

    async transcribe(audio: AudioArtifact, ctx: ProviderContext): Promise<ProviderResult> {
        throwIfAborted(ctx.signal);
        const startedAt = Date.now();
        const key = apiKey();

        // Both resources are tracked from before they exist: a create whose
        // response is lost still leaves something behind on Soniox's side, and
        // the only defence is to record the id the instant it arrives.
        let published: PublicAudioHandle | undefined;
        let fileId: string | undefined;
        let transcriptionId: string | undefined;

        try {
            let source: Record<string, string>;
            if (ctx.transport === "bytes") {
                if (!audio.path) {
                    throw new ProviderError("soniox", "byte transport needs a local audio path", "no_audio_path");
                }
                fileId = (await this.uploadFile(key, audio.path, ctx)).id;
                source = { file_id: fileId };
            } else {
                published = await ensurePublicUrl(audio, { signal: ctx.signal });
                source = { audio_url: published.url };
            }

            const created = await this.request<{ id: string }>(key, "POST", "/transcriptions", ctx, {
                ...SONIOX_REQUEST_PARAMS,
                ...source,
            });
            transcriptionId = created.id;

            await this.waitUntilDone(key, transcriptionId, ctx);
            const transcript = await this.request<SonioxTranscript>(key, "GET", `/transcriptions/${transcriptionId}/transcript`, ctx);

            return {
                providerId: "soniox",
                identity: sonioxIdentity(ctx.transport),
                raw: transcript,
                rawSha256: sha256OfValue(transcript),
                words: normalizeSonioxTokens(transcript),
                elapsedMs: Date.now() - startedAt,
            };
        } finally {
            // Quota, not tidiness: 100 pending / 2000 stored transcriptions and
            // 1000 files / 10 GB of uploads per account. Order matters — Soniox
            // refuses to delete a transcription that is still processing, and
            // deleting the file under a queued job fails that job — so the
            // transcription goes first and the file only after it.
            await this.deleteQuietly(key, transcriptionId && `/transcriptions/${transcriptionId}`);
            await this.deleteQuietly(key, fileId && `/files/${fileId}`);
            if (published) await published.release();
        }
    }

    /**
     * Upload the bytes and get a file id. Used when no bucket is configured:
     * Soniox needs the audio somehow, and a vendor upload is the alternative to
     * publishing a temporary public object of our own.
     */
    private async uploadFile(key: string, filePath: string, ctx: ProviderContext): Promise<{ id: string }> {
        throwIfAborted(ctx.signal);
        const form = new FormData();
        form.append("file", new Blob([await readFile(filePath)]), path.basename(filePath));
        const response = await this.fetchImpl(`${SONIOX_API_BASE}/files`, {
            method: "POST",
            headers: { Authorization: `Bearer ${key}` },
            body: form as unknown as BodyInit,
            signal: ctx.signal,
        });
        if (!response.ok) {
            const text = await response.text().catch(() => "");
            throw new ProviderError("soniox", `POST /files returned ${response.status}: ${text.slice(0, 300)}`, `http_${response.status}`);
        }
        return (await response.json()) as { id: string };
    }

    private async waitUntilDone(key: string, id: string, ctx: ProviderContext): Promise<void> {
        for (; ;) {
            throwIfAborted(ctx.signal);
            const info = await this.request<{ status?: string; error_type?: string; error_message?: string }>(
                key, "GET", `/transcriptions/${id}`, ctx,
            );
            if (info.status === "completed") return;
            if (info.status === "error" || info.status === "failed") {
                throw new ProviderError("soniox", `transcription ${info.status}: ${info.error_type} ${info.error_message}`, "provider_error");
            }
            // Sleeping on the shared signal is what makes the deadline real:
            // otherwise a stuck job polls until the process is killed.
            await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, ctx.deadlineAt - Date.now())), ctx.signal);
            if (Date.now() >= ctx.deadlineAt) {
                throw new ProviderError("soniox", "deadline exceeded while polling", "deadline");
            }
        }
    }

    private async request<T>(key: string, method: string, path: string, ctx: ProviderContext, body?: unknown): Promise<T> {
        throwIfAborted(ctx.signal);
        const response = await this.fetchImpl(`${SONIOX_API_BASE}${path}`, {
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
            throw new ProviderError("soniox", `${method} ${path} returned ${response.status}: ${text.slice(0, 300)}`, `http_${response.status}`);
        }
        return (await response.json()) as T;
    }

    private async deleteQuietly(key: string, path: string | undefined): Promise<void> {
        if (!path) return;
        try {
            await this.fetchImpl(`${SONIOX_API_BASE}${path}`, {
                method: "DELETE",
                headers: { Authorization: `Bearer ${key}` },
                // Deliberately not on the request signal: cleanup must still run
                // when the reason we are here is that the signal fired.
                signal: AbortSignal.timeout(15_000),
            });
        } catch (error) {
            console.warn(`[fusion] soniox cleanup of ${path} failed: ${error}`);
        }
    }
}
