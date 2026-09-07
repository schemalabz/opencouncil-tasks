import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import http from "http";
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { createAuthMiddleware } from "../lib/auth.js";
import { createFusionRuntime, artifactFromFile, type FusionRuntime } from "../lib/fusion/index.js";
import { loadFusionConfig } from "../lib/fusion/config.js";
import { fetch as undiciFetch, Agent } from "undici";
import { mountOpenAiCompatRoute } from "./openaiCompat.js";

/**
 * Node's default fetch gives up waiting for response headers after ~5 minutes.
 * A cold RunPod worker plus two cloud vendors on a 140-second window is longer
 * than that, so the FIRST live run failed as "fetch failed / HeadersTimeout"
 * while the route was still working. Any real caller of this route -- a
 * benchmark runner, a proxy, a load balancer -- needs the same treatment.
 */
const patientAgent = new Agent({ headersTimeout: 900_000, bodyTimeout: 900_000 });

/**
 * The live proof. Everything else about this route has been established with
 * fake providers: 391 windows replayed, byte-exact against fuse.py. What no
 * replay can establish is that the three vendors are actually reachable with the
 * request we send them — and that is exactly where the defects were.
 *
 * This run found one that nothing else could: `ocasr.ts` sent RunPod a field
 * called `url`, and the endpoint answers "input needs either 'audioUrl' or
 * 'audioBase64'". A fake provider never reaches RunPod, so the gate was green
 * while the live path could not have worked.
 *
 * It is not in the default suite. It spends money (Scribe, Soniox and GPU
 * seconds), it needs three credentials, and it needs real audio on disk.
 * Run: FUSION_LIVE=1 npm run test:fusion-live
 *
 * The audio is the cached benchmark windows, which are council speech: nothing
 * derived from them is ever printed. Assertions are on counts, ids and hashes.
 */

const TOKEN = vi.hoisted(() => {
    const t = "live-token";
    process.env.API_TOKENS = JSON.stringify([t]);
    return t;
});

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const AUDIO_DIR = process.env.LIVE_AUDIO_DIR?.trim()
    || path.join(os.homedir(), ".cache", "oc-public", "bench_windows");
const ENABLED = process.env.FUSION_LIVE === "1";

interface TraceComponentShape {
    providerId: string;
    wordCount: number;
    cacheHit: boolean;
    error?: string;
    model?: string;
    paramsSha?: string;
    elapsedMs?: number;
}
interface TraceShape {
    outcome: string;
    arm?: string;
    fallbackReason?: string;
    fallbackDetail?: string;
    audioSha256: string;
    components: TraceComponentShape[];
}

function pickWindow(): string {
    if (!fs.existsSync(AUDIO_DIR)) {
        throw new Error(`no audio at ${AUDIO_DIR}; set LIVE_AUDIO_DIR`);
    }
    const wavs = fs.readdirSync(AUDIO_DIR).filter((n) => n.endsWith(".wav")).sort();
    if (wavs.length === 0) throw new Error(`no .wav files in ${AUDIO_DIR}`);
    // Deterministic: the first by name, so two runs discuss the same window.
    return path.join(AUDIO_DIR, wavs[0]);
}

describe.skipIf(!ENABLED)("live route: three real providers through POST /v1/audio/transcriptions", () => {
    let workDir: string;
    let server: http.Server;
    let baseUrl: string;
    let rt: FusionRuntime;

    beforeAll(async () => {
        for (const key of ["SCRIBE_API_KEY", "SONIOX_API_KEY", "RUNPOD_API_KEY", "OC_ASR_ENDPOINT_ID"]) {
            if (!process.env[key]) throw new Error(`${key} is not set; the live test cannot run`);
        }
        workDir = await fsp.mkdtemp(path.join(os.tmpdir(), "fusion-live-"));
        await fsp.chmod(workDir, 0o700);
        rt = createFusionRuntime(loadFusionConfig({
            FUSION_MODE: "on",
            FUSION_OPENAI_ROUTE: "on",
            // No bucket on this machine: the bytes transport is the whole point.
            FUSION_AUDIO_TRANSPORT: "bytes",
            // A persistent cache dir lets a failed run be re-run without paying
            // the three vendors again. The cold-cache assertion below is skipped
            // when it is set, so the recorded proof is always a cold run.
            FUSION_CACHE_DIR: process.env.LIVE_CACHE_DIR?.trim() || path.join(workDir, "cache"),
            FUSION_TRACE_DIR: path.join(workDir, "traces"),
            FUSION_DEADLINE_MS: "900000",
        }, REPO_ROOT));
        const app = express();
        app.use(createAuthMiddleware({ skipAuth: false, publicPaths: [], tokens: [TOKEN], additionalPublicPaths: [] }));
        mountOpenAiCompatRoute(app, rt);
        server = http.createServer(app);
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const { port } = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${port}`;
    }, 120_000);

    afterAll(async () => {
        if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
        if (workDir) await fsp.rm(workDir, { recursive: true, force: true });
    });

    it("fuses one real window from three live vendors, on a cold cache", async () => {
        const wav = pickWindow();
        const audio = await fsp.readFile(wav);
        const artifact = await artifactFromFile(wav);

        const form = new FormData();
        form.append("file", new Blob([audio], { type: "audio/wav" }), path.basename(wav));
        form.append("model", "fusion-rules");
        form.append("language", "el");
        const response = await undiciFetch(`${baseUrl}/v1/audio/transcriptions`, {
            method: "POST", headers: { Authorization: `Bearer ${TOKEN}` },
            body: form as unknown as undefined, dispatcher: patientAgent,
        });

        expect(response.status).toBe(200);
        expect(response.headers.get("x-oc-audio-sha256")).toBe(artifact.sha256);
        const requestId = response.headers.get("x-oc-request-id");
        expect(requestId).toBeTruthy();

        const body = await response.json() as { text?: unknown };
        expect(typeof body.text).toBe("string");
        expect((body.text as string).length).toBeGreaterThan(0);

        const traceDir = path.join(workDir, "traces");
        const traceFile = fs.readdirSync(traceDir).find((n) => n.endsWith(`.${requestId}.json`));
        expect(traceFile, "no trace was written").toBeTruthy();
        const trace = JSON.parse(fs.readFileSync(path.join(traceDir, traceFile!), "utf8")) as TraceShape;

        // Fusion actually happened. A Scribe fallback also returns 200 with
        // plausible text, so this is the assertion that separates "the route
        // works" from "the route quietly gave up and returned one provider".
        expect(trace.outcome,
            `fallback: ${trace.fallbackReason ?? "-"}: ${trace.fallbackDetail ?? "-"}`).toBe("fused");
        expect(trace.arm).toBe("rules");

        const ids = trace.components.map((c) => c.providerId).sort();
        expect(ids).toEqual(["ours", "scribe", "soniox"]);
        for (const component of trace.components) {
            expect(component.error, `${component.providerId} errored`).toBeFalsy();
            expect(component.wordCount, `${component.providerId} returned no words`).toBeGreaterThan(0);
            if (!process.env.LIVE_CACHE_DIR) {
                expect(component.cacheHit, `${component.providerId} was cached; this run must be cold`).toBe(false);
            }
        }

        console.info(`[live] ${path.basename(wav)} fused: `
            + trace.components.map((c) => `${c.providerId} ${c.wordCount}w/${c.elapsedMs}ms`).join(" "));
    }, 900_000);

    it("refuses an oversized segment on the byte transport instead of transcoding it", async () => {
        const { OCASR_MAX_INLINE_BODY_BYTES } = await import("../lib/fusion/providers/ocasr.js");
        const { OcAsrProvider } = await import("../lib/fusion/providers/ocasr.js");
        const provider = new OcAsrProvider();
        const oversized = {
            path: "/nonexistent.wav",
            sha256: "0".repeat(64),
            // Just over the admission limit once base64 is accounted for.
            sizeBytes: Math.ceil(OCASR_MAX_INLINE_BODY_BYTES / 4) * 3 + 1024,
            mime: "audio/wav",
        };
        const ctx = { signal: new AbortController().signal, deadlineAt: Date.now() + 10_000, transport: "bytes" as const };
        await expect(provider.transcribe(oversized, ctx)).rejects.toMatchObject({
            reason: "inline_payload_too_large",
        });
    });
});
