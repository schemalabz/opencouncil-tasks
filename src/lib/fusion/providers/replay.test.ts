import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { ReplayProvider } from "./replay.js";
import { ReplayMissError, type AudioArtifact, type ProviderContext } from "../types.js";

const SHA = "a".repeat(64);
const MISSING_SHA = "b".repeat(64);
const FAILING_SHA = "c".repeat(64);

let bundle: string;

const audio = (sha256: string): AudioArtifact => ({ sha256, sizeBytes: 10, mime: "audio/mpeg", canonicalUrl: "https://example/a.mp3" });
const ctx = (deadlineMs = 200): ProviderContext => ({ signal: new AbortController().signal, deadlineAt: Date.now() + deadlineMs });

beforeAll(async () => {
    bundle = await fsp.mkdtemp(path.join(os.tmpdir(), "fusion-replay-"));

    const scribeRaw = {
        language_code: "ell",
        language_probability: 1,
        text: "Η επιτροπή.",
        words: [
            { text: "Η", type: "word", start: 0.1, end: 0.2, logprob: -0.1 },
            { text: " ", type: "spacing", start: 0.2, end: 0.21 },
            { text: "επιτροπή.", type: "word", start: 0.3, end: 0.9, logprob: -0.2 },
        ],
    };
    for (const sha of [SHA, FAILING_SHA]) {
        fs.writeFileSync(path.join(bundle, `${sha}.scribe.json`), JSON.stringify({
            identity: { model: "scribe_v2", paramsSha: "p1", schemaRev: "scribe-words/1" },
            raw: scribeRaw,
        }));
        fs.writeFileSync(path.join(bundle, `${sha}.soniox.json`), JSON.stringify({
            identity: { model: "stt-async-v5", paramsSha: "p2", schemaRev: "soniox-tokens/1" },
            raw: { tokens: [{ text: "Η", start_ms: 100, end_ms: 200, confidence: 0.9 }, { text: " επιτροπή.", start_ms: 300, end_ms: 900, confidence: 0.5 }] },
        }));
    }
    fs.writeFileSync(path.join(bundle, "schedule.json"), JSON.stringify({
        delaysMs: 0,
        failures: {
            [`${FAILING_SHA}.scribe`]: "http500",
            [`${FAILING_SHA}.soniox`]: "malformed",
        },
    }));
});

afterAll(async () => {
    await fsp.rm(bundle, { recursive: true, force: true });
});

describe("ReplayProvider", () => {
    it("serves a recorded response by audio sha, through the live normalizer", async () => {
        const result = await new ReplayProvider("scribe", bundle).transcribe(audio(SHA), ctx());
        expect(result.providerId).toBe("scribe");
        expect(result.identity.paramsSha).toBe("p1");
        // spacing tokens are dropped by the real Scribe normalizer, not by replay
        expect(result.words.map((w) => w.raw)).toEqual(["Η", "επιτροπή."]);
    });

    it("groups Soniox sub-word tokens into words", async () => {
        const result = await new ReplayProvider("soniox", bundle).transcribe(audio(SHA), ctx());
        expect(result.words.map((w) => w.raw)).toEqual(["Η", "επιτροπή."]);
        expect(result.words[1].start).toBeCloseTo(0.3);
    });

    it("hard-fails on a miss rather than falling through to a live provider", async () => {
        await expect(new ReplayProvider("scribe", bundle).transcribe(audio(MISSING_SHA), ctx()))
            .rejects.toBeInstanceOf(ReplayMissError);
    });

    it("produces the scheduled http500 failure deterministically", async () => {
        const provider = new ReplayProvider("scribe", bundle);
        for (let i = 0; i < 3; i++) {
            await expect(provider.transcribe(audio(FAILING_SHA), ctx())).rejects.toMatchObject({ reason: "http_500" });
        }
    });

    it("produces the scheduled malformed response — text present, word stream gone", async () => {
        const result = await new ReplayProvider("soniox", bundle).transcribe(audio(FAILING_SHA), ctx());
        expect(result.words).toEqual([]);
    });

    it("produces the scheduled timeout by burning the shared deadline", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-replay-timeout-"));
        fs.copyFileSync(path.join(bundle, `${SHA}.scribe.json`), path.join(dir, `${SHA}.scribe.json`));
        fs.writeFileSync(path.join(dir, "schedule.json"), JSON.stringify({ failures: { [SHA]: "timeout" } }));

        const started = Date.now();
        await expect(new ReplayProvider("scribe", dir).transcribe(audio(SHA), ctx(60)))
            .rejects.toMatchObject({ reason: "deadline" });
        expect(Date.now() - started).toBeGreaterThanOrEqual(40);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("exposes the recorded identity before the call, for the cache key", async () => {
        const identity = await new ReplayProvider("soniox", bundle).identify(audio(SHA));
        expect(identity).toEqual({ model: "stt-async-v5", paramsSha: "p2", schemaRev: "soniox-tokens/1" });
    });
});

describe("replay never reaches the network", () => {
    it("has no fetch on its path", async () => {
        const original = globalThis.fetch;
        globalThis.fetch = (() => { throw new Error("replay must not use the network"); }) as never;
        try {
            const result = await new ReplayProvider("scribe", bundle).transcribe(audio(SHA), ctx());
            expect(result.words.length).toBe(2);
        } finally {
            globalThis.fetch = original;
        }
    });
});
