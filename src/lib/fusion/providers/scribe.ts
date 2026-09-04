import { scribeTranscriber, logprobToConfidence, type ScribeResponse } from "../../ScribeTranscribe.js";
import { getLanguageConfig } from "../../language.js";
import type { CityLanguage } from "../../../types.js";
import { sha256OfValue, shortSha } from "../hash.js";
import { throwIfAborted } from "../deadline.js";
import type { AsrProvider, AudioArtifact, NormalizedWord, ProviderContext, ProviderIdentity, ProviderResult } from "../types.js";
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

export function scribeIdentity(languageCode: string): ProviderIdentity {
    return {
        model: SCRIBE_REQUEST_PARAMS.model_id,
        paramsSha: shortSha(sha256OfValue({ ...SCRIBE_REQUEST_PARAMS, language_code: languageCode })),
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

    async identify(): Promise<ProviderIdentity> {
        return scribeIdentity(getLanguageConfig(this.language).scribeCode);
    }

    async transcribe(audio: AudioArtifact, ctx: ProviderContext): Promise<ProviderResult> {
        throwIfAborted(ctx.signal);
        if (!audio.canonicalUrl) {
            throw new ProviderError("scribe", "Scribe needs a fetchable audio URL", "no_audio_url");
        }
        const startedAt = Date.now();
        // The shared signal is honoured at the queue boundary: a request that is
        // already in flight inside ScribeTranscriber cannot be recalled, but a
        // queued one must not start once the deadline has passed.
        const raw = await Promise.race([
            this.transcriber.transcribeRaw({ audioUrl: audio.canonicalUrl, label: ctx.label, language: this.language }),
            abortRace(ctx.signal),
        ]);
        return toProviderResult(raw.response, this.language, Date.now() - startedAt);
    }
}

export function toProviderResult(response: ScribeResponse, language: CityLanguage | undefined, elapsedMs: number): ProviderResult {
    return {
        providerId: "scribe",
        identity: scribeIdentity(getLanguageConfig(language).scribeCode),
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
