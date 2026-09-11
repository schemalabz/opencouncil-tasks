import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { createFusionRuntime } from "./index.js";
import { loadFusionConfig } from "./config.js";

/**
 * Composition-root wiring. An optional dependency that nothing constructs is
 * indistinguishable from a feature that was never shipped, so this asserts the
 * env var actually reaches the transcriber.
 */

let dir: string;

beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "fusion-runtime-test-"));
    vi.spyOn(console, "log").mockImplementation(() => { });
});

afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
});

describe("createFusionRuntime", () => {
    it("builds an enabled raw transcript log when FUSION_RAW_LOG_DIR is set", () => {
        const rt = createFusionRuntime(loadFusionConfig({
            FUSION_MODE: "on",
            FUSION_RAW_LOG_DIR: path.join(dir, "raw"),
        }, dir));

        expect(rt.config.rawLogDir).toBe(path.join(dir, "raw"));
        expect(rt.rawLog.enabled).toBe(true);
    });

    it("leaves the raw transcript log off when the variable is unset", () => {
        const rt = createFusionRuntime(loadFusionConfig({ FUSION_MODE: "on" }, dir));
        expect(rt.config.rawLogDir).toBeUndefined();
        expect(rt.rawLog.enabled).toBe(false);
    });

    // The mode transcribe.ts acts on comes from the startup config and nothing
    // else. A second source of truth for "is fusion on" is how a deployment ends
    // up in a mode nobody configured.
    it("reports the startup mode and canary percent as the effective ones", () => {
        const rt = createFusionRuntime(loadFusionConfig({
            FUSION_MODE: "shadow",
            FUSION_CANARY_PERCENT: "25",
        }, dir));

        expect(rt.effectiveMode()).toBe("shadow");
        expect(rt.effectiveCanaryPercent()).toBe(25);
    });

    it("is off with nothing configured", () => {
        const rt = createFusionRuntime(loadFusionConfig({}, dir));
        expect(rt.effectiveMode()).toBe("off");
        expect(rt.effectiveCanaryPercent()).toBe(0);
    });

    it("hands the same log to every transcriber it builds", () => {
        const rt = createFusionRuntime(loadFusionConfig({
            FUSION_MODE: "on",
            FUSION_RAW_LOG_DIR: path.join(dir, "raw"),
        }, dir));

        // Two languages, two provider sets, one log — otherwise a multilingual
        // deployment would keep half its evidence.
        expect((rt.transcriberFor("el") as any).deps.rawLog).toBe(rt.rawLog);
        expect((rt.transcriberFor("fr") as any).deps.rawLog).toBe(rt.rawLog);
    });
});
