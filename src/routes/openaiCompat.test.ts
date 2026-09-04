import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import http from "http";
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { createAuthMiddleware } from "../lib/auth.js";
import { createFusionRuntime, type FusionRuntime } from "../lib/fusion/index.js";
import { loadFusionConfig } from "../lib/fusion/config.js";
import { mountOpenAiCompatRoute } from "./openaiCompat.js";

/**
 * The bench-facing surface. Everything below the route is real: real Express,
 * real auth middleware, real multipart parsing, real orchestration, and — when
 * the Python package is present — the real fuse.py. Only the three recognisers
 * are replaced, by a replay bundle.
 */

// `../lib/auth.js` builds its middleware at module scope, so API_TOKENS must
// exist before that import is evaluated. vi.hoisted runs ahead of imports.
const TOKEN = vi.hoisted(() => {
    const t = "test-token";
    process.env.API_TOKENS = JSON.stringify([t]);
    return t;
});
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const HAS_PYTHON_FUSION = fs.existsSync(path.join(REPO_ROOT, "fusion", "fuse.py"));

const AUDIO_BYTES = Buffer.from("RIFFfake-greek-council-audio-for-tests");

let workDir: string;
let bundleDir: string;
let server: http.Server;
let baseUrl: string;
let audioSha: string;

function writeBundle(dir: string, sha: string) {
    fs.writeFileSync(path.join(dir, `${sha}.scribe.json`), JSON.stringify({
        identity: { model: "scribe_v2", paramsSha: "p1", schemaRev: "scribe-words/1" },
        raw: {
            language_code: "ell", language_probability: 0.99, audio_duration_secs: 3,
            text: "Η επιτροπή συνεδριάζει.",
            words: [
                { text: "Η", type: "word", start: 0, end: 0.4, logprob: -0.1 },
                { text: " ", type: "spacing", start: 0.4, end: 0.5 },
                { text: "επιτροπή", type: "word", start: 0.5, end: 1.2, logprob: -0.2 },
                { text: " ", type: "spacing", start: 1.2, end: 1.3 },
                { text: "συνεδριάζει.", type: "word", start: 1.3, end: 2.4, logprob: -0.3 },
            ],
        },
    }));
    fs.writeFileSync(path.join(dir, `${sha}.soniox.json`), JSON.stringify({
        identity: { model: "stt-async-v5", paramsSha: "p2", schemaRev: "soniox-tokens/1" },
        raw: {
            tokens: [
                { text: "Η", start_ms: 0, end_ms: 400, confidence: 0.9 },
                { text: " επιτροπή", start_ms: 500, end_ms: 1200, confidence: 0.6 },
                { text: " συνεδριάζει.", start_ms: 1300, end_ms: 2400, confidence: 0.7 },
            ],
        },
    }));
    fs.writeFileSync(path.join(dir, `${sha}.ours.json`), JSON.stringify({
        identity: { model: "ct2-cleanpack-cont-s47", paramsSha: "p3", schemaRev: "ocasr-words/1" },
        raw: {
            words: [
                { word: "Η", start: 0, end: 0.4, prob: 0.95 },
                { word: "επιτροπή", start: 0.5, end: 1.2, prob: 0.88 },
                { word: "συνεδριάζει.", start: 1.3, end: 2.4, prob: 0.9 },
            ],
        },
    }));
}

function makeRuntime(env: Record<string, string> = {}): FusionRuntime {
    return createFusionRuntime(loadFusionConfig({
        FUSION_MODE: "on",
        FUSION_OPENAI_ROUTE: "on",
        FUSION_REPLAY_DIR: bundleDir,
        FUSION_CACHE_DIR: path.join(workDir, "cache"),
        FUSION_TRACE_DIR: path.join(workDir, "traces"),
        FUSION_DEADLINE_MS: "20000",
        ...env,
    }, REPO_ROOT));
}

async function listen(app: express.Express): Promise<{ server: http.Server; url: string }> {
    const created = http.createServer(app);
    await new Promise<void>((resolve) => created.listen(0, "127.0.0.1", resolve));
    const address = created.address() as { port: number };
    return { server: created, url: `http://127.0.0.1:${address.port}` };
}

function buildApp(rt: FusionRuntime): express.Express {
    const app = express();
    app.use(createAuthMiddleware({ skipAuth: false, publicPaths: [], tokens: [TOKEN], additionalPublicPaths: [] }));
    mountOpenAiCompatRoute(app, rt);
    return app;
}

async function post(url: string, fields: Record<string, string>, options: { token?: string | null; file?: boolean } = {}) {
    const form = new FormData();
    if (options.file !== false) {
        form.append("file", new Blob([AUDIO_BYTES], { type: "audio/mpeg" }), "segment.mp3");
    }
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    return fetch(url, {
        method: "POST",
        headers: options.token === null ? {} : { Authorization: `Bearer ${options.token ?? TOKEN}` },
        body: form,
    });
}

beforeAll(async () => {
    workDir = await fsp.mkdtemp(path.join(os.tmpdir(), "fusion-route-test-"));
    bundleDir = path.join(workDir, "bundle");
    fs.mkdirSync(bundleDir, { recursive: true });

    const { createHash } = await import("crypto");
    audioSha = createHash("sha256").update(AUDIO_BYTES).digest("hex");
    writeBundle(bundleDir, audioSha);

    const listening = await listen(buildApp(makeRuntime()));
    server = listening.server;
    baseUrl = listening.url;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fsp.rm(workDir, { recursive: true, force: true });
});

beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => { });
    vi.spyOn(console, "warn").mockImplementation(() => { });
});

afterEach(() => vi.restoreAllMocks());

describe("POST /v1/audio/transcriptions", () => {
    it("is not mounted unless FUSION_OPENAI_ROUTE=on", async () => {
        const rt = makeRuntime({ FUSION_OPENAI_ROUTE: "off" });
        expect(mountOpenAiCompatRoute(express(), rt)).toBe(false);

        const { server: off, url } = await listen(buildApp(rt));
        const response = await post(`${url}/v1/audio/transcriptions`, { model: "scribe" });
        expect(response.status).toBe(404);
        await new Promise<void>((resolve) => off.close(() => resolve()));
    });

    it("requires a bearer token", async () => {
        const missing = await post(`${baseUrl}/v1/audio/transcriptions`, { model: "scribe" }, { token: null });
        expect(missing.status).toBe(401);
        const wrong = await post(`${baseUrl}/v1/audio/transcriptions`, { model: "scribe" }, { token: "nope" });
        expect(wrong.status).toBe(403);
    });

    it("rejects an unknown model", async () => {
        const response = await post(`${baseUrl}/v1/audio/transcriptions`, { model: "whisper-1" });
        expect(response.status).toBe(400);
        expect((await response.json() as any).error.param).toBe("model");
    });

    it("rejects the policy models with a stable error while FUSION_LLM=off", async () => {
        for (const model of ["fusion-policy-opus", "fusion-policy-sonnet"]) {
            const response = await post(`${baseUrl}/v1/audio/transcriptions`, { model });
            expect(response.status).toBe(400);
            expect((await response.json() as any).error.type).toBe("model_disabled");
        }
    });

    it("rejects a non-Greek language and an unsupported response_format", async () => {
        const language = await post(`${baseUrl}/v1/audio/transcriptions`, { model: "scribe", language: "en" });
        expect(language.status).toBe(400);
        expect((await language.json() as any).error.param).toBe("language");

        const format = await post(`${baseUrl}/v1/audio/transcriptions`, { model: "scribe", response_format: "srt" });
        expect(format.status).toBe(400);
        expect((await format.json() as any).error.param).toBe("response_format");
    });

    it("rejects a request with no file", async () => {
        const response = await post(`${baseUrl}/v1/audio/transcriptions`, { model: "scribe" }, { file: false });
        expect(response.status).toBe(400);
    });

    it("returns the cached Scribe hypothesis for model=scribe, with joinable headers", async () => {
        const response = await post(`${baseUrl}/v1/audio/transcriptions`, { model: "scribe", language: "el" });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ text: "Η επιτροπή συνεδριάζει." });
        expect(response.headers.get("x-oc-audio-sha256")).toBe(audioSha);
        expect(response.headers.get("x-oc-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("gives every request its own request id", async () => {
        const [a, b] = await Promise.all([
            post(`${baseUrl}/v1/audio/transcriptions`, { model: "scribe" }),
            post(`${baseUrl}/v1/audio/transcriptions`, { model: "scribe" }),
        ]);
        expect(a.headers.get("x-oc-request-id")).not.toBe(b.headers.get("x-oc-request-id"));
        expect(a.headers.get("x-oc-audio-sha256")).toBe(b.headers.get("x-oc-audio-sha256"));
    });

    it("leaves no upload behind", async () => {
        const before = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("oc-fusion-upload-"));
        await post(`${baseUrl}/v1/audio/transcriptions`, { model: "scribe" });
        const after = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("oc-fusion-upload-"));
        expect(after.length).toBeLessThanOrEqual(before.length);
    });
});

describe.skipIf(!HAS_PYTHON_FUSION)("multipart end to end, through the real fuse.py", () => {
    it("fuses a replayed segment and returns text", async () => {
        const response = await post(`${baseUrl}/v1/audio/transcriptions`, { model: "fusion-rules", language: "el" });
        const body = await response.json() as any;

        if (response.status !== 200) {
            throw new Error(`fusion-rules returned ${response.status}: ${JSON.stringify(body)}`);
        }
        expect(typeof body.text).toBe("string");
        expect(body.text.length).toBeGreaterThan(0);
    }, 30_000);
});

if (!HAS_PYTHON_FUSION) {
    // Not a silent skip: the gate that matters is "real Express + real Python",
    // and a run without fusion/fuse.py has not tested it.
    console.warn("[fusion] fusion/fuse.py is absent — the end-to-end fusion test was skipped");
}
