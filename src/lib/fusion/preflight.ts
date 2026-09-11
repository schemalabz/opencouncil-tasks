import fs from "fs";
import path from "path";
import type { FusionConfig } from "./config.js";
import { FUSION_NODE_SCRIPT, fusionEngineRevision, runFusionPython } from "./fusePy.js";
import { createDeadline } from "./deadline.js";
import type { FusionInput } from "./types.js";

/**
 * Startup check: can this deployment actually run the fusion engine?
 *
 * It exists because of one measured failure mode. The production runner image
 * copied `dist/`, `VERSION` and `assets/` and never `fusion/`, and installed no
 * Python. With FUSION_MODE=on that deployment pays ElevenLabs *and* Soniox
 * *and* RunPod for every segment, discards two of the three results when the
 * subprocess fails to spawn, and returns a Scribe transcript that looks
 * completely normal. Nothing in the output says the fusion never ran.
 *
 * So the probe is the real thing, not an existence check: the same
 * `runFusionPython`, the same script, the same `repoRoot`, on a synthetic
 * three-word payload. An existence check passes on a Python that is too old
 * on a script the runtime user cannot read, and on
 * a `fusion/` that is missing one module — all three of which are exactly what
 * a packaging mistake produces.
 *
 * When the effective mode is `off` it probes nothing, so an environment that
 * has never heard of fusion does not acquire a Python dependency by being
 * upgraded.
 */

const DEFAULT_TIMEOUT_MS = 30_000;

/** Synthetic. The engine's answer is what is being tested, not its quality. */
const PROBE_AUDIO_SHA = "0".repeat(64);

function probeInput(): FusionInput {
    const words = (raw: string) => [{ raw, start: 0, end: 0.4, conf: 0.9 }];
    return {
        schema: "oc-fusion-in/1",
        audio_sha256: PROBE_AUDIO_SHA,
        systems: [
            { id: "scribe", params_sha: "preflight", words: words("alpha") },
            { id: "soniox", params_sha: "preflight", words: words("alpha") },
            { id: "ours", params_sha: "preflight", words: words("alpha") },
        ],
        config: { arm: "rules", guard: true, llm: null },
    };
}

export interface FusionPreflightResult {
    /** False when fusion is off and nothing was probed. */
    checked: boolean;
    ok: boolean;
    /** One line, safe to log: the interpreter, the script, or the engine's stderr. */
    problem?: string;
    repoRoot: string;
    engineRev?: string;
    elapsedMs?: number;
}

export interface FusionPreflightOptions {
    timeoutMs?: number;
}

export async function fusionPreflight(
    config: FusionConfig,
    options: FusionPreflightOptions = {},
): Promise<FusionPreflightResult> {
    const base: FusionPreflightResult = { checked: false, ok: true, repoRoot: config.repoRoot };
    if (config.mode === "off") return base;

    const checked = { ...base, checked: true };

    // Checked before spawning only so the message names the real cause: a
    // missing script and a broken interpreter both surface as ENOENT otherwise.
    // It has to be the configured engine's script. Checking the Python's while
    // `node` is configured passes on a deployment that has `fusion/` and no
    // built engine, and then every segment fails to spawn: the silent
    // degradation this whole check exists to prevent.
    const scriptName = FUSION_NODE_SCRIPT;
    const script = path.join(config.repoRoot, scriptName);
    if (!fs.existsSync(script)) {
        return {
            ...checked,
            ok: false,
            problem: `${scriptName} is not present at ${script} — the fusion engine was not packaged with this build`,
        };
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const deadline = createDeadline(Date.now() + timeoutMs);
    const startedAt = Date.now();
    try {
        const { output } = await runFusionPython(probeInput(), {
            // The probe has to run the engine that will serve traffic. Probing
            // the Python while `node` is configured would pass on a deployment
            // whose built engine is missing from the image, which is the exact
            // packaging failure this check exists for.
            engine: config.engine,
            repoRoot: config.repoRoot,
            signal: deadline.signal,
            deadlineAt: deadline.deadlineAt,
        });
        if (output.audio_sha256 !== PROBE_AUDIO_SHA) {
            return { ...checked, ok: false, problem: `${scriptName} answered for different audio than it was given` };
        }
        return {
            ...checked,
            engineRev: fusionEngineRevision(config.repoRoot, config.engine),
            elapsedMs: Date.now() - startedAt,
        };
    } catch (error) {
        return {
            ...checked,
            ok: false,
            problem: oneLine(error instanceof Error ? error.message : String(error)),
            elapsedMs: Date.now() - startedAt,
        };
    } finally {
        deadline.dispose();
    }
}

/**
 * Throws when fusion is enabled and unusable. Called from the composition root
 * before the server accepts connections: failing to start is cheap, and a
 * process that has already billed three vendors per segment is not.
 */
export async function assertFusionRuntimeUsable(
    config: FusionConfig,
    options: FusionPreflightOptions = {},
): Promise<void> {
    const result = await fusionPreflight(config, options);
    if (!result.checked) return;
    if (!result.ok) {
        throw new Error(
            `[fusion] FUSION_MODE=${config.mode} but the fusion engine cannot run: ${result.problem}\n`
            + `  engine: ${FUSION_NODE_SCRIPT}\n`
            + `  repo root:   ${result.repoRoot}\n`
            + "  Fusion needs dist/lib/fusion/engine/ and fusion/*.json present in the image.\n"
            + "  Set FUSION_MODE=off to run the Scribe-only path.",
        );
    }
    console.log(
        `🔀 Fusion engine preflight passed (${FUSION_NODE_SCRIPT}, engine ${result.engineRev}, ${result.elapsedMs} ms)`,
    );
}

function oneLine(message: string): string {
    return message.replace(/\s+/g, " ").trim().slice(0, 500);
}
