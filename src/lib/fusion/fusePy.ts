import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { sha256Hex, shortSha } from "./hash.js";
import { FusionEngineError, type FusionInput, type FusionOutput } from "./types.js";

/**
 * The one subprocess call across the Python boundary (fusion/CONTRACT.md):
 *
 *   python3 fusion/fuse.py   stdin oc-fusion-in/1  →  stdout oc-fusion/1
 *
 * Everything that can go wrong here resolves to the same thing — a
 * FusionEngineError, which the caller turns into an exact Scribe fallback.
 * There is no partial-output path: a fused transcript assembled from half a
 * response would be a new, unevaluated system.
 */

export const FUSION_SCRIPT = "fusion/fuse.py";
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const STDERR_TAIL_BYTES = 4096;

const engineRevisions = new Map<string, string>();

/**
 * Content revision of the Python side: the sha of every `fusion/*.py` and
 * `fusion/*.json` file. It stands in for `normalizer_rev`, `chunking_rev` and
 * `policy_sha` in the *cache key*, which has to be computed before fuse.py runs
 * — those three are only reported in its output, and a key that cannot see a
 * rule change would serve yesterday's fusion for today's rules.
 *
 * Memoized per repo root: this is on the path of every segment.
 */
export function fusionEngineRevision(repoRoot: string): string {
    const cached = engineRevisions.get(repoRoot);
    if (cached) return cached;

    const dir = path.join(repoRoot, "fusion");
    let revision: string;
    try {
        const files = fs.readdirSync(dir)
            .filter((name) => name.endsWith(".py") || name.endsWith(".json"))
            .sort();
        const parts = files.map((name) => `${name}:${sha256Hex(fs.readFileSync(path.join(dir, name)))}`);
        revision = parts.length === 0 ? "absent" : shortSha(sha256Hex(parts.join("\n")));
    } catch {
        revision = "absent";
    }
    engineRevisions.set(repoRoot, revision);
    return revision;
}

/** Test/ops hook: forget the memoized revision (used after editing fusion/). */
export function clearEngineRevisionCache(): void {
    engineRevisions.clear();
}

export interface FusePyOptions {
    pythonBin: string;
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

export async function runFusionPython(input: FusionInput, options: FusePyOptions): Promise<FusePyResult> {
    const startedAt = Date.now();
    const scriptPath = path.join(options.repoRoot, FUSION_SCRIPT);
    const maxOutput = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;

    const { stdout, stderrTail, code, signalName, spawnError, overflowed } = await new Promise<{
        stdout: string; stderrTail: string; code: number | null; signalName: NodeJS.Signals | null;
        spawnError?: Error; overflowed: boolean;
    }>((resolve) => {
        const child = spawn(options.pythonBin, [scriptPath], {
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

        const onAbort = () => kill();
        options.signal.addEventListener("abort", onAbort, { once: true });
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
        throw new FusionEngineError(`could not run ${options.pythonBin} ${FUSION_SCRIPT}: ${spawnError.message}`, "python_spawn_failed");
    }
    if (overflowed) {
        throw new FusionEngineError(`fuse.py wrote more than ${maxOutput} bytes to stdout`, "python_output_too_large");
    }
    if (options.signal.aborted || Date.now() >= options.deadlineAt) {
        throw new FusionEngineError("fuse.py was killed at the deadline", "python_deadline");
    }
    if (code !== 0) {
        throw new FusionEngineError(
            `fuse.py exited with ${code ?? `signal ${signalName}`}: ${stderrTail.slice(-500)}`,
            "python_nonzero_exit",
        );
    }

    let parsed: FusionOutput;
    try {
        parsed = JSON.parse(stdout) as FusionOutput;
    } catch (error) {
        throw new FusionEngineError(`fuse.py stdout is not JSON: ${error}`, "python_invalid_json");
    }

    if (parsed?.schema !== "oc-fusion/1") {
        throw new FusionEngineError(`fuse.py returned schema ${JSON.stringify(parsed?.schema)}, expected oc-fusion/1`, "python_bad_schema");
    }
    if (!Array.isArray(parsed.tokens)) {
        throw new FusionEngineError("fuse.py returned no tokens array", "python_bad_schema");
    }
    if (parsed.audio_sha256 !== input.audio_sha256) {
        // A result for different audio is the worst possible silent failure:
        // a correct-looking transcript of somebody else's meeting.
        throw new FusionEngineError(
            `fuse.py returned audio_sha256 ${parsed.audio_sha256}, expected ${input.audio_sha256}`,
            "python_audio_mismatch",
        );
    }

    return { output: parsed, stderrTail, elapsedMs: Date.now() - startedAt };
}
