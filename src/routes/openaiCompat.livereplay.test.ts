import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import http from "http";
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { fetch as undiciFetch, Agent } from "undici";
import { createAuthMiddleware } from "../lib/auth.js";
import { createFusionRuntime, type FusionRuntime } from "../lib/fusion/index.js";
import { loadFusionConfig } from "../lib/fusion/config.js";
import { mountOpenAiCompatRoute } from "./openaiCompat.js";

/**
 * How often does the live path actually fuse?
 *
 * The live test proves the route works on one window and costs three vendor
 * calls to say so. That is the wrong instrument for the question the first live
 * run raised: attempt one fell back with `timing_invariant`, attempt two fused.
 * A one-in-two fallback rate and a one-in-fifty fallback rate are different
 * products, and neither is visible from a single call.
 *
 * So: every recorded live response is replayed through the real route, offline
 * and free, and the outcome of each is counted. These are REAL vendor responses
 * with real word timings -- the 391-window gate replays benchmark fixtures,
 * whose token streams were never subject to the timing path at all.
 *
 * Build the bundle with eval/live_fusion/build_replay_bundle.py in the research
 * repo. It holds transcript text; nothing derived from it is printed here.
 *
 * Run: npm run test:fusion-live-replay
 */

const TOKEN = vi.hoisted(() => {
    const t = "livereplay-token";
    process.env.API_TOKENS = JSON.stringify([t]);
    return t;
});

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const BUNDLE = process.env.LIVE_REPLAY_DIR?.trim()
    // The GPU bundle by default: its `ours` entries are the endpoint's own
    // response, so the route runs its real normalizer over them. The local-stack
    // recordings were already normalized by the research harness and would test
    // the harness instead.
    || path.join(os.homedir(), ".cache", "oc-public", "live-replay-2026-09-gpu");
const AUDIO_DIR = process.env.LIVE_AUDIO_DIR?.trim()
    || path.join(os.homedir(), ".cache", "oc-public", "bench_windows");

/**
 * The route must never see a fallback rate this high without someone deciding
 * it is acceptable. Frozen here before the first run, so the number is a finding
 * rather than whatever came out.
 */
const MAX_FALLBACK_RATE = 0.05;

const patient = new Agent({ headersTimeout: 900_000, bodyTimeout: 900_000 });

interface Index { stack: string; n_windows: number; windows: Record<string, string>; }
interface TraceShape {
    outcome: string;
    fallbackReason?: string;
    fallbackDetail?: string;
    components: { providerId: string; wordCount: number; error?: string }[];
}

function loadIndex(): Index {
    const file = path.join(BUNDLE, "INDEX.json");
    if (!fs.existsSync(file)) {
        throw new Error(`[live replay] no bundle at ${BUNDLE}. Build it with `
            + "eval/live_fusion/build_replay_bundle.py in the research repo. This test must "
            + "not be skipped: a green skip here is a fallback rate nobody measured.");
    }
    return JSON.parse(fs.readFileSync(file, "utf8")) as Index;
}

describe("live replay: every recorded live window through the real route", () => {
    let workDir: string;
    let server: http.Server;
    let baseUrl: string;
    let rt: FusionRuntime;
    let index: Index;

    beforeAll(async () => {
        index = loadIndex();
        workDir = await fsp.mkdtemp(path.join(os.tmpdir(), "fusion-livereplay-"));
        await fsp.chmod(workDir, 0o700);
        rt = createFusionRuntime(loadFusionConfig({
            FUSION_MODE: "on",
            FUSION_OPENAI_ROUTE: "on",
            FUSION_REPLAY_DIR: BUNDLE,
            FUSION_CACHE_DIR: path.join(workDir, "cache"),
            FUSION_TRACE_DIR: path.join(workDir, "traces"),
            FUSION_DEADLINE_MS: "600000",
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

    it("fuses real vendor output, and any fallback is named", async () => {
        const traceDir = path.join(workDir, "traces");
        const outcomes: Record<string, number> = {};
        const fallbacks: { id: string; reason: string; detail: string }[] = [];

        for (const [windowId, audioSha] of Object.entries(index.windows)) {
            const wav = path.join(AUDIO_DIR, `${windowId}.wav`);
            if (!fs.existsSync(wav)) continue;
            const form = new FormData();
            form.append("file", new Blob([await fsp.readFile(wav)], { type: "audio/wav" }), `${windowId}.wav`);
            form.append("model", "fusion-rules");
            form.append("language", "el");
            const response = await undiciFetch(`${baseUrl}/v1/audio/transcriptions`, {
                method: "POST", headers: { Authorization: `Bearer ${TOKEN}` },
                body: form as unknown as undefined, dispatcher: patient,
            });
            expect(response.status, `${windowId} returned ${response.status}`).toBe(200);
            expect(response.headers.get("x-oc-audio-sha256")).toBe(audioSha);
            const requestId = response.headers.get("x-oc-request-id")!;
            await response.json();

            const traceFile = fs.readdirSync(traceDir).find((n) => n.endsWith(`.${requestId}.json`));
            const trace = JSON.parse(fs.readFileSync(path.join(traceDir, traceFile!), "utf8")) as TraceShape;
            outcomes[trace.outcome] = (outcomes[trace.outcome] ?? 0) + 1;
            if (trace.outcome !== "fused") {
                fallbacks.push({
                    id: windowId,
                    reason: trace.fallbackReason ?? "-",
                    // The detail names a word index and two times. It carries no text.
                    detail: (trace.fallbackDetail ?? "-").slice(0, 200),
                });
            }
        }

        const total = Object.values(outcomes).reduce((a, b) => a + b, 0);
        const fused = outcomes.fused ?? 0;
        const rate = total === 0 ? 1 : (total - fused) / total;
        console.info(`[live replay] stack=${index.stack} ${fused}/${total} fused, `
            + `fallback rate ${(rate * 100).toFixed(1)}% ${JSON.stringify(outcomes)}`);
        for (const fallback of fallbacks) {
            console.info(`[live replay] ${fallback.id}: ${fallback.reason} — ${fallback.detail}`);
        }

        expect(total, "the bundle produced no requests").toBeGreaterThan(0);
        expect(rate, `fallbacks: ${JSON.stringify(fallbacks)}`).toBeLessThanOrEqual(MAX_FALLBACK_RATE);
    }, 1_800_000);
});
