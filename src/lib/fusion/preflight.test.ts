import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { fusionPreflight, assertFusionRuntimeUsable } from "./preflight.js";
import { loadFusionConfig } from "./config.js";

/**
 * The preflight exists because of one measured failure mode: a production image
 * with no Python pays Scribe, Soniox and RunPod for every segment, discards two
 * of the three, and returns a Scribe transcript that looks fine. So the tests
 * are about the cases an existence check would wave through.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

let dir: string;

beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "fusion-preflight-test-"));
    vi.spyOn(console, "log").mockImplementation(() => { });
    vi.spyOn(console, "warn").mockImplementation(() => { });
});

afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
});

const config = (env: Record<string, string>, repoRoot = REPO_ROOT) =>
    loadFusionConfig(env, repoRoot);

describe("fusionPreflight", () => {
    it("probes nothing when fusion is off", async () => {
        // Production's day-one state. An environment that has never heard of
        // fusion must not acquire a Python dependency by being upgraded.
        const result = await fusionPreflight(config({ FUSION_MODE: "off", FUSION_PYTHON_BIN: "/nonexistent/python" }, dir));
        expect(result.checked).toBe(false);
        expect(result.ok).toBe(true);
    });

    it("probes nothing when FUSION_MODE is unset", async () => {
        const result = await fusionPreflight(config({}, dir));
        expect(result.checked).toBe(false);
        expect(result.ok).toBe(true);
    });

    it("runs the real engine and passes", async () => {
        const result = await fusionPreflight(config({ FUSION_MODE: "on" }));
        expect(result.checked).toBe(true);
        expect(result.ok).toBe(true);
        expect(result.engineRev).not.toBe("absent");
        expect(result.problem).toBeUndefined();
    });

    it("probes in shadow mode too, because shadow also spawns the engine", async () => {
        const result = await fusionPreflight(config({ FUSION_MODE: "shadow", FUSION_PYTHON_BIN: "/nonexistent/python3" }));
        expect(result.checked).toBe(true);
        expect(result.ok).toBe(false);
    });

    it("fails when the configured interpreter does not exist", async () => {
        const result = await fusionPreflight(config({ FUSION_MODE: "on", FUSION_PYTHON_BIN: path.join(dir, "no-such-python") }));
        expect(result.ok).toBe(false);
        expect(result.problem).toMatch(/python/i);
    });

    it("fails when fusion/fuse.py is not in the image", async () => {
        // Exactly what the production runner stage produced before this change:
        // dist/ was copied and fusion/ was not.
        const result = await fusionPreflight(config({ FUSION_MODE: "on" }, dir));
        expect(result.ok).toBe(false);
        expect(result.problem).toMatch(/fuse\.py/);
    });

    it("fails, and reports the interpreter's own words, when the engine cannot run", async () => {
        // A Python that is present but too old, or a fusion/ missing a module,
        // both land here — and the message has to say which.
        const fakeRoot = path.join(dir, "fake");
        await fsp.mkdir(path.join(fakeRoot, "fusion"), { recursive: true });
        await fsp.writeFile(
            path.join(fakeRoot, "fusion", "fuse.py"),
            "import sys\nsys.stderr.write('ModuleNotFoundError: no module named islands\\n')\nsys.exit(1)\n",
            "utf8",
        );

        const result = await fusionPreflight(config({ FUSION_MODE: "on" }, fakeRoot));
        expect(result.ok).toBe(false);
        expect(result.problem).toContain("islands");
    });

    it("fails when the engine answers with something that is not the contract", async () => {
        const fakeRoot = path.join(dir, "wrong-schema");
        await fsp.mkdir(path.join(fakeRoot, "fusion"), { recursive: true });
        await fsp.writeFile(
            path.join(fakeRoot, "fusion", "fuse.py"),
            "print('{\"schema\": \"something-else/9\"}')\n",
            "utf8",
        );

        const result = await fusionPreflight(config({ FUSION_MODE: "on" }, fakeRoot));
        expect(result.ok).toBe(false);
        expect(result.problem).toMatch(/schema/);
    });

    it("gives up on an engine that never answers, instead of hanging startup", async () => {
        const fakeRoot = path.join(dir, "hangs");
        await fsp.mkdir(path.join(fakeRoot, "fusion"), { recursive: true });
        await fsp.writeFile(path.join(fakeRoot, "fusion", "fuse.py"), "import time\ntime.sleep(120)\n", "utf8");

        const started = Date.now();
        const result = await fusionPreflight(config({ FUSION_MODE: "on" }, fakeRoot), { timeoutMs: 1_500 });
        expect(result.ok).toBe(false);
        expect(Date.now() - started).toBeLessThan(30_000);
    });
});

describe("assertFusionRuntimeUsable", () => {
    it("throws when fusion is enabled and the engine cannot run", async () => {
        await expect(assertFusionRuntimeUsable(config({ FUSION_MODE: "on" }, dir)))
            .rejects.toThrow(/fuse\.py/);
    });

    it("returns quietly when fusion is off", async () => {
        await expect(assertFusionRuntimeUsable(config({ FUSION_MODE: "off" }, dir))).resolves.toBeUndefined();
    });

    it("returns quietly when the real engine works", async () => {
        await expect(assertFusionRuntimeUsable(config({ FUSION_MODE: "on" }))).resolves.toBeUndefined();
    });
});
