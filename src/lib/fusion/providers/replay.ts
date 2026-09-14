import fs from "fs";
import path from "path";
import { sha256OfValue } from "../hash.js";
import { sleep, throwIfAborted } from "../deadline.js";
import type { AsrProvider, AudioArtifact, NormalizedWord, ProviderContext, ProviderId, ProviderIdentity, ProviderResult } from "../types.js";
import { ProviderError, ReplayMissError } from "../types.js";
import { normalizeScribeWords } from "./scribe.js";
import { normalizeSonioxTokens } from "./soniox.js";
import { normalizeOcAsrWords } from "./ocasr.js";

/**
 * The fake provider. A replay bundle is a directory of provider-native
 * responses recorded from real runs:
 *
 *   <audio_sha256>.<provider>.json   {"identity": {...}, "raw": <native response>}
 *   schedule.json                     optional, deterministic delays and failures
 *
 * Three rules make it worth trusting:
 *  1. It never touches the network — a test that silently fell through to a
 *     live provider would be a bill and a flake at the same time.
 *  2. A miss is a hard failure, never a fallthrough. If the bundle does not have
 *     this audio, the test is wrong about what it is testing.
 *  3. It runs the *same* normalizers as the live adapters, so a change in how we
 *     read a provider's response shows up in replay tests too.
 */

export type ReplayFailure = "timeout" | "http500" | "malformed";

export interface ReplaySchedule {
    /** Fixed delay for every entry, or per-key delays. Key: "<sha>" or "<sha>.<provider>". */
    delaysMs?: number | Record<string, number>;
    failures?: Record<string, ReplayFailure>;
}

interface ReplayEntry {
    identity: ProviderIdentity;
    raw: unknown;
    /** Optional pre-normalized words; when absent the live normalizer runs on `raw`. */
    words?: NormalizedWord[];
}

const NORMALIZERS: Record<ProviderId, (raw: any) => NormalizedWord[]> = {
    scribe: normalizeScribeWords,
    soniox: normalizeSonioxTokens,
    ours: normalizeOcAsrWords,
};

export class ReplayProvider implements AsrProvider {
    private readonly schedule: ReplaySchedule;

    constructor(readonly id: ProviderId, private readonly bundleDir: string) {
        this.schedule = readSchedule(bundleDir);
    }

    async identify(audio: AudioArtifact): Promise<ProviderIdentity> {
        // Replay keys the cache on the bundle's recorded identity, so a cached
        // live result and a replayed one can never collide.
        return this.readEntry(audio.sha256).identity;
    }

    async transcribe(audio: AudioArtifact, ctx: ProviderContext): Promise<ProviderResult> {
        throwIfAborted(ctx.signal);
        const startedAt = Date.now();

        const failure = this.lookup(this.schedule.failures, audio.sha256);
        const delayMs = this.lookup(
            typeof this.schedule.delaysMs === "number" ? undefined : this.schedule.delaysMs,
            audio.sha256,
        ) ?? (typeof this.schedule.delaysMs === "number" ? this.schedule.delaysMs : 0);

        if (delayMs > 0) {
            await sleep(delayMs, ctx.signal);
        }

        if (failure === "http500") {
            throw new ProviderError(this.id, "replay: scheduled HTTP 500", "http_500");
        }
        if (failure === "timeout") {
            // Deliberately burns the remaining budget on the shared signal, so a
            // timeout test exercises the real deadline path rather than a
            // shortcut that only looks like one.
            await sleep(Math.max(0, ctx.deadlineAt - Date.now()), ctx.signal).catch(() => { });
            throw new ProviderError(this.id, "replay: scheduled timeout", "deadline");
        }

        const entry = this.readEntry(audio.sha256);

        if (failure === "malformed") {
            // The shape the failure matrix cares about: a response that carries
            // text but no usable word stream.
            return {
                providerId: this.id,
                identity: entry.identity,
                raw: { malformed: true },
                rawSha256: sha256OfValue({ malformed: true }),
                words: [],
                elapsedMs: Date.now() - startedAt,
            };
        }

        const words = entry.words ?? NORMALIZERS[this.id](entry.raw);
        return {
            providerId: this.id,
            identity: entry.identity,
            raw: entry.raw,
            rawSha256: sha256OfValue(entry.raw),
            words,
            elapsedMs: Date.now() - startedAt,
        };
    }

    private readEntry(sha: string): ReplayEntry {
        const file = path.join(this.bundleDir, `${sha}.${this.id}.json`);
        try {
            return JSON.parse(fs.readFileSync(file, "utf8")) as ReplayEntry;
        } catch (error) {
            throw new ReplayMissError(
                `replay bundle ${this.bundleDir} has no entry ${sha}.${this.id}.json (${error}). `
                + "Replay never falls back to a live provider.",
            );
        }
    }

    private lookup<T>(table: Record<string, T> | undefined, sha: string): T | undefined {
        if (!table) return undefined;
        return table[`${sha}.${this.id}`] ?? table[sha];
    }
}

function readSchedule(bundleDir: string): ReplaySchedule {
    const file = path.join(bundleDir, "schedule.json");
    try {
        return JSON.parse(fs.readFileSync(file, "utf8")) as ReplaySchedule;
    } catch {
        return {};
    }
}
