import type { Transcript } from "../../types.js";
import { timedWordsToUtterances } from "./utterances.js";
import { assignTimings } from "./timing.js";
import type { FusionOutput, NormalizedWord, ProviderId } from "./types.js";

export interface BuildTranscriptInput {
    fusion: FusionOutput;
    words: Record<ProviderId, NormalizedWord[]>;
    language: string;
    audioDurationSec?: number;
    transcriptionTimeSeconds: number;
    provider: NonNullable<Transcript["metadata"]["provider"]>;
    fusionConfigSha: string;
}

/**
 * Fused tokens → the Transcript shape downstream already consumes. Nothing here
 * is new to consumers: applyDiarization and /fixTranscript read
 * `words[].{word,start,end,confidence}` exactly as they do today, and the fusion
 * fields are additive and optional.
 */
export function buildFusedTranscript(input: BuildTranscriptInput): Transcript {
    const { words, timingEstimatedRate } = assignTimings({
        tokens: input.fusion.tokens,
        words: input.words,
        segmentDurationSec: input.audioDurationSec,
    });

    const utterances = timedWordsToUtterances(words, input.language);
    const audioDuration = input.audioDurationSec
        ?? (utterances.length > 0 ? utterances[utterances.length - 1].end : 0);

    return {
        metadata: {
            audio_duration: audioDuration,
            number_of_distinct_channels: 1,
            billing_time: audioDuration,
            transcription_time: input.transcriptionTimeSeconds,
            provider: input.provider,
            fusionConfigSha: input.fusionConfigSha,
            timingEstimatedRate,
        },
        transcription: {
            languages: [input.language],
            full_transcript: words.map((word) => word.word).join(" ").trim(),
            utterances,
        },
    };
}
