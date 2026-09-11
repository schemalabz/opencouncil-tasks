/**
 * The engine CLI against `fusion/fuse.py`, through both real processes.
 *
 * The differential suite proves the two engines agree on the corpus; this
 * proves the process contract around them agrees too: exit codes, the one-line
 * JSON error on stderr, and stdout that parses to the same document.
 *
 * stderr is compared byte for byte. stdout is compared as parsed JSON, because
 * Python knows `agreement` is a float and writes `1.0` where JavaScript, which
 * has one number type, writes `1`. They are the same JSON number, every
 * consumer parses before reading, and tagging floats through the whole engine
 * to win a cosmetic byte match would be a poor trade.
 *
 * Uses the built `dist/` output, so it runs after `npm run build`.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

const REPO = path.resolve(__dirname, "../../../..");
const FIXTURES = path.join(REPO, "tests/fusion/fixtures_synthetic");
const CLI = path.join(REPO, "dist/lib/fusion/engine/cli.js");

interface Run { code: number; stdout: string; stderr: string }

function run(cmd: string, args: string[], input: Buffer): Run {
    try {
        const stdout = execFileSync(cmd, args, { input, cwd: REPO, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
        return { code: 0, stdout, stderr: "" };
    } catch (e) {
        const err = e as { status: number | null; stdout?: string; stderr?: string };
        return { code: err.status ?? -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
}

/** `execFileSync` hides stderr on success, so a second pass captures it. */
function runCapturing(cmd: string, args: string[], input: Buffer): Run {
    const r = run(cmd, args, input);
    if (r.code !== 0) return r;
    const proc = require("child_process").spawnSync(cmd, args, { input, cwd: REPO, encoding: "utf8" });
    return { code: proc.status ?? -1, stdout: proc.stdout, stderr: proc.stderr };
}

const VALID = ["tiny_valid", "guard_island", "one_empty", "empty_systems"];
const MALFORMED = ["malformed_bad_schema", "malformed_bad_order", "malformed_missing_system"];

const built = fs.existsSync(CLI);
const suite = built ? describe : describe.skip;

suite("the engine CLI matches fuse.py through the process boundary", () => {
    const cases = [...VALID, ...MALFORMED].map((name) =>
        [name, fs.readFileSync(path.join(FIXTURES, `${name}.json`))] as const);

    it.each(cases)("%s: same exit code and stderr, same parsed stdout", (name, input) => {
        const py = runCapturing("python3", ["fusion/fuse.py"], input);
        const ts = runCapturing(process.execPath, [CLI], input);

        expect(ts.code, `${name}: exit code`).toBe(py.code);
        expect(ts.stderr, `${name}: stderr`).toBe(py.stderr);

        if (py.code === 0) {
            expect(JSON.parse(ts.stdout), `${name}: stdout`).toEqual(JSON.parse(py.stdout));
        } else {
            expect(ts.stdout, `${name}: stdout on failure`).toBe("");
        }
    });

    it("rejects the LLM arm instead of quietly serving another one", () => {
        const input = JSON.parse(fs.readFileSync(path.join(FIXTURES, "tiny_valid.json"), "utf8"));
        input.config = { ...(input.config ?? {}), arm: "policy", llm: { model: "whatever" } };
        const ts = runCapturing(process.execPath, [CLI], Buffer.from(JSON.stringify(input)));

        expect(ts.code).toBe(2);
        expect(ts.stdout).toBe("");
        expect(JSON.parse(ts.stderr).detail).toMatch(/route this request to the Python engine/);
    });
});
