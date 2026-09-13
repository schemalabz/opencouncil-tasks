/**
 * The engine CLI against what the Python answered, through the real process.
 *
 * This used to spawn `python3 fusion/fuse.py` alongside the Node engine and
 * compare the two live. The Python is gone, so its answers are pinned instead:
 * `tests/fusion/fixtures_synthetic/EXPECTED_python.json` holds the exit code,
 * the stderr byte for byte, and the parsed stdout it produced for every
 * synthetic fixture, recorded from CPython 3.14.6 before deletion.
 *
 * A pinned answer is weaker evidence than a live one and stronger than nothing:
 * it cannot notice that the Python would now answer differently, which is fine,
 * because the Python it was recorded from is a tagged commit that cannot change.
 * `docs/fusion-python-archive.md` says how to get it back.
 *
 * stderr is compared byte for byte. stdout is compared as parsed JSON, because
 * Python knew `agreement` was a float and wrote `1.0` where JavaScript, with
 * one number type, writes `1`. Both parse to the same number.
 *
 * Uses the built `dist/` output, so it runs after `npm run build`.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";

const REPO = path.resolve(__dirname, "../../../..");
const SYN = path.join(REPO, "tests/fusion/fixtures_synthetic");
const CLI = path.join(REPO, "dist/lib/fusion/engine/cli.js");
const EXPECTED = path.join(SYN, "EXPECTED_python.json");

interface Case { code: number; stderr: string; stdout: unknown }

const built = fs.existsSync(CLI);
const suite = built ? describe : describe.skip;

suite("the engine CLI answers what the Python answered", () => {
    const pinned: { python: string; cases: Record<string, Case> } =
        JSON.parse(fs.readFileSync(EXPECTED, "utf8"));

    const run = (input: Buffer | string) =>
        spawnSync(process.execPath, [CLI], { input, cwd: REPO, encoding: "utf8" });

    it("was recorded from the interpreter the archive names", () => {
        expect(pinned.python).toBe("3.14.6");
    });

    const fixtures = Object.keys(pinned.cases).filter((n) => !n.startsWith("__"));

    it.each(fixtures)("%s: same exit code, same stderr, same parsed stdout", (name) => {
        const want = pinned.cases[name];
        const got = run(fs.readFileSync(path.join(SYN, `${name}.json`)));

        expect(got.status, `${name}: exit code`).toBe(want.code);
        expect(got.stderr, `${name}: stderr`).toBe(want.stderr);

        if (want.code === 0) {
            expect(JSON.parse(got.stdout), `${name}: stdout`).toEqual(want.stdout);
        } else {
            expect(got.stdout, `${name}: stdout on failure`).toBe("");
        }
    });

    it("exits 2 on input that is not JSON at all", () => {
        // The one place the stderr cannot match byte for byte, and should not:
        // `detail` carries the parser's own words, and V8 does not describe a
        // broken document the way CPython does. The contract is the exit code
        // and the `error` field; the detail is for whoever is reading the log.
        const want = pinned.cases.__invalid_json__;
        const got = run("{not json");

        expect(got.status).toBe(want.code);
        expect(got.stdout).toBe("");
        const mine = JSON.parse(got.stderr);
        expect(mine.error).toBe(JSON.parse(want.stderr).error);
        expect(typeof mine.detail).toBe("string");
        expect(mine.detail.length).toBeGreaterThan(0);
    });

    it("rejects the retired LLM arm instead of quietly serving another one", () => {
        const input = JSON.parse(fs.readFileSync(path.join(SYN, "tiny_valid.json"), "utf8"));
        input.config = { ...(input.config ?? {}), arm: "policy", llm: { model: "whatever" } };
        const got = run(Buffer.from(JSON.stringify(input)));

        expect(got.status).toBe(2);
        expect(got.stdout).toBe("");
        expect(JSON.parse(got.stderr).error).toBeTruthy();
    });
});
