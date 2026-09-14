import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { fusionPreflight, assertFusionRuntimeUsable } from "./preflight.js";
import { loadFusionConfig } from "./config.js";

/**
 * The preflight exists because of one measured failure mode: an image whose
 * engine did not ship pays Scribe, Soniox and RunPod for every segment,
 * discards two of the three, and returns a Scribe transcript that looks fine.
 * So the tests are about the cases an existence check would wave through.
 *
 * The engine is a Node child process now, so a "broken engine" is a script that
 * exits with a message, answers off-contract, or never answers. The failure
 * modes did not change with the language.
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

/** A repo root whose built engine is one line of Node doing something wrong. */
async function fakeEngine(base: string, name: string, body: string): Promise<string> {
    const root = path.join(base, name);
    await fsp.mkdir(path.join(root, "dist/lib/fusion/engine"), { recursive: true });
    await fsp.writeFile(path.join(root, "dist/lib/fusion/engine/cli.js"), body, "utf8");
    return root;
}

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
        const result = await fusionPreflight(config({ FUSION_MODE: "shadow" }, dir));
        expect(result.checked).toBe(true);
        expect(result.ok).toBe(false);
    });

    it("fails when the built engine is not in the image", async () => {
        // Exactly what the production runner stage produced before any of this:
        // some of the build was copied and the engine was not.
        const result = await fusionPreflight(config({ FUSION_MODE: "on" }, dir));
        expect(result.ok).toBe(false);
        expect(result.problem).toMatch(/cli\.js/);
    });

    it("fails, and reports the engine's own words, when it cannot run", async () => {
        // A build missing a module, or an engine that throws on load, both land
        // here, and the message has to say which.
        const fakeRoot = await fakeEngine(dir, "fake",
            "process.stderr.write('Cannot find module islands\\n'); process.exit(1);");

        const result = await fusionPreflight(config({ FUSION_MODE: "on" }, fakeRoot));
        expect(result.ok).toBe(false);
        expect(result.problem).toContain("islands");
    });

    it("fails when the engine answers with something that is not the contract", async () => {
        const fakeRoot = await fakeEngine(dir, "wrong-schema",
            "console.log(JSON.stringify({ schema: 'something-else/9' }));");

        const result = await fusionPreflight(config({ FUSION_MODE: "on" }, fakeRoot));
        expect(result.ok).toBe(false);
        expect(result.problem).toMatch(/schema/);
    });

    it("gives up on an engine that never answers, instead of hanging startup", async () => {
        const fakeRoot = await fakeEngine(dir, "hangs", "setTimeout(() => { }, 120_000);");

        const started = Date.now();
        const result = await fusionPreflight(config({ FUSION_MODE: "on" }, fakeRoot), { timeoutMs: 1_500 });
        expect(result.ok).toBe(false);
        expect(Date.now() - started).toBeLessThan(30_000);
    });
});

describe("assertFusionRuntimeUsable", () => {
    it("throws when fusion is enabled and the engine cannot run", async () => {
        await expect(assertFusionRuntimeUsable(config({ FUSION_MODE: "on" }, dir)))
            .rejects.toThrow(/cli\.js/);
    });

    it("returns quietly when fusion is off", async () => {
        await expect(assertFusionRuntimeUsable(config({ FUSION_MODE: "off" }, dir))).resolves.toBeUndefined();
    });

    it("returns quietly when the real engine works", async () => {
        await expect(assertFusionRuntimeUsable(config({ FUSION_MODE: "on" }))).resolves.toBeUndefined();
    });
});
