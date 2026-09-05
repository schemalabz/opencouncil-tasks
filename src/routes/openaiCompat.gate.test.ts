import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import http from "http";
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { createAuthMiddleware } from "../lib/auth.js";
import { createFusionRuntime, FusionTranscriber, artifactFromFile, type FusionRuntime } from "../lib/fusion/index.js";
import { loadFusionConfig } from "../lib/fusion/config.js";
import { createProviders } from "../lib/fusion/providers/index.js";
import { PRODUCTION_CHUNKING } from "../lib/fusion/FusionTranscriber.js";
import { runFusionPython } from "../lib/fusion/fusePy.js";
import type { FusionInput } from "../lib/fusion/types.js";
import { mountOpenAiCompatRoute } from "./openaiCompat.js";

/**
 * The benchmark-shaped integration gate (spec §7 risk 2, required by Codex
 * review f784ace4).
 *
 * The offline benchmark scored the fusion at [5036,1848,5519,110694] = 0.11205
 * over 391 windows. Nothing so far proves that the *production* path — HTTP
 * multipart in, providers, fuse.py, transcript assembly, `full_transcript` out —
 * produces that same text. This replays all 391 windows through the real route
 * with fake providers and checks it.
 *
 * It checks TWO claims, and the first version of this gate wrongly merged them:
 * production runs `max_tokens=120` while the frozen totals were measured
 * unchunked, so "identical to the fixture" is the wrong bar. The integration
 * claim is exact equality with what fuse.py produces for the same config, and
 * the chunking cost is a separate, pre-declared budget. `route_gate_score.py`
 * adjudicates; this file only drives and records.
 *
 * Four rules, each of which exists because the obvious version of this gate
 * would pass while production was broken:
 *
 *  1. It FAILS when the fixture bundle is missing. This file never runs in the
 *     default suite, so a green "skipped" here would be a required check that
 *     executed zero benchmark requests.
 *  2. The primary assertion is exact string comparison, not WER. WER tolerates
 *     casing, punctuation and whitespace drift; the one-raw-word-to-many-tokens
 *     duplication defect was invisible to every aggregate number.
 *  3. Every response's trace must show a clean three-provider fused run on a
 *     cold cache. Otherwise an aux-provider replay miss becomes a Scribe
 *     fallback that happens to score well, and the gate calls it a pass.
 *  4. Nothing derived from the bundle is ever printed. Mismatches are reported
 *     as window id + token-list hash. The bundle is verbatim council speech.
 *
 * Run: npm run test:fusion-route-gate
 */

const execFileAsync = promisify(execFile);

// `../lib/auth.js` builds its middleware at module scope, so API_TOKENS must
// exist before that import is evaluated. vi.hoisted runs ahead of imports.
const TOKEN = vi.hoisted(() => {
    const t = "gate-token";
    process.env.API_TOKENS = JSON.stringify([t]);
    return t;
});

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const COMMITTED_MANIFEST = path.join(REPO_ROOT, "tests", "fusion", "fixtures", "MANIFEST.json");
const SCORER = path.join(REPO_ROOT, "tests", "fusion", "route_gate_score.py");
const PYTHON = process.env.FUSION_PYTHON_BIN?.trim() || "python3";

/** Fixture `trio` names, in the fixed contract order, mapped to provider ids. */
const TRIO = ["scribe", "soniox", "oc-cleanpack-cont-s47-b"] as const;
const PROVIDER_ORDER = ["scribe", "soniox", "ours"] as const;

interface Window { id: string; hyps: string[][]; ref: string[]; }
interface Expected { id: string; tokens: string[]; sidn: number[]; }
interface Manifest {
    n_windows: number;
    totals: Record<string, number[]>;
    fixtures: Record<string, { sha256: string; bytes: number }>;
}

interface Bundle {
    dir: string;
    manifest: Manifest;
    windows: Window[];
    expected: Map<string, Expected>;
}

/* ------------------------------------------------------------------ */
/* Preflight: the bundle is trusted only after it matches what git pins */
/* ------------------------------------------------------------------ */

function sha256File(file: string): string {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function fail(message: string): never {
    throw new Error(
        `[fusion route gate] ${message}\n`
        + "This gate scores the frozen 391-window benchmark through the production route. "
        + "The bundle holds transcript text and is never committed; regenerate it with "
        + "eval/controlled_eval/chooser/make_fixtures.py in the research repo, or point "
        + "FUSION_FIXTURES_DIR at an existing copy. It must not be skipped.",
    );
}

/**
 * Reading totals out of the bundle's own MANIFEST would let an altered bundle
 * bless itself. The committed copy is the trust anchor: it carries no transcript
 * text, only hashes and counts, and it is the acceptance contract.
 */
function loadBundle(): Bundle {
    const dir = process.env.FUSION_FIXTURES_DIR?.trim()
        || path.join(os.homedir(), ".cache", "oc-public", "chooser-2026-08-25");
    if (!fs.existsSync(dir)) fail(`fixture bundle directory not found: ${dir}`);

    const pinned = JSON.parse(fs.readFileSync(COMMITTED_MANIFEST, "utf8")) as Manifest;
    const localManifestPath = path.join(dir, "MANIFEST.json");
    if (!fs.existsSync(localManifestPath)) fail(`no MANIFEST.json in ${dir}`);
    const local = JSON.parse(fs.readFileSync(localManifestPath, "utf8")) as Manifest;

    if (JSON.stringify(local) !== JSON.stringify(pinned)) {
        fail(`MANIFEST.json in ${dir} differs from the committed ${path.relative(REPO_ROOT, COMMITTED_MANIFEST)}`);
    }
    for (const [name, entry] of Object.entries(pinned.fixtures)) {
        const file = path.join(dir, name);
        if (!fs.existsSync(file)) fail(`missing fixture ${name} in ${dir}`);
        const actual = sha256File(file);
        if (actual !== entry.sha256) fail(`${name} sha256 ${actual.slice(0, 12)} != pinned ${entry.sha256.slice(0, 12)}`);
    }

    const inputs = JSON.parse(fs.readFileSync(path.join(dir, "fixture_inputs_391.json"), "utf8"));
    const rulesOn = JSON.parse(fs.readFileSync(path.join(dir, "fixture_rules_on_391.json"), "utf8"));

    if (JSON.stringify(inputs.trio) !== JSON.stringify(TRIO)) {
        fail(`fixture trio is ${JSON.stringify(inputs.trio)}, expected ${JSON.stringify(TRIO)} — `
            + "hypothesis order is part of the contract and must not be inferred");
    }

    const windows: Window[] = inputs.windows;
    const expected = new Map<string, Expected>(rulesOn.windows.map((w: Expected) => [w.id, w]));

    if (windows.length !== pinned.n_windows) fail(`bundle has ${windows.length} windows, pinned ${pinned.n_windows}`);
    if (expected.size !== pinned.n_windows) fail(`rules_on has ${expected.size} windows, pinned ${pinned.n_windows}`);
    if (new Set(windows.map((w) => w.id)).size !== windows.length) fail("window ids are not unique");
    for (const w of windows) {
        if (!expected.has(w.id)) fail(`window ${w.id} has no rules_on expectation`);
        if (w.hyps?.length !== 3) fail(`window ${w.id} does not have exactly three hypotheses`);
        if (!Array.isArray(w.ref) || w.ref.length === 0) fail(`window ${w.id} has no reference`);
    }
    return { dir, manifest: pinned, windows, expected };
}

/* ------------------------------------------------------------------ */
/* Replay bundle synthesis                                             */
/* ------------------------------------------------------------------ */

/** Synthetic times, matching tests/fusion/helpers.py `as_words`. */
const startOf = (i: number) => i * 0.5;
const endOf = (i: number) => i * 0.5 + 0.4;

function audioFor(id: string): Buffer {
    // Deterministic and unique per window: the audio sha is the replay key and
    // the component cache key, so a collision would silently reuse a result.
    return Buffer.from(`RIFF-oc-fusion-gate-${id}`, "utf8");
}

const sha256Buf = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

function scribeRaw(tokens: string[]) {
    return {
        language_code: "ell",
        language_probability: 0.99,
        audio_duration_secs: endOf(Math.max(0, tokens.length - 1)),
        text: tokens.join(" "),
        words: tokens.map((t, i) => ({ text: t, type: "word", start: startOf(i), end: endOf(i), logprob: -0.1 })),
    };
}

function sonioxRaw(tokens: string[]) {
    // Leading space = word boundary, which is how Soniox actually emits them.
    return {
        tokens: tokens.map((t, i) => ({
            text: i === 0 ? t : ` ${t}`,
            start_ms: Math.round(startOf(i) * 1000),
            end_ms: Math.round(endOf(i) * 1000),
            confidence: 0.9,
        })),
    };
}

function oursRaw(tokens: string[]) {
    return { words: tokens.map((t, i) => ({ word: t, start: startOf(i), end: endOf(i), prob: 0.9 })) };
}

const IDENTITY = {
    scribe: { model: "scribe_v2", paramsSha: "gate-scribe", schemaRev: "scribe-words/1" },
    soniox: { model: "stt-async-v5", paramsSha: "gate-soniox", schemaRev: "soniox-tokens/1" },
    ours: { model: "ct2-cleanpack-cont-s47", paramsSha: "gate-ours", schemaRev: "ocasr-words/1" },
} as const;

function writeReplayEntries(dir: string, sha: string, hyps: string[][]) {
    const raws = [scribeRaw(hyps[0]), sonioxRaw(hyps[1]), oursRaw(hyps[2])];
    PROVIDER_ORDER.forEach((id, k) => {
        fs.writeFileSync(
            path.join(dir, `${sha}.${id}.json`),
            JSON.stringify({ identity: IDENTITY[id], raw: raws[k] }),
        );
    });
}

/* ------------------------------------------------------------------ */
/* Trace validation                                                    */
/* ------------------------------------------------------------------ */

interface TraceComponentShape {
    providerId: string; model: string; paramsSha: string; schemaRev: string;
    wordCount: number; cacheHit: boolean; error?: string;
}
interface TraceShape {
    audioSha256: string; arm: string; outcome: string; fallbackReason?: string;
    components: TraceComponentShape[];
    fusionConfig?: { arm?: string; guard?: boolean; chunking?: Record<string, unknown> };
}

function readTrace(traceDir: string, sha: string, requestId: string): TraceShape {
    const file = path.join(traceDir, `${sha}.rules.${requestId}.json`);
    if (!fs.existsSync(file)) throw new Error(`no trace at ${path.basename(file)}`);
    const siblings = fs.readdirSync(traceDir).filter((n) => n.startsWith(`${sha}.`) && n.endsWith(`.${requestId}.json`));
    if (siblings.length !== 1) throw new Error(`expected exactly one trace for ${requestId}, found ${siblings.length}`);
    return JSON.parse(fs.readFileSync(file, "utf8")) as TraceShape;
}

/**
 * The single validator. The negative controls run this same function, because a
 * gate whose failure cases are checked by a different, laxer rule proves nothing
 * about the rule the 391 windows actually ran under.
 */
function assertCleanFusedRun(trace: TraceShape, expect_: { audioSha: string; multipleChunks: boolean }): void {
    const problems: string[] = [];

    if (trace.outcome !== "fused") problems.push(`outcome=${trace.outcome} (${trace.fallbackReason ?? "no reason"})`);
    if (trace.arm !== "rules") problems.push(`arm=${trace.arm}`);
    if (trace.audioSha256 !== expect_.audioSha) problems.push("trace audio sha does not match the request");

    const ids = trace.components.map((c) => c.providerId).sort();
    if (JSON.stringify(ids) !== JSON.stringify([...PROVIDER_ORDER].sort())) {
        problems.push(`components=${JSON.stringify(ids)}`);
    }
    for (const component of trace.components) {
        if (component.error) problems.push(`${component.providerId} errored: ${component.error.slice(0, 80)}`);
        if (component.wordCount === 0) problems.push(`${component.providerId} contributed no words`);
        if (component.cacheHit) problems.push(`${component.providerId} was a cache hit — this run must be cold`);
        const identity = IDENTITY[component.providerId as keyof typeof IDENTITY];
        if (identity && (component.model !== identity.model || component.paramsSha !== identity.paramsSha
            || component.schemaRev !== identity.schemaRev)) {
            problems.push(`${component.providerId} identity is not the replayed one`);
        }
    }

    // fusionConfig is fuse.py's own echo of the config it parsed from stdin, so
    // this is evidence about what the subprocess received, not about what
    // TypeScript intended to send.
    const chunking = trace.fusionConfig?.chunking as Record<string, unknown> | undefined;
    if (trace.fusionConfig?.guard !== true) problems.push("fuse.py did not run with guard=true");
    if (trace.fusionConfig?.arm !== "rules") problems.push(`fuse.py ran arm=${trace.fusionConfig?.arm}`);
    if (!chunking) problems.push("fuse.py echoed no chunking config");
    else {
        for (const [key, value] of Object.entries(PRODUCTION_CHUNKING)) {
            if (chunking[key] !== value) problems.push(`chunking.${key}=${chunking[key]}, expected ${value}`);
        }
        const nChunks = Number(chunking.n_chunks);
        if (!Number.isFinite(nChunks) || nChunks < 1) problems.push(`n_chunks=${chunking.n_chunks}`);
        // The real proof that max_tokens=120 was applied rather than merely
        // reported: a window longer than 120 tokens must have been split.
        if (expect_.multipleChunks && nChunks < 2) {
            problems.push(`window is longer than ${PRODUCTION_CHUNKING.max_tokens} tokens but produced ${nChunks} chunk(s)`);
        }
        if (typeof chunking.forced_cuts !== "number") problems.push("forced_cuts is not a number");
    }

    if (problems.length > 0) throw new Error(`trace rejected: ${problems.join("; ")}`);
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */

function makeRuntime(workDir: string, bundleDir: string, extra: Record<string, string> = {}): FusionRuntime {
    return createFusionRuntime(loadFusionConfig({
        FUSION_MODE: "on",
        FUSION_OPENAI_ROUTE: "on",
        FUSION_REPLAY_DIR: bundleDir,
        FUSION_CACHE_DIR: path.join(workDir, "cache"),
        FUSION_TRACE_DIR: path.join(workDir, "traces"),
        FUSION_DEADLINE_MS: "600000",
        ...extra,
    }, REPO_ROOT));
}

function buildApp(rt: FusionRuntime): express.Express {
    const app = express();
    app.use(createAuthMiddleware({ skipAuth: false, publicPaths: [], tokens: [TOKEN], additionalPublicPaths: [] }));
    mountOpenAiCompatRoute(app, rt);
    return app;
}

async function listen(app: express.Express): Promise<{ server: http.Server; url: string }> {
    const created = http.createServer(app);
    await new Promise<void>((resolve) => created.listen(0, "127.0.0.1", resolve));
    const { port } = created.address() as { port: number };
    return { server: created, url: `http://127.0.0.1:${port}` };
}

async function postAudio(url: string, audio: Buffer, model: string) {
    const form = new FormData();
    form.append("file", new Blob([audio], { type: "audio/mpeg" }), "segment.mp3");
    form.append("model", model);
    form.append("language", "el");
    return fetch(url, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: form });
}

/** A private scratch dir. The replay bundle and the results file are derived from
 *  the benchmark, so they are the same PII category as the bundle itself. */
async function privateTmpDir(prefix: string): Promise<string> {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
    await fsp.chmod(dir, 0o700);
    return dir;
}

const tokensSha = (tokens: string[]) =>
    crypto.createHash("sha256").update(JSON.stringify(tokens)).digest("hex").slice(0, 16);

/* ================================================================== */

const bundle = loadBundle();
const HAS_PYTHON = fs.existsSync(path.join(REPO_ROOT, "fusion", "fuse.py"));
if (!HAS_PYTHON) fail("fusion/fuse.py is absent — there is nothing to gate");

describe("route gate: 391 benchmark windows through POST /v1/audio/transcriptions", () => {
    let workDir: string;
    let replayDir: string;
    let traceDir: string;
    let server: http.Server;
    let baseUrl: string;
    let resultsPath: string;
    const audioShas = new Map<string, string>();

    beforeAll(async () => {
        vi.spyOn(console, "log").mockImplementation(() => { });
        vi.spyOn(console, "warn").mockImplementation(() => { });

        workDir = await privateTmpDir("fusion-route-gate-");
        replayDir = path.join(workDir, "bundle");
        traceDir = path.join(workDir, "traces");
        fs.mkdirSync(replayDir, { recursive: true });
        resultsPath = path.join(workDir, "results.jsonl");

        for (const window of bundle.windows) {
            const sha = sha256Buf(audioFor(window.id));
            if ([...audioShas.values()].includes(sha)) fail(`two windows hash to the same audio: ${window.id}`);
            audioShas.set(window.id, sha);
            writeReplayEntries(replayDir, sha, window.hyps);
        }

        const listening = await listen(buildApp(makeRuntime(workDir, replayDir)));
        server = listening.server;
        baseUrl = listening.url;
    });

    afterAll(async () => {
        if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
        if (workDir) await fsp.rm(workDir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    it("drives all 391 windows through the route on a clean fused trace", async () => {
        const results = fs.createWriteStream(resultsPath, { encoding: "utf8" });
        const requestIds = new Set<string>();
        let differedFromFrozen = 0;

        for (const window of bundle.windows) {
            const audio = audioFor(window.id);
            const sha = audioShas.get(window.id)!;
            const response = await postAudio(`${baseUrl}/v1/audio/transcriptions`, audio, "fusion-rules");

            if (response.status !== 200) {
                throw new Error(`${window.id}: HTTP ${response.status} (${(await response.text()).slice(0, 200)})`);
            }
            expect(response.headers.get("content-type")).toMatch(/application\/json/);
            expect(response.headers.get("x-oc-audio-sha256")).toBe(sha);

            const requestId = response.headers.get("x-oc-request-id");
            if (!requestId) throw new Error(`${window.id}: no request id`);
            if (requestIds.has(requestId)) throw new Error(`${window.id}: duplicate request id`);
            requestIds.add(requestId);

            const body = await response.json() as { text?: unknown };
            if (typeof body.text !== "string") throw new Error(`${window.id}: body.text is ${typeof body.text}`);

            const longestHyp = Math.max(...window.hyps.map((h) => h.length));
            assertCleanFusedRun(readTrace(traceDir, sha, requestId), {
                audioSha: sha,
                multipleChunks: longestHyp > PRODUCTION_CHUNKING.max_tokens,
            });

            // Exact text, not WER — but the verdict is not made here. The frozen
            // fixture was measured unchunked and production runs max_tokens=120,
            // so a difference may be the priced cost of chunking or a defect in
            // this path, and only re-fusing the window in Python can tell them
            // apart. route_gate_score.py does that; this loop only records.
            const want = bundle.expected.get(window.id)!.tokens;
            const matchedFrozen = body.text === want.join(" ");
            if (!matchedFrozen) differedFromFrozen++;
            results.write(`${JSON.stringify({ id: window.id, text: body.text, matched_frozen: matchedFrozen })}\n`);
        }

        await new Promise<void>((resolve, reject) =>
            results.end((error?: Error) => (error ? reject(error) : resolve())));

        expect(requestIds.size).toBe(bundle.manifest.n_windows);
        console.info(`[gate] ${differedFromFrozen} of ${bundle.manifest.n_windows} windows differ from the unchunked frozen text`);
    });

    it("matches fuse.py exactly, and keeps chunking inside its declared budget", async () => {
        const { stdout } = await execFileAsync(PYTHON, [SCORER, resultsPath], {
            cwd: REPO_ROOT,
            env: { ...process.env, FUSION_FIXTURES_DIR: bundle.dir },
            maxBuffer: 8 * 1024 * 1024,
        });
        const summary = JSON.parse(stdout.trim().split("\n").pop()!);
        console.info(`[gate] ${JSON.stringify(summary)}`);

        expect(summary.n_results).toBe(bundle.manifest.n_windows);
        // The integration claim: every window is byte-identical to what fuse.py
        // produces for the same input and config. No tolerance on this one.
        expect(summary.n_hard_mismatches).toBe(0);
        // The chunking claim, priced separately and pre-declared.
        expect(Math.abs(summary.delta_wer)).toBeLessThanOrEqual(summary.delta_gate);
        expect(summary.frozen_sidn).toEqual(bundle.manifest.totals.rules_on);
        expect(summary.ok).toBe(true);
    });

    it("fails the scorer when a result is altered", async () => {
        // Mutate the ACTUAL result, never the trusted expectation: the control
        // has to prove the scorer catches a broken production, not a broken
        // fixture.
        const altered = path.join(workDir, "results-altered.jsonl");
        const lines = fs.readFileSync(resultsPath, "utf8").trimEnd().split("\n");
        const first = JSON.parse(lines[0]);
        lines[0] = JSON.stringify({ ...first, text: `${first.text} παρεμβολη` });
        fs.writeFileSync(altered, `${lines.join("\n")}\n`);

        const failure = await execFileAsync(PYTHON, [SCORER, altered], {
            cwd: REPO_ROOT,
            env: { ...process.env, FUSION_FIXTURES_DIR: bundle.dir },
            maxBuffer: 8 * 1024 * 1024,
        }).catch((error) => error as { code: number; stdout: string });

        expect((failure as { code: number }).code).toBe(1);
        const summary = JSON.parse((failure as { stdout: string }).stdout.trim().split("\n").pop()!);
        expect(summary.ok).toBe(false);
        // An altered result is not a chunking divergence: fuse.py will not
        // reproduce it, so it must land in the hard bucket.
        expect(summary.n_hard_mismatches).toBeGreaterThan(0);
        // and it says which window, by id and hash, never by text
        expect(JSON.stringify(summary.hard_mismatches)).not.toContain("παρεμβολη");
    });

    it("keeps request ids and results separate under concurrency", async () => {
        const sample = bundle.windows.slice(0, 8);
        const responses = await Promise.all(sample.map(async (window) => {
            const response = await postAudio(`${baseUrl}/v1/audio/transcriptions`, audioFor(window.id), "fusion-rules");
            const body = await response.json() as { text: string };
            return {
                id: window.id,
                status: response.status,
                requestId: response.headers.get("x-oc-request-id")!,
                sha: response.headers.get("x-oc-audio-sha256")!,
                text: body.text,
            };
        }));

        expect(new Set(responses.map((r) => r.requestId)).size).toBe(sample.length);
        for (const r of responses) {
            expect(r.status).toBe(200);
            expect(r.sha).toBe(audioShas.get(r.id));
            // The result must belong to the window that asked for it — a shared
            // temp path or a crossed cache entry shows up here and nowhere else.
            expect(tokensSha(r.text.split(" "))).toBe(tokensSha(bundle.expected.get(r.id)!.tokens));
        }
    });
});

/* ------------------------------------------------------------------ */
/* What the route's {text} response cannot show                        */
/* ------------------------------------------------------------------ */

describe("route gate: the Transcript behind the text", () => {
    let workDir: string;
    let replayDir: string;
    let rt: FusionRuntime;

    beforeAll(async () => {
        vi.spyOn(console, "warn").mockImplementation(() => { });
        workDir = await privateTmpDir("fusion-route-gate-tx-");
        replayDir = path.join(workDir, "bundle");
        fs.mkdirSync(replayDir, { recursive: true });
        rt = makeRuntime(workDir, replayDir);
    });

    afterAll(async () => {
        if (workDir) await fsp.rm(workDir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    async function fuseWindow(window: Window, transcriber = rt.transcriberFor("el")) {
        const audio = audioFor(window.id);
        const sha = sha256Buf(audio);
        writeReplayEntries(replayDir, sha, window.hyps);
        const file = path.join(workDir, `${sha}.mp3`);
        await fsp.writeFile(file, audio);
        const artifact = await artifactFromFile(file);
        return transcriber.fuseSegment({ audio: artifact, model: "fusion-rules", language: "el" });
    }

    it("gives words[] the same stream as the text, with usable timings", async () => {
        // 25 windows, not 391: this asserts a structural invariant, and the
        // route run above already covers the text on all of them.
        for (const window of bundle.windows.slice(0, 25)) {
            const { transcript, outcome } = await fuseWindow(window);
            expect(outcome).toBe("fused");

            const want = bundle.expected.get(window.id)!.tokens;
            const words = transcript.transcription.utterances.flatMap((u) => u.words);

            expect(tokensSha(words.map((w) => w.word))).toBe(tokensSha(want));
            expect(tokensSha(transcript.transcription.full_transcript.split(" "))).toBe(tokensSha(want));

            let previous = -Infinity;
            for (const word of words) {
                expect(Number.isFinite(word.start) && Number.isFinite(word.end)).toBe(true);
                expect(word.start).toBeGreaterThanOrEqual(0);
                expect(word.end).toBeGreaterThanOrEqual(word.start);
                expect(word.start).toBeGreaterThanOrEqual(previous);
                previous = word.start;
            }
        }
    }, 15 * 60_000);

    it("sends fuse.py the frozen chunking on the wire, not just in the trace", async () => {
        // The trace echoes fuse.py's parsed config, which is good evidence — but
        // it cannot see a caller that omits `chunking` and inherits Python's
        // default 800. This reads the object that actually goes to child stdin.
        const seen: FusionInput[] = [];
        const transcriber = new FusionTranscriber({
            config: rt.config,
            providers: createProviders(rt.config, "el"),
            cache: rt.cache,
            trace: rt.trace,
            runFusion: (input, options) => {
                seen.push(input);
                return runFusionPython(input, options);
            },
        });

        // A window the test above did not fuse: a cached fusion result would
        // skip the subprocess entirely and leave `seen` empty.
        const { outcome } = await fuseWindow(bundle.windows[bundle.windows.length - 1], transcriber);
        expect(outcome).toBe("fused");
        expect(seen).toHaveLength(1);
        expect(seen[0].config.guard).toBe(true);
        expect(seen[0].config.arm).toBe("rules");
        expect(seen[0].config.chunking).toEqual({ ...PRODUCTION_CHUNKING });
        expect(seen[0].systems.map((s) => s.id)).toEqual([...PROVIDER_ORDER]);
    }, 5 * 60_000);
});

/* ------------------------------------------------------------------ */
/* Negative controls — the validator must reject these                 */
/* ------------------------------------------------------------------ */

describe("route gate: negative controls", () => {
    let workDir: string;
    let traceDir: string;

    beforeAll(async () => {
        vi.spyOn(console, "warn").mockImplementation(() => { });
        workDir = await privateTmpDir("fusion-route-gate-neg-");
        traceDir = path.join(workDir, "traces");
    });

    afterAll(async () => {
        if (workDir) await fsp.rm(workDir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    /** Each control gets its own cache and replay directory, or one control's
     *  cached component would answer the next one's request. */
    async function scenario(name: string, prepare: (dir: string, sha: string) => void) {
        const window = bundle.windows[0];
        const dir = path.join(workDir, name);
        fs.mkdirSync(dir, { recursive: true });
        const audio = audioFor(`${name}-${window.id}`);
        const sha = sha256Buf(audio);
        writeReplayEntries(dir, sha, window.hyps);
        prepare(dir, sha);

        const scenarioWork = path.join(workDir, `${name}-work`);
        fs.mkdirSync(scenarioWork, { recursive: true });
        const { server, url } = await listen(buildApp(makeRuntime(scenarioWork, dir)));
        try {
            const response = await postAudio(`${url}/v1/audio/transcriptions`, audio, "fusion-rules");
            return {
                response,
                sha,
                traceDir: path.join(scenarioWork, "traces"),
                requestId: response.headers.get("x-oc-request-id") ?? "",
            };
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    }

    it("rejects a Scribe fallback caused by a failing auxiliary provider", async () => {
        const { response, sha, traceDir: dir, requestId } = await scenario("soniox500", (bundleDir, audioSha) => {
            fs.writeFileSync(path.join(bundleDir, "schedule.json"),
                JSON.stringify({ failures: { [`${audioSha}.soniox`]: "http500" } }));
        });

        // The product is right to answer with Scribe. The gate is wrong if it
        // counts that answer as a fused run.
        expect(response.status).toBe(200);
        const trace = readTrace(dir, sha, requestId);
        expect(trace.outcome).toBe("scribe-fallback");
        expect(() => assertCleanFusedRun(trace, { audioSha: sha, multipleChunks: false })).toThrow(/outcome=scribe-fallback/);
    });

    it("rejects a Scribe fallback caused by a missing auxiliary replay entry", async () => {
        const { response, sha, traceDir: dir, requestId } = await scenario("missingaux", (bundleDir, audioSha) => {
            fs.rmSync(path.join(bundleDir, `${audioSha}.ours.json`));
        });

        expect(response.status).toBe(200);
        const trace = readTrace(dir, sha, requestId);
        expect(trace.outcome).toBe("scribe-fallback");
        expect(() => assertCleanFusedRun(trace, { audioSha: sha, multipleChunks: false })).toThrow();
    });

    it("returns 502 when Scribe itself has no replay entry", async () => {
        const { response } = await scenario("missingscribe", (bundleDir, audioSha) => {
            fs.rmSync(path.join(bundleDir, `${audioSha}.scribe.json`));
        });
        expect(response.status).toBe(502);
    });

    it("rejects a trace whose chunking is not the frozen one", () => {
        const base: TraceShape = {
            audioSha256: "a".repeat(64),
            arm: "rules",
            outcome: "fused",
            components: PROVIDER_ORDER.map((id) => ({
                providerId: id, ...IDENTITY[id], wordCount: 10, cacheHit: false,
            })),
            fusionConfig: { arm: "rules", guard: true, chunking: { ...PRODUCTION_CHUNKING, n_chunks: 3, forced_cuts: 0 } },
        };
        expect(() => assertCleanFusedRun(base, { audioSha: base.audioSha256, multipleChunks: true })).not.toThrow();

        // Python's default when `chunking` is omitted entirely.
        const defaulted = { ...base, fusionConfig: { arm: "rules", guard: true, chunking: { max_tokens: 800, anchor_n: 3, search_radius: 200, n_chunks: 1, forced_cuts: 0 } } };
        expect(() => assertCleanFusedRun(defaulted, { audioSha: base.audioSha256, multipleChunks: true }))
            .toThrow(/max_tokens=800/);

        const warmCache = { ...base, components: base.components.map((c) => ({ ...c, cacheHit: true })) };
        expect(() => assertCleanFusedRun(warmCache, { audioSha: base.audioSha256, multipleChunks: true }))
            .toThrow(/must be cold/);

        const guardOff = { ...base, fusionConfig: { ...base.fusionConfig!, guard: false } };
        expect(() => assertCleanFusedRun(guardOff, { audioSha: base.audioSha256, multipleChunks: true }))
            .toThrow(/guard=true/);
    });
});

/* ------------------------------------------------------------------ */
/* The hole the frozen benchmark cannot cover                          */
/* ------------------------------------------------------------------ */

describe("route gate: raw provider words the benchmark never contains", () => {
    /**
     * Every fixture token is wtoks-stable — one normalized token per provider
     * item — so the 391 windows never exercise the path where one raw word
     * becomes several tokens. That is exactly the path that produced the
     * duplication defect fixed in 5c8ce7e. This is synthetic Greek, invented
     * here, and safe to commit.
     */
    let workDir: string;
    let replayDir: string;
    let rt: FusionRuntime;

    beforeAll(async () => {
        vi.spyOn(console, "warn").mockImplementation(() => { });
        workDir = await privateTmpDir("fusion-route-gate-adv-");
        replayDir = path.join(workDir, "bundle");
        fs.mkdirSync(replayDir, { recursive: true });
        rt = makeRuntime(workDir, replayDir);
    });

    afterAll(async () => {
        if (workDir) await fsp.rm(workDir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    async function fuseRaw(name: string, raws: [unknown, unknown, unknown]) {
        const audio = Buffer.from(`RIFF-adv-${name}`, "utf8");
        const sha = sha256Buf(audio);
        PROVIDER_ORDER.forEach((id, k) => {
            fs.writeFileSync(path.join(replayDir, `${sha}.${id}.json`),
                JSON.stringify({ identity: IDENTITY[id], raw: raws[k] }));
        });
        const file = path.join(workDir, `${sha}.mp3`);
        await fsp.writeFile(file, audio);
        const artifact = await artifactFromFile(file);
        return rt.transcriberFor("el").fuseSegment({ audio: artifact, model: "fusion-rules", language: "el" });
    }

    it("emits a one-to-many raw word once, from whichever provider supplies it", async () => {
        const words = ["αλφα", "κ.λπ", "γαμμα"];
        const { transcript, outcome } = await fuseRaw("one-to-many", [
            scribeRaw(words), sonioxRaw(words), oursRaw(words),
        ]);
        expect(outcome).toBe("fused");
        expect(transcript.transcription.full_transcript).toBe("αλφα κ.λπ γαμμα");
        expect(transcript.transcription.utterances.flatMap((u) => u.words).map((w) => w.word))
            .toEqual(["αλφα", "κ.λπ", "γαμμα"]);
    }, 60_000);

    it("drops a raw item that normalizes to nothing", async () => {
        const withPunct = ["αλφα", "—", "γαμμα"];
        const { transcript, outcome } = await fuseRaw("zero-token", [
            scribeRaw(withPunct), sonioxRaw(withPunct), oursRaw(withPunct),
        ]);
        expect(outcome).toBe("fused");
        expect(transcript.transcription.full_transcript.split(" ").filter((w) => w === "—")).toHaveLength(0);
    }, 60_000);

    it("rebuilds a Soniox word from its sub-word pieces", async () => {
        const whole = ["ΑΛΦΑ", "συνεδριαζει", "γαμμα"];
        const pieces = {
            tokens: [
                { text: "ΑΛΦΑ", start_ms: 0, end_ms: 400, confidence: 0.9 },
                { text: " συνε", start_ms: 500, end_ms: 700, confidence: 0.8 },
                { text: "δρια", start_ms: 700, end_ms: 800, confidence: 0.7 },
                { text: "ζει", start_ms: 800, end_ms: 900, confidence: 0.9 },
                { text: " γαμμα", start_ms: 1000, end_ms: 1400, confidence: 0.9 },
            ],
        };
        const { transcript, outcome } = await fuseRaw("soniox-pieces", [
            scribeRaw(whole), pieces, oursRaw(whole),
        ]);
        expect(outcome).toBe("fused");
        // Three words in, three words out — the pieces must not survive as words.
        expect(transcript.transcription.full_transcript.split(" ")).toHaveLength(3);
    }, 60_000);
});
