import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { sha256Hex, shortSha } from "./hash.js";
import type { FusionEngine } from "./config.js";
import { FusionEngineError, type FusionInput, type FusionOutput } from "./types.js";

/**
 * The one subprocess call across the engine boundary (fusion/CONTRACT.md):
 *
 *   node dist/lib/fusion/engine/cli.js   stdin oc-fusion-in/1  →  stdout oc-fusion/1
 *
 * Everything that can go wrong here resolves to the same thing — a
 * FusionEngineError, which the caller turns into an exact Scribe fallback.
 * There is no partial-output path: a fused transcript assembled from half a
 * response would be a new, unevaluated system.
 */

/** The TypeScript engine's entry point, in the built output that ships. */
export const FUSION_NODE_SCRIPT = "dist/lib/fusion/engine/cli.js";
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const STDERR_TAIL_BYTES = 4096;

const engineRevisions = new Map<string, string>();

/**
 * Content revision of what will run: the sha of the built engine and of the
 * frozen `fusion/*.json` it reads. It stands in for `normalizer_rev`,
 * `chunking_rev` and `policy_sha` in the *cache key*, which has to be computed
 * before the engine runs — those three are only reported in its output, and a
 * key that cannot see a rule change would serve yesterday's fusion for today's
 * rules.
 *
 * Memoized per repo root: this is on the path of every segment.
 */
export function fusionEngineRevision(repoRoot: string, engine: FusionEngine = "node"): string {
    const cacheKey = `${engine}:${repoRoot}`;
    const cached = engineRevisions.get(cacheKey);
    if (cached) return cached;

    // Hash what actually runs: the built engine, plus the frozen policy assets
    // it reads. A change to either has to change the revision, or the cache
    // would serve yesterday's fusion for today's rules.
    void engine;
    const dirs = [
        { dir: path.join(repoRoot, "dist/lib/fusion/engine"), ext: [".js"] },
        { dir: path.join(repoRoot, "fusion"), ext: [".json"] },
    ];

    // `tsc` emits `src/**/*.test.ts` beside the engine it tests, and a filter of
    // every `.js` picked those up too — so the production cache key moved
    // whenever an assertion did, throwing away fused segments that cost minutes
    // each to produce. Tests cannot change what the engine outputs.
    const isTest = (name: string) => /\.test\.js$/.test(name);

    let revision: string;
    try {
        const parts: string[] = [];
        for (const { dir, ext } of dirs) {
            const files = fs.readdirSync(dir)
                .filter((name) => ext.some((e) => name.endsWith(e)) && !isTest(name))
                .sort();
            for (const name of files) {
                parts.push(`${name}:${sha256Hex(fs.readFileSync(path.join(dir, name)))}`);
            }
        }
        // The Python revision keeps its original form so every fused result
        // already in the cache stays addressable. The TypeScript one is
        // prefixed, which is the whole point: the two engines must never read
        // each other's entries, even when their output is identical.
        const digest = parts.length === 0 ? "absent" : shortSha(sha256Hex(parts.join("\n")));
        // The prefix is permanent. It is in every cache key already written,
        // and it is what keeps the Python era's entries unreadable rather than
        // merely unlikely to be asked for.
        revision = digest === "absent" ? digest : `ts-${digest}`;
    } catch {
        revision = "absent";
    }
    engineRevisions.set(cacheKey, revision);
    return revision;
}

/** Test/ops hook: forget the memoized revision (used after editing fusion/). */
export function clearEngineRevisionCache(): void {
    engineRevisions.clear();
}

export interface FusePyOptions {
    /** Retained so the one call site stays explicit; there is one engine. */
    engine?: FusionEngine;
    repoRoot: string;
    signal: AbortSignal;
    deadlineAt: number;
    maxOutputBytes?: number;
}

export interface FusePyResult {
    output: FusionOutput;
    stderrTail: string;
    elapsedMs: number;
}

export async function runFusionEngine(input: FusionInput, options: FusePyOptions): Promise<FusePyResult> {
    const startedAt = Date.now();
    // `process.execPath` rather than a `node` found on PATH: the child must be
    // this runtime, not whatever a shell would have resolved.
    const command = process.execPath;
    const scriptPath = path.join(options.repoRoot, FUSION_NODE_SCRIPT);
    const maxOutput = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;

    const { stdout, stderrTail, code, signalName, spawnError, overflowed } = await new Promise<{
        stdout: string; stderrTail: string; code: number | null; signalName: NodeJS.Signals | null;
        spawnError?: Error; overflowed: boolean;
    }>((resolve) => {
        const child = spawn(command, [scriptPath], {
            cwd: options.repoRoot,
            stdio: ["pipe", "pipe", "pipe"],
        });

        const outChunks: Buffer[] = [];
        let outBytes = 0;
        let overflow = false;
        let errTail = "";
        let settled = false;
        let spawnFailure: Error | undefined;

        const kill = () => {
            child.kill("SIGTERM");
            setTimeout(() => child.killed || child.kill("SIGKILL"), 2_000).unref?.();
        };

        // An already-aborted signal never dispatches `abort`, so a listener
        // alone let the child run to the deadline for a caller that had already
        // given up. The result was still right — the check after the await sees
        // `aborted` — it was the work that carried on.
        const onAbort = () => kill();
        if (options.signal.aborted) kill();
        else options.signal.addEventListener("abort", onAbort, { once: true });
        const remaining = options.deadlineAt - Date.now();
        const timer = setTimeout(kill, Math.max(0, remaining));
        timer.unref?.();

        const finish = (result: Parameters<typeof resolve>[0]) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            options.signal.removeEventListener("abort", onAbort);
            resolve(result);
        };

        child.stdout.on("data", (chunk: Buffer) => {
            outBytes += chunk.length;
            if (outBytes > maxOutput) {
                overflow = true;
                kill();
                return;
            }
            outChunks.push(chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
            errTail = (errTail + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
        });
        child.on("error", (error) => {
            spawnFailure = error;
            finish({ stdout: "", stderrTail: errTail, code: null, signalName: null, spawnError: error, overflowed: overflow });
        });
        child.on("close", (code, signalName) => {
            finish({
                stdout: Buffer.concat(outChunks).toString("utf8"),
                stderrTail: errTail,
                code,
                signalName,
                spawnError: spawnFailure,
                overflowed: overflow,
            });
        });

        child.stdin.on("error", () => { /* a dead child's closed stdin surfaces on 'close' */ });
        child.stdin.end(JSON.stringify(input));
    });

    if (spawnError) {
        throw new FusionEngineError(`could not run ${FUSION_NODE_SCRIPT}: ${spawnError.message}`, "python_spawn_failed");
    }
    if (overflowed) {
        throw new FusionEngineError(`${FUSION_NODE_SCRIPT} wrote more than ${maxOutput} bytes to stdout`, "python_output_too_large");
    }
    if (options.signal.aborted || Date.now() >= options.deadlineAt) {
        throw new FusionEngineError("the fusion engine was killed at the deadline", "python_deadline");
    }
    if (code !== 0) {
        throw new FusionEngineError(
            `the fusion engine exited with ${code ?? `signal ${signalName}`}: ${stderrTail.slice(-500)}`,
            "python_nonzero_exit",
        );
    }

    let parsed: FusionOutput;
    try {
        parsed = JSON.parse(stdout) as FusionOutput;
    } catch (error) {
        throw new FusionEngineError(`the fusion engine wrote stdout that is not JSON: ${error}`, "python_invalid_json");
    }

    if (parsed?.schema !== "oc-fusion/1") {
        throw new FusionEngineError(`the fusion engine returned schema ${JSON.stringify(parsed?.schema)}, expected oc-fusion/1`, "python_bad_schema");
    }
    if (!Array.isArray(parsed.tokens)) {
        throw new FusionEngineError("the fusion engine returned no tokens array", "python_bad_schema");
    }
    if (parsed.audio_sha256 !== input.audio_sha256) {
        // A result for different audio is the worst possible silent failure:
        // a correct-looking transcript of somebody else's meeting.
        throw new FusionEngineError(
            `the fusion engine returned audio_sha256 ${parsed.audio_sha256}, expected ${input.audio_sha256}`,
            "python_audio_mismatch",
        );
    }

    return { output: parsed, stderrTail, elapsedMs: Date.now() - startedAt };
}
