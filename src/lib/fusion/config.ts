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

export interface FusionConfig {
    mode: FusionMode;
    /** LLM chooser (policy arms). Can only ever be granted at startup. */
    llm: OnOff;
    /** Whether the openai-compatible route is mounted at all. */
    openaiRoute: OnOff;
    /** Percentage of meetings that get fusion while mode=on. 0 ⇒ nobody. */
    canaryPercent: number;
    pythonBin: string;
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
    /** Repo root; fuse.py is spawned with this as cwd. */
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
    const llm = readEnum(env, "FUSION_LLM", ["off", "on"] as const, "off");
    const openaiRoute = readEnum(env, "FUSION_OPENAI_ROUTE", ["off", "on"] as const, "off");
    const canaryPercent = readInt(env, "FUSION_CANARY_PERCENT", 0, 0, 100);
    const audioTransport = readEnum(env, "FUSION_AUDIO_TRANSPORT",
        ["url", "bytes", "auto"] as const, "auto");
    const deadlineMs = readInt(env, "FUSION_DEADLINE_MS", 240_000, 1_000, 3_600_000);

    const replayDir = env.FUSION_REPLAY_DIR?.trim() || undefined;

    return {
        mode,
        llm,
        openaiRoute,
        canaryPercent,
        audioTransport,
        pythonBin: env.FUSION_PYTHON_BIN?.trim() || "python3",
        cacheDir: env.FUSION_CACHE_DIR?.trim() || path.join(os.tmpdir(), "oc-fusion-cache"),
        traceDir: env.FUSION_TRACE_DIR?.trim() || path.join(os.tmpdir(), "oc-fusion-traces"),
        deadlineMs,
        replayDir,
        repoRoot,
    };
}

/** Identity of the knobs that change the *output*, for the trace and cache key. */
export function fusionConfigSha(config: Pick<FusionConfig, "llm">, extra: Record<string, unknown> = {}): string {
    return shortSha(sha256OfValue({ llm: config.llm, ...extra }));
}
