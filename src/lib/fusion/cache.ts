import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";
import { canonicalJson, sha256Hex, sha256OfValue } from "./hash.js";
import type { FusionArm, ProviderId, ProviderIdentity } from "./types.js";

/**
 * Two-layer content-addressed cache.
 *
 * Layer 1 (`component`) holds one provider's raw result. Its key is the exact
 * identity of the thing that produced it, so a model or parameter change is a
 * miss rather than a silent substitution.
 *
 * Layer 2 (`fusion`) holds a fused result, keyed by the *word lists* that went
 * in plus every knob that changes the fusion output. Two arms that see the same
 * three word lists therefore share provider calls but not fused results.
 *
 * Rules that come from prior expensive mistakes:
 *  - `createdAt` and `requestId` live inside the record, never in the key.
 *    Otherwise every run is a miss and the benchmark arms stop being paired.
 *  - Failures and partial results are never cached.
 *  - A corrupt entry is quarantined (`.bad`), not repaired and not trusted.
 *  - In-process single-flight: four concurrent arms produce one provider call.
 */

export const CACHE_SCHEMA = "oc-fusion-cache/1";

export type CacheKind = "component" | "fusion";

export interface ComponentKeyParts {
    audioSha256: string;
    providerId: ProviderId;
    identity: ProviderIdentity;
}

export interface FusionKeyParts {
    /** sha256 of each system's normalized word list, in scribe/soniox/ours order. */
    wordListShas: Record<ProviderId, string>;
    normalizerRev: string;
    chunkingRev: string;
    arm: FusionArm;
    guard: boolean;
    policySha: string | null;
    llmEnvelopeSha: string | null;
}

export function componentCacheKey(parts: ComponentKeyParts): string {
    return sha256OfValue({
        audioSha256: parts.audioSha256,
        providerId: parts.providerId,
        model: parts.identity.model,
        paramsSha: parts.identity.paramsSha,
        schemaRev: parts.identity.schemaRev,
    });
}

export function fusionCacheKey(parts: FusionKeyParts): string {
    return sha256OfValue(parts);
}

interface CacheRecord<T> {
    schema: typeof CACHE_SCHEMA;
    kind: CacheKind;
    key: string;
    createdAt: string;
    requestId: string;
    checksum: string;
    payload: T;
}

export interface CacheOutcome<T> {
    value: T;
    /** True when this caller did not run the factory (disk hit or shared in-flight call). */
    cacheHit: boolean;
}

export class FusionCache {
    private readonly inFlight = new Map<string, Promise<unknown>>();

    constructor(private readonly dir: string) { }

    private filePath(kind: CacheKind, key: string): string {
        return path.join(this.dir, kind, key.slice(0, 2), `${key}.json`);
    }

    async read<T>(kind: CacheKind, key: string): Promise<T | undefined> {
        const file = this.filePath(kind, key);
        let text: string;
        try {
            text = await fsp.readFile(file, "utf8");
        } catch {
            return undefined;
        }
        try {
            const record = JSON.parse(text) as CacheRecord<T>;
            if (record.schema !== CACHE_SCHEMA || record.kind !== kind || record.key !== key) {
                throw new Error("schema/kind/key mismatch");
            }
            const checksum = sha256Hex(canonicalJson(record.payload));
            if (checksum !== record.checksum) {
                throw new Error("checksum mismatch");
            }
            return record.payload;
        } catch (error) {
            await this.quarantine(file, error);
            return undefined;
        }
    }

    async write<T>(kind: CacheKind, key: string, payload: T, requestId: string): Promise<void> {
        const record: CacheRecord<T> = {
            schema: CACHE_SCHEMA,
            kind,
            key,
            createdAt: new Date().toISOString(),
            requestId,
            checksum: sha256Hex(canonicalJson(payload)),
            payload,
        };
        const file = this.filePath(kind, key);
        try {
            await fsp.mkdir(path.dirname(file), { recursive: true });
            // Atomic publish: a reader never observes a half-written record.
            const tmp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
            await fsp.writeFile(tmp, JSON.stringify(record), "utf8");
            await fsp.rename(tmp, file);
        } catch (error) {
            // The cache is an optimization, not a source of truth. A read-only
            // or full disk must not fail a transcription.
            console.warn(`[fusion] cache write failed for ${kind}/${key.slice(0, 12)}: ${error}`);
        }
    }

    private async quarantine(file: string, error: unknown): Promise<void> {
        try {
            await fsp.rename(file, `${file}.bad`);
            console.warn(`[fusion] quarantined corrupt cache entry ${path.basename(file)}: ${error}`);
        } catch {
            /* the entry is already gone; nothing to quarantine */
        }
    }

    /**
     * Read-through with in-process single-flight. Concurrent callers with the
     * same key share one factory invocation; a rejected factory is never cached
     * and never poisons the next caller.
     */
    async getOrCreate<T>(kind: CacheKind, key: string, factory: () => Promise<T>, requestId = "unknown"): Promise<CacheOutcome<T>> {
        const cached = await this.read<T>(kind, key);
        if (cached !== undefined) {
            return { value: cached, cacheHit: true };
        }

        const flightKey = `${kind}:${key}`;
        const existing = this.inFlight.get(flightKey);
        if (existing) {
            return { value: (await existing) as T, cacheHit: true };
        }

        const flight = (async () => {
            const value = await factory();
            await this.write(kind, key, value, requestId);
            return value;
        })();
        this.inFlight.set(flightKey, flight);
        try {
            return { value: await flight, cacheHit: false };
        } finally {
            this.inFlight.delete(flightKey);
        }
    }

    /** Test/ops helper: how many entries are currently being produced. */
    get inFlightCount(): number {
        return this.inFlight.size;
    }
}

/** A cache that never persists anything — used when no cache dir is usable. */
export function ensureCacheDir(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
}
