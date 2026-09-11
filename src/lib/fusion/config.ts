import path from "path";
import os from "os";
import { sha256OfValue, shortSha } from "./hash.js";

/**
 * Typed fusion configuration, read once at the composition root.
 *
 * Every knob is off by default: an environment that has never heard of fusion
 * must behave exactly as it does today. An *invalid* value throws at startup
 * rather than degrading silently — a typo'd FUSION_MODE that quietly means
 * "off" is indistinguishable from a fusion outage.
 */

export type FusionMode = "off" | "shadow" | "on";
export type OnOff = "off" | "on";
/**
 * One value, kept as a named type because the engine revision and the cache
 * namespace still distinguish the TypeScript engine from the Python era whose
 * entries are still on disk.
 */
export type FusionEngine = "node";

export interface FusionConfig {
    mode: FusionMode;
    /** LLM chooser (policy arms). Can only ever be granted at startup. */
    llm: OnOff;
    /** Whether the openai-compatible route is mounted at all. */
    openaiRoute: OnOff;
    /** Percentage of meetings that get fusion while mode=on. 0 ⇒ nobody. */
    canaryPercent: number;
    /**
     * Which implementation of the fuse core runs. `python` spawns
     * Which implementation of the fuse core runs. There is one, and the field
     * survives because the engine revision and the cache namespace still have
     * to distinguish it from the Python era whose entries are still on disk.
     */
    engine: FusionEngine;
    cacheDir: string;
    traceDir: string;
    deadlineMs: number;
    /**
     * How audio reaches the two providers that fetch it out of process.
     * `url` publishes one temporary public object and hands all three the same
     * link. `bytes` uploads the file to each vendor instead, which is what a
     * deployment with no bucket has to do. `auto` picks `url` when the caller
     * already has a canonical URL or a bucket is configured, and `bytes`
     * otherwise -- so a missing bucket degrades the transport, never the result.
     */
    audioTransport: "url" | "bytes" | "auto";
    /** When set, providers are served from a replay bundle and never hit the network. */
    replayDir?: string;
    /**
     * Where the three raw per-system word streams are kept (decision of
     * 2026-09-09: keep them, but not in the database). Unset ⇒ not kept.
     *
     * A directory of verbatim council speech, so it must point at a mounted
     * volume outside the checkout — never a path inside the repo.
     */
    rawLogDir?: string;
    /** Size valve for one raw record. Default 32 MB; a 20-minute segment is ~0.6 MB. */
    rawLogMaxBytes: number;
    rawLogRetentionDays: number;
    /** Repo root; the engine is spawned with this as cwd. */
    repoRoot: string;
}

const MODES: FusionMode[] = ["off", "shadow", "on"];

export class FusionConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "FusionConfigError";
    }
}

type Env = Record<string, string | undefined>;

function readEnum<T extends string>(env: Env, name: string, allowed: readonly T[], fallback: T): T {
    const raw = env[name];
    if (raw === undefined || raw === "") {
        return fallback;
    }
    const value = raw.trim();
    if (!(allowed as readonly string[]).includes(value)) {
        throw new FusionConfigError(`${name} must be one of ${allowed.join("|")} (got ${JSON.stringify(raw)})`);
    }
    return value as T;
}

function readInt(env: Env, name: string, fallback: number, min: number, max: number): number {
    const raw = env[name];
    if (raw === undefined || raw === "") {
        return fallback;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new FusionConfigError(`${name} must be an integer in [${min}, ${max}] (got ${JSON.stringify(raw)})`);
    }
    return value;
}

export function loadFusionConfig(env: Env = process.env, repoRoot: string = process.cwd()): FusionConfig {
    const mode = readEnum(env, "FUSION_MODE", MODES, "off");
    // The LLM arbiter was retired with the Python engine. It contributed to no
    // measured result, it never passed the listening test its deletion rate
    // demanded, and an external model's answers cannot be part of a
    // deterministic equivalence proof. An environment that still asks for it is
    // asking for something this build cannot do, so it is a startup error
    // rather than a silent downgrade to the rules arm.
    const llm = readEnum(env, "FUSION_LLM", ["off", "on"] as const, "off");
    if (llm === "on") {
        throw new FusionConfigError(
            "FUSION_LLM=on is no longer supported: the LLM arbiter was removed "
            + "with the Python engine. Unset FUSION_LLM to run the rules arm. "
            + "See docs/fusion-python-archive.md.");
    }
    const openaiRoute = readEnum(env, "FUSION_OPENAI_ROUTE", ["off", "on"] as const, "off");
    // FUSION_ENGINE is retired. There is one engine now, so the variable can
    // only say something wrong.
    //
    // An explicit `python` fails rather than falling through. It is a statement
    // about which implementation and which cache namespace the operator wants,
    // and quietly giving them the other one changes both -- which is exactly
    // what separate namespaces exist to prevent. The preflight already holds
    // the line that fusion enabled and unusable means do not start.
    const requestedEngine = env.FUSION_ENGINE?.trim();
    if (requestedEngine === "python") {
        throw new FusionConfigError(
            "FUSION_ENGINE=python is no longer supported: the Python engine was "
            + "removed. Unset FUSION_ENGINE to use the TypeScript engine, or roll "
            + "back to a Python-capable image. See docs/fusion-python-archive.md.");
    }
    if (requestedEngine !== undefined && requestedEngine !== "" && requestedEngine !== "node") {
        throw new FusionConfigError(
            `FUSION_ENGINE must be unset (got ${JSON.stringify(requestedEngine)}); `
            + "the variable is retired and there is one engine.");
    }
    if (requestedEngine === "node") {
        console.warn("[fusion] FUSION_ENGINE=node is redundant and will stop being "
            + "read; there is one engine. Remove it from the environment.");
    }
    if (env.FUSION_PYTHON_BIN?.trim()) {
        console.warn("[fusion] FUSION_PYTHON_BIN is ignored: the engine is no longer "
            + "Python. Remove it from the environment.");
    }
    const engine: FusionEngine = "node";
    const canaryPercent = readInt(env, "FUSION_CANARY_PERCENT", 0, 0, 100);
    const audioTransport = readEnum(env, "FUSION_AUDIO_TRANSPORT",
        ["url", "bytes", "auto"] as const, "auto");
    const deadlineMs = readInt(env, "FUSION_DEADLINE_MS", 240_000, 1_000, 3_600_000);

    const rawLogMaxBytes = readInt(env, "FUSION_RAW_LOG_MAX_BYTES", 32 * 1024 * 1024, 4096, 1024 * 1024 * 1024);
    // Records are council speech. The default expires them; 0 keeps them for
    // good and has to be typed out on purpose.
    const rawLogRetentionDays = readInt(env, "FUSION_RAW_LOG_RETENTION_DAYS", 14, 0, 3650);

    const replayDir = env.FUSION_REPLAY_DIR?.trim() || undefined;

    return {
        mode,
        llm,
        openaiRoute,
        canaryPercent,
        audioTransport,
        engine,
        cacheDir: env.FUSION_CACHE_DIR?.trim() || path.join(os.tmpdir(), "oc-fusion-cache"),
        traceDir: env.FUSION_TRACE_DIR?.trim() || path.join(os.tmpdir(), "oc-fusion-traces"),
        deadlineMs,
        replayDir,
        rawLogDir: env.FUSION_RAW_LOG_DIR?.trim() || undefined,
        rawLogMaxBytes,
        rawLogRetentionDays,
        repoRoot,
    };
}

/** Identity of the knobs that change the *output*, for the trace and cache key. */
export function fusionConfigSha(config: Pick<FusionConfig, "llm">, extra: Record<string, unknown> = {}): string {
    return shortSha(sha256OfValue({ llm: config.llm, ...extra }));
}
