import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { FusionTranscriber, PRODUCTION_CHUNKING } from "./FusionTranscriber.js";
import { FusionCache } from "./cache.js";
import { TraceWriter } from "./trace.js";
import { loadFusionConfig } from "./config.js";
import { scribeResponseToTranscript, type ScribeResponse } from "../ScribeTranscribe.js";
import {
    FusionEngineError, ScribeUnavailableError, ProviderError,
    type AsrProvider, type AudioArtifact, type FusionOutput, type ProviderContext,
    type ProviderId, type ProviderIdentity, type ProviderResult,
} from "./types.js";
import type { ProviderSet } from "./providers/index.js";

/**
 * The failure matrix, one row per test. These are the rows where a plausible
 * implementation does the wrong thing quietly, so each one asserts what the
 * *caller* gets, not what the internals did.
 */

const AUDIO: AudioArtifact = {
    sha256: "d".repeat(64),
    sizeBytes: 1024,
    mime: "audio/mpeg",
    canonicalUrl: "https://cdn.example/segment.mp3",
    durationSec: 10,
};

const SCRIBE_RESPONSE: ScribeResponse = {
    language_code: "ell",
    language_probability: 0.99,
    text: "Η επιτροπή συνεδριάζει.",
    audio_duration_secs: 10,
    words: [
        { text: "Η", type: "word", start: 0, end: 0.4, logprob: -0.1 },
        { text: " ", type: "spacing", start: 0.4, end: 0.5 },
        { text: "επιτροπή", type: "word", start: 0.5, end: 1.2, logprob: -0.2 },
        { text: " ", type: "spacing", start: 1.2, end: 1.3 },
        { text: "συνεδριάζει.", type: "word", start: 1.3, end: 2.4, logprob: -0.3 },
    ],
};

const identity = (id: ProviderId): ProviderIdentity => ({ model: `${id}-model`, paramsSha: `${id}-params`, schemaRev: `${id}/1` });

function result(id: ProviderId, raws: [string, number, number][], raw: unknown = { of: id }): ProviderResult {
    return {
        providerId: id,
        identity: identity(id),
        raw,
        rawSha256: `${id}-raw-sha`,
        words: raws.map(([word, start, end]) => ({ raw: word, start, end, conf: 0.8 })),
        elapsedMs: 5,
    };
}

const scribeResult = (): ProviderResult => ({
    ...result("scribe", [["Η", 0, 0.4], ["επιτροπή", 0.5, 1.2], ["συνεδριάζει.", 1.3, 2.4]], SCRIBE_RESPONSE),
});

type Behaviour = { result?: ProviderResult; error?: Error; delayMs?: number; never?: boolean };

class StubProvider implements AsrProvider {
    calls = 0;
    constructor(readonly id: ProviderId, private readonly behaviour: Behaviour) { }

    async identify(): Promise<ProviderIdentity> {
        return identity(this.id);
    }

    async transcribe(_audio: AudioArtifact, ctx: ProviderContext): Promise<ProviderResult> {
        this.calls++;
        if (this.behaviour.never) {
            // Models a provider that ignores the shared signal entirely.
            return new Promise<ProviderResult>(() => { });
        }
        if (this.behaviour.delayMs) {
            await new Promise((resolve) => setTimeout(resolve, this.behaviour.delayMs));
        }
        if (this.behaviour.error) throw this.behaviour.error;
        void ctx;
        return this.behaviour.result!;
    }
}

const fusionOutput = (overrides: Partial<FusionOutput> = {}): FusionOutput => ({
    schema: "oc-fusion/1",
    audio_sha256: AUDIO.sha256,
    config: { arm: "rules", guard: true },
    tokens: [
        { i: 0, text: "Η", norm: "η", src: "scribe", src_word: 0, col: 0, island: null, stage: "agree", agreement: 1 },
        { i: 1, text: "επιτροπής", norm: "επιτροπης", src: "soniox", src_word: 1, col: 1, island: "isl_1", stage: "rule", agreement: 0.67, scribe_word: 1 },
        { i: 2, text: "συνεδριάζει.", norm: "συνεδριαζει", src: "scribe", src_word: 2, col: 2, island: null, stage: "agree", agreement: 1 },
    ],
    ...overrides,
});

let dir: string;
let cache: FusionCache;
let trace: TraceWriter;

beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "fusion-transcriber-test-"));
    cache = new FusionCache(path.join(dir, "cache"));
    trace = new TraceWriter(path.join(dir, "traces"));
    vi.spyOn(console, "log").mockImplementation(() => { });
    vi.spyOn(console, "warn").mockImplementation(() => { });
});

afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
});

function build(options: {
    providers: Partial<Record<ProviderId, Behaviour>>;
    env?: Record<string, string>;
    runFusion?: any;
    cacheOverride?: FusionCache;
}) {
    const providers = {
        scribe: new StubProvider("scribe", options.providers.scribe ?? { result: scribeResult() }),
        soniox: new StubProvider("soniox", options.providers.soniox ?? { result: result("soniox", [["Η", 0, 0.4], ["επιτροπής", 0.5, 1.2], ["συνεδριάζει", 1.3, 2.4]]) }),
        ours: new StubProvider("ours", options.providers.ours ?? { result: result("ours", [["Η", 0, 0.4], ["επιτροπή", 0.5, 1.2], ["συνεδριάζει", 1.3, 2.4]]) }),
    };
    const runFusion = options.runFusion ?? vi.fn(async () => ({ output: fusionOutput(), stderrTail: "", elapsedMs: 3 }));
    const transcriber = new FusionTranscriber({
        config: loadFusionConfig({ FUSION_MODE: "on", FUSION_DEADLINE_MS: "1000", ...options.env }, dir),
        providers: providers as unknown as ProviderSet,
        cache: options.cacheOverride ?? cache,
        trace,
        runFusion,
    });
    return { transcriber, providers, runFusion };
}

const pureScribeTranscript = () => scribeResponseToTranscript(SCRIBE_RESPONSE, 0.005, "");

describe("failure matrix", () => {
    it("three valid streams are fused", async () => {
        const { transcriber, runFusion } = build({ providers: {} });
        const outcome = await transcriber.fuseSegment({ audio: AUDIO, model: "fusion-rules" });

        expect(outcome.outcome).toBe("fused");
        expect(runFusion).toHaveBeenCalledTimes(1);
        expect(outcome.transcript.metadata.provider).toBe("fusion-rules");
        expect(outcome.transcript.transcription.full_transcript).toBe("Η επιτροπής συνεδριάζει.");
        expect(outcome.transcript.metadata.timingEstimatedRate).toBe(0);
    });

    it("sends the three systems to fuse.py in the contract's fixed order", async () => {
        const { transcriber, runFusion } = build({ providers: {} });
        await transcriber.fuseSegment({ audio: AUDIO, model: "fusion-rules" });
        const input = runFusion.mock.calls[0][0];
        expect(input.schema).toBe("oc-fusion-in/1");
        expect(input.systems.map((s: any) => s.id)).toEqual(["scribe", "soniox", "ours"]);
        expect(input.audio_sha256).toBe(AUDIO.sha256);
        expect(input.config).toEqual({ arm: "rules", guard: true, llm: null, chunking: PRODUCTION_CHUNKING });
    });

    it("sends the frozen chunking config, because Python's default is too slow", async () => {
        // Measured 2026-09-04 on a 2500-token-per-system segment, one fuse.py
        // call each: max_tokens 800 (Python's default when `chunking` is
        // omitted) takes 260.6 s, over the 60 s resource gate. 120 takes 20.1 s
        // and costs +0.00009 WER over unchunked on all 391 windows. If this
        // assertion is loosened, production silently runs the slow config.
        expect(PRODUCTION_CHUNKING).toEqual({ max_tokens: 120, anchor_n: 3, search_radius: 200 });

        const { transcriber, runFusion } = build({ providers: {} });
        await transcriber.fuseSegment({ audio: AUDIO, model: "fusion-rules" });
        expect(runFusion.mock.calls[0][0].config.chunking).toEqual(PRODUCTION_CHUNKING);
    });

    it("falls back to the exact Scribe transcript when an aux provider fails", async () => {
        const { transcriber, runFusion } = build({
            providers: { soniox: { error: new ProviderError("soniox", "boom", "http_500") } },
        });
        const outcome = await transcriber.fuseSegment({ audio: AUDIO, model: "fusion-rules" });

        expect(outcome.outcome).toBe("scribe-fallback");
        expect(outcome.fallbackReason).toBe("aux_soniox_http_500");
        expect(runFusion).not.toHaveBeenCalled();
        // Exact: the transcription is Scribe's own, not re-derived.
        expect(outcome.transcript.transcription).toEqual(pureScribeTranscript().transcription);
        expect(outcome.transcript.metadata.provider).toBe("scribe-fallback");
    });

    it("falls back rather than fusing two systems when an aux stream is empty", async () => {
        const { transcriber, runFusion } = build({ providers: { ours: { result: result("ours", []) } } });
        const outcome = await transcriber.fuseSegment({ audio: AUDIO, model: "fusion-rules" });
        expect(outcome.fallbackReason).toBe("aux_ours_empty");
        expect(runFusion).not.toHaveBeenCalled();
    });

    it("does not let a late aux result change a decision already made", async () => {
        const { transcriber, runFusion } = build({ providers: { ours: { never: true } } });
        const outcome = await transcriber.fuseSegment({ audio: AUDIO, model: "fusion-rules" });

        expect(outcome.outcome).toBe("scribe-fallback");
        expect(outcome.fallbackReason).toBe("aux_ours_deadline");
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(runFusion).not.toHaveBeenCalled();
        expect(outcome.transcript.transcription).toEqual(pureScribeTranscript().transcription);
    });

    it("fails the segment when Scribe fails, leaving the aux results cached", async () => {
        const providersFirst = build({
            providers: { scribe: { error: new ProviderError("scribe", "429", "http_429") } },
            cacheOverride: cache,
        });
        await expect(providersFirst.transcriber.fuseSegment({ audio: AUDIO, model: "fusion-rules" }))
            .rejects.toBeInstanceOf(ScribeUnavailableError);
        expect(providersFirst.providers.soniox.calls).toBe(1);

        // The retry re-pays Scribe only: the aux calls come from the cache.
        const retry = build({ providers: {}, cacheOverride: cache });
        const outcome = await retry.transcriber.fuseSegment({ audio: AUDIO, model: "fusion-rules" });
        expect(outcome.outcome).toBe("fused");
        expect(retry.providers.soniox.calls).toBe(0);
        expect(retry.providers.ours.calls).toBe(0);
        expect(retry.providers.scribe.calls).toBe(1);
    });

    it("fails the segment when Scribe returns text but no word stream", async () => {
        const broken = { ...scribeResult(), words: [] };
        const { transcriber } = build({ providers: { scribe: { result: broken } } });
        await expect(transcriber.fuseSegment({ audio: AUDIO, model: "fusion-rules" }))
            .rejects.toMatchObject({ reason: "scribe_no_word_stream" });
    });

    it("returns the exact empty result when Scribe genuinely heard nothing", async () => {
        const empty: ScribeResponse = { ...SCRIBE_RESPONSE, text: "", words: [] };
        const { transcriber, runFusion } = build({
            providers: { scribe: { result: { ...result("scribe", [], empty) } } },
        });
        const outcome = await transcriber.fuseSegment({ audio: AUDIO, model: "fusion-rules" });

        expect(outcome.outcome).toBe("scribe-only");
        expect(outcome.fallbackReason).toBe("scribe_empty");
        expect(outcome.transcript.transcription.utterances).toEqual([]);
        expect(runFusion).not.toHaveBeenCalled();
    });

    it("falls back to Scribe when fuse.py fails", async () => {
        const { transcriber } = build({
            providers: {},
            runFusion: vi.fn(async () => { throw new FusionEngineError("exit 1", "python_nonzero_exit"); }),
        });
        const outcome = await transcriber.fuseSegment({ audio: AUDIO, model: "fusion-rules" });
        expect(outcome).toMatchObject({ outcome: "scribe-fallback", fallbackReason: "python_nonzero_exit" });
        expect(outcome.transcript.transcription).toEqual(pureScribeTranscript().transcription);
    });

    it("falls back to Scribe when the timing invariant breaks", async () => {
        // Tokens out of column order produce an overlapping timeline.
        const { transcriber } = build({
            providers: {},
            runFusion: vi.fn(async () => ({
                output: fusionOutput({
                    tokens: [
                        { i: 0, text: "συνεδριάζει.", norm: "σ", src: "scribe", src_word: 2, col: 2, island: null, stage: "agree", agreement: 1 },
                        { i: 1, text: "Η", norm: "η", src: "scribe", src_word: 0, col: 0, island: null, stage: "agree", agreement: 1 },
                    ],
                }),
                stderrTail: "", elapsedMs: 1,
            })),
        });
        const outcome = await transcriber.fuseSegment({ audio: AUDIO, model: "fusion-rules" });
        expect(outcome).toMatchObject({ outcome: "scribe-fallback", fallbackReason: "timing_invariant" });
    });

    it("rejects a policy model while the LLM chooser is off", async () => {
        const { transcriber } = build({ providers: {}, env: { FUSION_LLM: "off" } });
        await expect(transcriber.fuseSegment({ audio: AUDIO, model: "fusion-policy-opus" }))
            .rejects.toMatchObject({ reason: "llm_disabled" });
    });

    it("reuses a Scribe result supplied by the caller instead of calling Scribe again", async () => {
        const { transcriber, providers } = build({ providers: {} });
        const outcome = await transcriber.fuseSegment({ audio: AUDIO, model: "fusion-rules", scribeResult: scribeResult() });
        expect(outcome.outcome).toBe("fused");
        expect(providers.scribe.calls).toBe(0);
    });

    it("writes a joinable trace with per-provider identity and no secrets", async () => {
        const { transcriber } = build({ providers: {} });
        const outcome = await transcriber.fuseSegment({ audio: AUDIO, model: "fusion-rules" });

        const files = await fsp.readdir(path.join(dir, "traces"));
        const file = files.find((name) => name.startsWith(AUDIO.sha256));
        expect(file).toBeDefined();
        const written = JSON.parse(await fsp.readFile(path.join(dir, "traces", file!), "utf8"));

        expect(written.requestId).toBe(outcome.requestId);
        expect(written.arm).toBe("rules");
        expect(written.outcome).toBe("fused");
        expect(written.components.map((c: any) => c.providerId).sort()).toEqual(["ours", "scribe", "soniox"]);
        expect(written.components.every((c: any) => c.paramsSha && c.rawSha256)).toBe(true);
        expect(JSON.stringify(written)).not.toMatch(/api[_-]?key/i);
    });

    it("keeps the segment alive when the trace cannot be written", async () => {
        // A regular file where a directory should be: mkdir fails with ENOTDIR.
        const blocked = path.join(dir, "not-a-directory");
        await fsp.writeFile(blocked, "");
        const failing = new TraceWriter(path.join(blocked, "traces"));
        const transcriber = new FusionTranscriber({
            config: loadFusionConfig({ FUSION_MODE: "shadow" }, dir),
            providers: {
                scribe: new StubProvider("scribe", { result: scribeResult() }),
                soniox: new StubProvider("soniox", { result: result("soniox", [["Η", 0, 0.4], ["επιτροπής", 0.5, 1.2], ["συνεδριάζει", 1.3, 2.4]]) }),
                ours: new StubProvider("ours", { result: result("ours", [["Η", 0, 0.4], ["επιτροπή", 0.5, 1.2], ["συνεδριάζει", 1.3, 2.4]]) }),
            } as unknown as ProviderSet,
            cache,
            trace: failing,
            runFusion: (async () => ({ output: fusionOutput(), stderrTail: "", elapsedMs: 1 })) as never,
        });

        const outcome = await transcriber.fuseSegment({ audio: AUDIO, model: "fusion-rules" });
        expect(outcome.outcome).toBe("fused");
    });
});

describe("component sharing across arms", () => {
    it("four arms over the same audio make one call per recogniser", async () => {
        const { transcriber, providers } = build({ providers: {} });
        await Promise.all([
            transcriber.fuseSegment({ audio: AUDIO, model: "fusion-rules" }),
            transcriber.fuseSegment({ audio: AUDIO, model: "fusion-rules" }),
            transcriber.fuseSegment({ audio: AUDIO, model: "scribe" }),
            transcriber.fuseSegment({ audio: AUDIO, model: "fusion-rules" }),
        ]);
        expect(providers.scribe.calls).toBe(1);
        expect(providers.soniox.calls).toBe(1);
        expect(providers.ours.calls).toBe(1);
    });
});
