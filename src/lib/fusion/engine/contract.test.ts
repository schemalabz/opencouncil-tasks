/**
 * The `oc-fusion-in/1` -> `oc-fusion/1` contract, on synthetic input.
 *
 * Ported from `tests/fusion/test_fuse_contract.py`. These assert the contract
 * directly rather than comparing to a reference, which is the half the
 * differential suite cannot do: agreement with the Python on 391 windows says
 * nothing about a field that is wrong in both, about inputs the corpus does not
 * contain, or about behaviour on malformed input.
 *
 * No fixture bundle, no transcript text, so unlike the differential suite these
 * run everywhere.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { fuse, InputError } from "./fuse.js";
import { loadPolicy, PolicyError, POLICY_SHA16 } from "./policy.js";

const REPO = path.resolve(__dirname, "../../../..");
const SYN = path.join(REPO, "tests/fusion/fixtures_synthetic");
const ENGINE_DIR = path.join(REPO, "fusion");
const CLI = path.join(REPO, "dist/lib/fusion/engine/cli.js");

const STAGES = new Set(["agree", "rule", "llm"]);
const AGREEMENTS = new Set([1.0, 0.67, 0.33]);
const TOKEN_KEYS = ["agreement", "alternatives", "col", "i", "island", "norm", "src", "src_word", "stage", "text"];
const ISLAND_KEYS = ["candidates", "category", "chosen_src", "cols", "guard_fired", "id", "llm", "rule", "stage"];

const policy = loadPolicy(ENGINE_DIR);
const load = (name: string) => JSON.parse(fs.readFileSync(path.join(SYN, `${name}.json`), "utf8"));
const run = (input: string) => spawnSync(process.execPath, [CLI], { input, cwd: REPO, encoding: "utf8" });

describe("the engine contract", () => {
    afterEach(() => vi.restoreAllMocks());

    describe("the process boundary", () => {
        const built = fs.existsSync(CLI);
        const when = built ? it : it.skip;

        it.each(["malformed_missing_system", "malformed_bad_schema", "malformed_bad_order"])(
            "%s exits 2 with one JSON line on stderr and nothing on stdout",
            (name) => {
                if (!built) return;
                const p = run(fs.readFileSync(path.join(SYN, `${name}.json`), "utf8"));
                expect(p.status, p.stderr).toBe(2);
                expect(p.stdout).toBe("");
                const lines = p.stderr.trim().split("\n");
                expect(lines.length, p.stderr).toBe(1);
                expect(JSON.parse(lines[0]).error).toBeTruthy();
            },
        );

        when("exits 2 on input that is not JSON at all", () => {
            const p = run("{not json");
            expect(p.status).toBe(2);
            expect(JSON.parse(p.stderr.trim()).error).toBeTruthy();
        });

        when("keeps diagnostics off stdout on success", () => {
            const p = run(fs.readFileSync(path.join(SYN, "tiny_valid.json"), "utf8"));
            expect(p.status, p.stderr).toBe(0);
            expect(p.stderr).toBe("");
            expect(JSON.parse(p.stdout).schema).toBe("oc-fusion/1");
        });
    });

    it("answers a valid tiny input with a schema-valid document", () => {
        const out = fuse(load("tiny_valid"), policy);

        expect(out.schema).toBe("oc-fusion/1");
        expect(out.audio_sha256).toBe("a".repeat(64));

        const cfg = out.config;
        for (const k of ["arm", "guard", "policy_sha", "llm_envelope_sha", "code_rev",
            "normalizer_rev", "chunking", "components"]) {
            expect(cfg, k).toHaveProperty(k);
        }
        expect(cfg.policy_sha).toBe(POLICY_SHA16);
        expect(cfg.llm_envelope_sha).toBeNull();
        expect(cfg.components).toEqual({ scribe: "p-scribe", soniox: "p-soniox", ours: "p-ours" });
        for (const k of ["rev", "max_tokens", "anchor_n", "search_radius", "n_chunks", "forced_cuts", "seams"]) {
            expect(cfg.chunking, k).toHaveProperty(k);
        }

        out.tokens.forEach((t, n) => {
            expect(Object.keys(t).sort()).toEqual(TOKEN_KEYS);
            expect(t.i).toBe(n);
            expect(STAGES.has(t.stage as string)).toBe(true);
            expect(AGREEMENTS.has(t.agreement as number)).toBe(true);
            expect(["scribe", "soniox", "ours"]).toContain(t.src);
            expect(Number.isInteger(t.src_word)).toBe(true);
            if (t.stage === "agree") {
                expect(t.alternatives).toBeNull();
                expect(t.island).toBeNull();
            } else {
                expect(t.alternatives).not.toBeNull();
                expect(t.island).not.toBeNull();
            }
        });

        for (const i of out.islands) {
            expect(Object.keys(i).sort()).toEqual(ISLAND_KEYS);
            expect(Object.keys(i.candidates as object).sort())
                .toEqual(["ours", "r12", "scribe", "soniox", "vote"]);
            expect(STAGES.has(i.stage as string)).toBe(true);
        }

        // Accounting identities: the statistics have to describe the document
        // they are attached to, which no comparison against a reference checks.
        const st = out.stats as Record<string, never>;
        expect(st.n_tokens).toBe(out.tokens.length);
        expect(st.n_islands).toBe(out.islands.length);
        const byStage = st.by_stage as Record<string, number>;
        for (const k of ["agree", "rule", "llm"]) expect(byStage).toHaveProperty(k);
        expect(Object.values(byStage).reduce((a, b) => a + b, 0)).toBe(st.n_tokens);
    });

    it("fires the guard, and records what it would otherwise have deleted", () => {
        const payload = load("guard_island");
        const on = fuse(payload, policy);
        const off = fuse({ ...payload, config: { ...payload.config, guard: false } }, policy);

        expect(on.stats.guard_fired).toBe(1);
        expect(off.stats.guard_fired).toBe(0);
        expect(on.tokens.map((t) => t.norm)).toContain("δεν");
        expect(off.tokens.map((t) => t.norm)).not.toContain("δεν");
        expect(on.islands[0].guard_fired).toBe(true);
        expect(on.islands[0].chosen_src).toBe("soniox");

        // With the guard off the island is deleted outright, and a deletion
        // that goes unrecorded is the failure mode this project watches.
        expect(off.dropped.length).toBeGreaterThan(0);
        expect(off.dropped[0].src).toBe("soniox");
        expect(off.dropped[0].text).toBe("δεν");
    });

    it("answers an empty document for empty systems", () => {
        const out = fuse(load("empty_systems"), policy);
        expect(out.tokens).toEqual([]);
        expect(out.islands).toEqual([]);
        expect(out.stats.n_tokens).toBe(0);
        expect([0, 1]).toContain((out.config.chunking as Record<string, number>).n_chunks);
    });

    it("fuses two systems when the third said nothing", () => {
        const out = fuse(load("one_empty"), policy);
        expect(out.tokens.map((t) => t.norm)).toEqual(["αλφα", "βητα", "γαμμα"]);
        expect((out.islands[0].candidates as Record<string, string[]>).ours).toEqual([]);
        for (const t of out.tokens) expect(["scribe", "soniox"]).toContain(t.src);
    });

    it("points src_word at the input word the text came from", () => {
        const payload = load("tiny_valid");
        const out = fuse(payload, policy);
        const byId: Record<string, { raw: string }[]> = Object.fromEntries(
            payload.systems.map((s: { id: string; words: { raw: string }[] }) => [s.id, s.words]),
        );
        for (const t of out.tokens) {
            expect(byId[t.src as string][t.src_word as number].raw).toBe(t.text);
        }
    });

    it("keeps provenance when one raw word normalizes to several tokens", () => {
        // The documented behaviour the transcript assembly de-duplicates on: a
        // run of tokens sharing (src, src_word) is one raw word.
        const ws = (xs: string[]) => xs.map((x, i) => ({ raw: x, start: i, end: i + 0.4, conf: 0.9 }));
        const payload = {
            schema: "oc-fusion-in/1",
            audio_sha256: null,
            systems: ["scribe", "soniox", "ours"].map((s) => ({
                id: s, params_sha: null, words: ws(["αλφα", "βητα-γαμμα", "δελτα"]),
            })),
            config: { arm: "rules", guard: false },
        };
        const out = fuse(payload, policy);

        expect(out.tokens.map((t) => t.norm)).toEqual(["αλφα", "βητα", "γαμμα", "δελτα"]);
        expect(out.tokens.map((t) => t.src_word)).toEqual([0, 1, 1, 2]);
        expect(out.tokens[1].text).toBe("βητα-γαμμα");
        expect(out.tokens[2].text).toBe("βητα-γαμμα");
    });

    it("touches no network", () => {
        // The engine has no network code left in it at all, and this is what
        // keeps that true: a fuse that reaches for the wire is a fuse that can
        // hang, bill, or leak a transcript.
        const reached = vi.fn(() => { throw new Error("network touched"); });
        vi.stubGlobal("fetch", reached);
        fuse(load("tiny_valid"), policy);
        fuse({ ...load("tiny_valid"), config: { arm: "policy", guard: false } }, policy);
        expect(reached).not.toHaveBeenCalled();
        vi.unstubAllGlobals();
    });

    it("refuses a policy that has drifted from the frozen one", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-bad-policy-"));
        try {
            fs.writeFileSync(path.join(dir, "policy.json"), '{"policy": {}}');
            fs.writeFileSync(path.join(dir, "llm_envelope.json"), "{}");
            expect(() => loadPolicy(dir)).toThrow(PolicyError);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("rejects a malformed payload with InputError rather than a partial answer", () => {
        expect(() => fuse(load("malformed_bad_order"), policy)).toThrow(InputError);
        expect(() => fuse(load("malformed_bad_schema"), policy)).toThrow(InputError);
        expect(() => fuse(load("malformed_missing_system"), policy)).toThrow(InputError);
    });
});

