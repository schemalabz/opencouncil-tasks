import { describe, it, expect } from "vitest";
import { buildFusedTranscript } from "./toTranscript.js";
import type { FusionOutput, FusionToken, NormalizedWord, ProviderId } from "./types.js";

/**
 * The invariant the benchmark depends on: the text we hand back must tokenize
 * to exactly the token sequence fuse.py chose. The offline 0.11205 was scored
 * on those `norm` tokens; if `full_transcript` normalizes to anything else, a
 * paid benchmark run measures a different system than the one we evaluated.
 */

const token = (partial: Partial<FusionToken> & { text: string; norm: string; src: ProviderId; src_word: number }): FusionToken => ({
    i: 0, col: 0, island: null, stage: "agree", agreement: 1, ...partial,
});

const output = (tokens: FusionToken[]): FusionOutput => ({
    schema: "oc-fusion/1",
    audio_sha256: "0".repeat(64),
    config: {} as FusionOutput["config"],
    tokens,
    islands: [],
    stats: {} as FusionOutput["stats"],
});

const scribe = (...spans: [string, number, number][]): NormalizedWord[] =>
    spans.map(([raw, start, end]) => ({ raw, start, end, conf: 0.9 }));

describe("buildFusedTranscript", () => {
    it("writes a raw word that normalized into several tokens exactly once", () => {
        const transcript = buildFusedTranscript({
            fusion: output([
                token({ text: "αλφα", norm: "αλφα", src: "scribe", src_word: 0 }),
                token({ text: "κ.λπ", norm: "κ", src: "scribe", src_word: 1 }),
                token({ text: "κ.λπ", norm: "λπ", src: "scribe", src_word: 1 }),
                token({ text: "γαμμα", norm: "γαμμα", src: "scribe", src_word: 2 }),
            ]),
            words: { scribe: scribe(["αλφα", 0, 0.4], ["κ.λπ", 0.5, 1.2], ["γαμμα", 1.3, 1.8]), soniox: [], ours: [] },
            language: "el",
            transcriptionTimeSeconds: 1,
            provider: "fusion" as never,
            fusionConfigSha: "sha",
        });

        expect(transcript.transcription.full_transcript).toBe("αλφα κ.λπ γαμμα");
        expect(transcript.transcription.utterances.flatMap((u) => u.words.map((w) => w.word)))
            .toEqual(["αλφα", "κ.λπ", "γαμμα"]);
    });
});
