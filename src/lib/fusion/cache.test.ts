import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { FusionCache, componentCacheKey } from "./cache.js";
import type { ProviderIdentity } from "./types.js";

const identity: ProviderIdentity = { model: "scribe_v2", paramsSha: "aaaa", schemaRev: "scribe-words/1" };

let dir: string;
let cache: FusionCache;

beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "fusion-cache-test-"));
    cache = new FusionCache(dir);
    vi.spyOn(console, "warn").mockImplementation(() => { });
});

afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
});

describe("component cache keys", () => {
    it("changes when any part of the provider identity changes", () => {
        const base = { audioSha256: "abc", providerId: "scribe" as const, identity };
        const key = componentCacheKey(base);
        expect(componentCacheKey({ ...base, identity: { ...identity, paramsSha: "bbbb" } })).not.toBe(key);
        expect(componentCacheKey({ ...base, identity: { ...identity, model: "scribe_v3" } })).not.toBe(key);
        expect(componentCacheKey({ ...base, identity: { ...identity, schemaRev: "scribe-words/2" } })).not.toBe(key);
        expect(componentCacheKey({ ...base, audioSha256: "abd" })).not.toBe(key);
    });

    it("does not depend on property order", () => {
        const a = componentCacheKey({ audioSha256: "abc", providerId: "scribe", identity });
        const b = componentCacheKey({
            identity: { schemaRev: identity.schemaRev, paramsSha: identity.paramsSha, model: identity.model },
            providerId: "scribe",
            audioSha256: "abc",
        });
        expect(a).toBe(b);
    });
});

describe("FusionCache", () => {
    it("runs one provider call for four concurrent arms with the same key", async () => {
        const factory = vi.fn(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return { words: ["ένα"] };
        });
        const key = componentCacheKey({ audioSha256: "abc", providerId: "scribe", identity });

        const results = await Promise.all(
            [1, 2, 3, 4].map(() => cache.getOrCreate("component", key, factory)),
        );

        expect(factory).toHaveBeenCalledTimes(1);
        expect(results.map((r) => r.value)).toEqual(Array(4).fill({ words: ["ένα"] }));
        expect(results.filter((r) => !r.cacheHit)).toHaveLength(1);
    });

    it("misses when the params sha differs", async () => {
        const factory = vi.fn(async () => ({ ok: true }));
        await cache.getOrCreate("component", componentCacheKey({ audioSha256: "abc", providerId: "scribe", identity }), factory);
        await cache.getOrCreate("component", componentCacheKey({
            audioSha256: "abc", providerId: "scribe", identity: { ...identity, paramsSha: "different" },
        }), factory);
        expect(factory).toHaveBeenCalledTimes(2);
    });

    it("serves a second caller from disk", async () => {
        const factory = vi.fn(async () => ({ ok: true }));
        const key = componentCacheKey({ audioSha256: "abc", providerId: "scribe", identity });
        await cache.getOrCreate("component", key, factory);
        const second = await cache.getOrCreate("component", key, factory);
        expect(factory).toHaveBeenCalledTimes(1);
        expect(second.cacheHit).toBe(true);
    });

    it("never caches a failure", async () => {
        const key = componentCacheKey({ audioSha256: "abc", providerId: "soniox", identity });
        await expect(cache.getOrCreate("component", key, async () => { throw new Error("provider down"); }))
            .rejects.toThrow("provider down");
        const factory = vi.fn(async () => ({ ok: true }));
        await cache.getOrCreate("component", key, factory);
        expect(factory).toHaveBeenCalledTimes(1);
    });

    it("quarantines a corrupt entry instead of trusting it", async () => {
        const key = componentCacheKey({ audioSha256: "abc", providerId: "ours", identity });
        await cache.getOrCreate("component", key, async () => ({ words: ["σωστό"] }));

        const file = path.join(dir, "component", key.slice(0, 2), `${key}.json`);
        const record = JSON.parse(fs.readFileSync(file, "utf8"));
        record.payload = { words: ["πειραγμένο"] }; // checksum no longer matches
        fs.writeFileSync(file, JSON.stringify(record));

        const factory = vi.fn(async () => ({ words: ["ξανά"] }));
        const result = await cache.getOrCreate("component", key, factory);

        expect(factory).toHaveBeenCalledTimes(1);
        expect(result.value).toEqual({ words: ["ξανά"] });
        expect(fs.existsSync(`${file}.bad`)).toBe(true);
    });

    it("keeps createdAt and requestId inside the record, out of the key", async () => {
        const key = componentCacheKey({ audioSha256: "abc", providerId: "scribe", identity });
        await cache.getOrCreate("component", key, async () => ({ ok: true }), "request-1");
        const file = path.join(dir, "component", key.slice(0, 2), `${key}.json`);
        const record = JSON.parse(fs.readFileSync(file, "utf8"));
        expect(record.requestId).toBe("request-1");
        expect(record.createdAt).toBeTypeOf("string");
        expect(key).not.toContain("request-1");
    });
});
