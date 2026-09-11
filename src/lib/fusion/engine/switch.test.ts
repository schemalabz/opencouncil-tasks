/**
 * The engine switch: `FUSION_ENGINE=node` has to run the TypeScript engine, and
 * the two engines have to be separate cache namespaces.
 *
 * The second half matters more than the first. Two engines that agree on every
 * window still must not read each other's cached fused results: the day they
 * stop agreeing is exactly the day nobody would notice, because the entry would
 * be served rather than recomputed.
 *
 * Needs `npm run build`, since the `node` engine spawns the built CLI.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { loadFusionConfig } from "../config.js";
import { createDeadline } from "../deadline.js";
import { fusionEngineRevision, runFusionPython, FUSION_NODE_SCRIPT } from "../fusePy.js";
import { fusionPreflight } from "../preflight.js";
import type { FusionInput } from "../types.js";

const REPO = path.resolve(__dirname, "../../../..");
const FIXTURE = path.join(REPO, "tests/fusion/fixtures_synthetic/tiny_valid.json");

const built = fs.existsSync(path.join(REPO, FUSION_NODE_SCRIPT));
const suite = built ? describe : describe.skip;

suite("the fusion engine switch", () => {
    const input = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as FusionInput;

    it("defaults to the Python", () => {
        expect(loadFusionConfig({ FUSION_MODE: "on" }, REPO).engine).toBe("python");
    });

    it("reads FUSION_ENGINE", () => {
        expect(loadFusionConfig({ FUSION_MODE: "on", FUSION_ENGINE: "node" }, REPO).engine).toBe("node");
    });

    it("rejects an engine nobody implemented rather than falling back", () => {
        expect(() => loadFusionConfig({ FUSION_MODE: "on", FUSION_ENGINE: "rust" }, REPO)).toThrow();
    });

    it("gives the two engines different revisions, and leaves the Python's alone", () => {
        const py = fusionEngineRevision(REPO, "python");
        const ts = fusionEngineRevision(REPO, "node");

        expect(py).not.toBe(ts);
        expect(ts.startsWith("ts-")).toBe(true);
        // Prefixing the Python's revision would have made every fused result
        // already in the cache unaddressable, which is a bill, not a bug fix.
        expect(py.startsWith("ts-")).toBe(false);
        expect(py).not.toBe("absent");
    });

    it("runs the TypeScript engine and gets the Python's answer", async () => {
        const deadline = createDeadline(Date.now() + 60_000);
        const common = { pythonBin: "python3", repoRoot: REPO, signal: deadline.signal, deadlineAt: deadline.deadlineAt };

        const fromPython = await runFusionPython(input, { ...common, engine: "python" });
        const fromNode = await runFusionPython(input, { ...common, engine: "node" });

        expect(fromNode.output).toEqual(fromPython.output);
        deadline.dispose?.();
    }, 120_000);

    it("preflights the engine that will actually serve traffic", async () => {
        const config = loadFusionConfig({ FUSION_MODE: "on", FUSION_ENGINE: "node" }, REPO);
        const result = await fusionPreflight(config);

        expect(result.checked).toBe(true);
        expect(result.problem).toBeUndefined();
        expect(result.ok).toBe(true);
        expect(result.engineRev?.startsWith("ts-")).toBe(true);
    }, 120_000);
});
