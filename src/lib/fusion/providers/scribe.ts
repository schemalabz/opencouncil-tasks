import { scribeTranscriber, logprobToConfidence, type ScribeResponse } from "../../ScribeTranscribe.js";
import { getLanguageConfig } from "../../language.js";
import type { CityLanguage } from "../../../types.js";
import { sha256OfValue, shortSha } from "../hash.js";
import { throwIfAborted } from "../deadline.js";
import { ensurePublicUrl, type PublicAudioHandle } from "../audio.js";
import type { AsrProvider, AudioArtifact, AudioTransport, NormalizedWord, ProviderContext, ProviderIdentity, ProviderResult } from "../types.js";
import { ProviderError } from "../types.js";

export const SCRIBE_SCHEMA_REV = "scribe-words/1";

/**
 * Mirror of the form fields ScribeTranscribe.ts sends. It lives here because the
 * component cache key must change whenever the request changes — if these drift
 * apart, a cached result from the old parameters is served for the new ones.
 * ScribeTranscribe.test.ts guards the request itself; this guards its identity.
 */
export const SCRIBE_REQUEST_PARAMS = {
    model_id: "scribe_v2",
    no_verbatim: true,
    tag_audio_events: false,
    timestamps_granularity: "word",
    diarize: false,
} as const;

export function scribeIdentity(languageCode: string, transport: AudioTransport = "url"): ProviderIdentity {
    return {
        model: SCRIBE_REQUEST_PARAMS.model_id,
        // The transport is in the key as conservative isolation, not because it
        // is a decode parameter. Sending the same bytes by URL and by upload
        // ought to give the same words; nobody has measured that here, so a
        // result fetched one way is never served for the other.
        paramsSha: shortSha(sha256OfValue({ ...SCRIBE_REQUEST_PARAMS, language_code: languageCode, transport })),
        schemaRev: SCRIBE_SCHEMA_REV,
    };
}

/**
 * Scribe's `spacing` and `audio_event` entries are not words; fuse.py aligns
 * word tokens only. Punctuation stays attached to the raw word, which is what
 * `raw` means in the contract.
 */
export function normalizeScribeWords(response: ScribeResponse): NormalizedWord[] {
    return (response.words ?? [])
        .filter((word) => word.type === "word")
        .map((word) => ({
            raw: word.text,
            start: word.start ?? null,
            end: word.end ?? null,
            conf: logprobToConfidence(word.logprob),
        }));
}

export class ScribeProvider implements AsrProvider {
    readonly id = "scribe" as const;

    constructor(private readonly language: CityLanguage | undefined, private readonly transcriber = scribeTranscriber) { }

    async identify(_audio: AudioArtifact, ctx: ProviderContext): Promise<ProviderIdentity> {
        return scribeIdentity(getLanguageConfig(this.language).scribeCode, ctx.transport);
    }

    async transcribe(audio: AudioArtifact, ctx: ProviderContext): Promise<ProviderResult> {
        throwIfAborted(ctx.signal);
        if (ctx.transport === "bytes" && !audio.path) {
            throw new ProviderError("scribe", "byte transport needs a local audio path", "no_audio_path");
        }
        if (ctx.transport === "url" && !audio.canonicalUrl && !audio.path) {
            throw new ProviderError("scribe", "Scribe needs a fetchable audio URL", "no_audio_url");
        }

        const startedAt = Date.now();
        // A segment that arrived as an upload has bytes and no URL, and Scribe
        // cannot be handed a local file under URL transport. Publish it the way
        // the other two providers already do, and take it down afterwards.
        let published: PublicAudioHandle | undefined;
        try {
            let audioUrl = audio.canonicalUrl;
            if (ctx.transport === "url" && !audioUrl) {
                published = await ensurePublicUrl(audio, { signal: ctx.signal });
                audioUrl = published.url;
            }

            // The shared signal is honoured at the queue boundary: a request that is
            // already in flight inside ScribeTranscriber cannot be recalled, but a
            // queued one must not start once the deadline has passed.
            const raw = await Promise.race([
                this.transcriber.transcribeRaw(ctx.transport === "bytes"
                    ? { audioPath: audio.path, label: ctx.label, language: this.language, signal: ctx.signal }
                    : { audioUrl, label: ctx.label, language: this.language, signal: ctx.signal }),
                abortRace(ctx.signal),
            ]);
            return toProviderResult(raw.response, this.language, Date.now() - startedAt, ctx.transport);
        } finally {
            // Cost, not tidiness: a temp object per segment adds up, and nothing
            // else knows this copy exists.
            if (published) await published.release();
        }
    }
}

export function toProviderResult(response: ScribeResponse, language: CityLanguage | undefined, elapsedMs: number, transport: AudioTransport = "url"): ProviderResult {
    return {
        providerId: "scribe",
        identity: scribeIdentity(getLanguageConfig(language).scribeCode, transport),
        raw: response,
        rawSha256: sha256OfValue(response),
        words: normalizeScribeWords(response),
        elapsedMs,
    };
}

function abortRace(signal: AbortSignal): Promise<never> {
    return new Promise((_resolve, reject) => {
        if (signal.aborted) {
            reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
            return;
        }
        signal.addEventListener("abort", () => {
            reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
        }, { once: true });
    });
}
