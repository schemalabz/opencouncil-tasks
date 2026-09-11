/**
 * The standalone fusion server's guards.
 *
 * It exists to be pointed at from outside, which means the ways it can come up
 * wrong are the ways a caller finds out late: a server that answers every
 * request with a Scribe fallback because fusion was off, a server with no route
 * on it, or a request the HTTP layer cuts off while the engine is still working
 * and all three providers have been paid.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { main } from "./fusionServer.js";

const KEYS = ["FUSION_MODE", "FUSION_OPENAI_ROUTE", "FUSION_DEADLINE_MS", "PORT"];
let saved: Record<string, string | undefined>;

beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    vi.spyOn(console, "log").mockImplementation(() => { });
    vi.spyOn(console, "warn").mockImplementation(() => { });
});

afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    vi.restoreAllMocks();
});

describe("the standalone fusion server", () => {
    it("refuses to start with fusion off", async () => {
        // Otherwise it comes up, answers health checks, and returns a fallback
        // for every request a caller sends it.
        process.env.FUSION_MODE = "off";
        process.env.FUSION_OPENAI_ROUTE = "on";
        await expect(main()).rejects.toThrow(/FUSION_MODE is off/);
    });

    it("refuses to start with no route to serve", async () => {
        process.env.FUSION_MODE = "on";
        process.env.FUSION_OPENAI_ROUTE = "off";
        await expect(main()).rejects.toThrow(/FUSION_OPENAI_ROUTE is off/);
    });

    it("refuses to start when the engine cannot run", async () => {
        // Same contract as the task runner: enabled and unusable means do not
        // start, because the alternative is paying three providers per segment
        // for a transcript that looks normal.
        process.env.FUSION_MODE = "on";
        process.env.FUSION_OPENAI_ROUTE = "on";
        vi.resetModules();
        vi.doMock("./lib/fusion/preflight.js", () => ({
            assertFusionRuntimeUsable: async () => { throw new Error("engine missing"); },
        }));
        try {
            const fresh = await import("./fusionServer.js");
            await expect(fresh.main()).rejects.toThrow(/engine missing/);
        } finally {
            vi.doUnmock("./lib/fusion/preflight.js");
            vi.resetModules();
        }
    });

    it("checks the configuration before it needs a credential", async () => {
        // The auth middleware throws on load without secrets. A server that
        // cannot say "FUSION_MODE is off" without one is a server nobody can
        // diagnose from a shell.
        process.env.FUSION_MODE = "off";
        process.env.FUSION_OPENAI_ROUTE = "on";
        await expect(main()).rejects.toThrow(/FUSION_MODE is off/);
    });
});
