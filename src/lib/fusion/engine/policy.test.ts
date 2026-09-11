/**
 * The frozen routing policy, and that it is still the frozen one.
 *
 * Ported from `tests/fusion/test_policy_routing.py`. The routing assertions
 * that need the 391-window bundle live in the differential lane; what is here
 * is the shape and the hash, which are what stop a policy from drifting into
 * something the measured numbers never described.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { loadPolicy, PolicyError, POLICY_SHA16 } from "./policy.js";

const ENGINE_DIR = path.resolve(__dirname, "../../../../fusion");

describe("the frozen policy", () => {
    const loaded = loadPolicy(ENGINE_DIR);

    it("is the one the measured numbers were produced under", () => {
        expect(POLICY_SHA16).toBe("3e5676d982078979");
    });

    it("has the 21 categories and the 2 that route to an arbiter", () => {
        expect(Object.keys(loaded.policy).length).toBe(21);
        expect(loaded.llmCategories.length).toBe(2);
    });

    it("names a rule for every category it routes to one", () => {
        for (const [cat, entry] of Object.entries(loaded.policy)) {
            expect(["rule", "llm"], cat).toContain(entry.mode);
            if (entry.mode === "rule") {
                expect(typeof entry.rule, `${cat} has mode rule and no rule`).toBe("string");
            }
        }
    });

    it("sorts the arbiter categories by code point, as the Python did", () => {
        expect([...loaded.llmCategories].sort()).toEqual(loaded.llmCategories);
    });

    it("refuses to load a policy whose bytes have changed", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-policy-drift-"));
        try {
            const good = fs.readFileSync(path.join(ENGINE_DIR, "policy.json"), "utf8");
            // One byte of whitespace is enough, and has to be: a policy that
            // reformats is a policy nobody measured.
            fs.writeFileSync(path.join(dir, "policy.json"), good + "\n");
            fs.writeFileSync(path.join(dir, "llm_envelope.json"), "{}");
            expect(() => loadPolicy(dir)).toThrow(PolicyError);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("says what it found when it refuses", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-policy-drift-"));
        try {
            fs.writeFileSync(path.join(dir, "policy.json"), '{"policy":{}}');
            fs.writeFileSync(path.join(dir, "llm_envelope.json"), "{}");
            expect(() => loadPolicy(dir)).toThrow(/expected 3e5676d982078979/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("reports a missing policy as a policy error, not a file error", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-policy-absent-"));
        try {
            expect(() => loadPolicy(dir)).toThrow(PolicyError);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
