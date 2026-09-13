/**
 * What chunking guarantees, on inputs built to break it.
 *
 * Ported from `tests/fusion/test_chunking.py`. These are invariants, not
 * comparisons: the 391-window corpus exercises the chunker on text that happens
 * to exist, and says nothing about a stream with no anchor anywhere, a stream
 * built from one repeated phrase, or a stream ten times longer than the others.
 * Each of those has already been a bug here.
 *
 * The `ΔWER` measurement that decides whether chunking is affordable needs the
 * fixture bundle and lives in `chunking.differential.test.ts`.
 */
import { describe, it, expect } from "vitest";
import path from "path";
import { chunkConfigFrom, planChunks, DEFAULT_CHUNK_CONFIG } from "./chunking.js";
import { fuse } from "./fuse.js";
import { loadPolicy } from "./policy.js";

const policy = loadPolicy(path.resolve(__dirname, "../../../../fusion"));

const cfg = (over: Record<string, unknown>) => chunkConfigFrom(over);

function payloadFor(streams: readonly (readonly string[])[], chunking: Record<string, unknown>) {
    const ids = ["scribe", "soniox", "ours"];
    return {
        schema: "oc-fusion-in/1",
        audio_sha256: "0".repeat(64),
        systems: [0, 1, 2].map((k) => ({
            id: ids[k],
            params_sha: `sha-${ids[k]}`,
            words: streams[k].map((t, i) => ({ raw: t, start: i * 0.5, end: i * 0.5 + 0.4, conf: 0.9 })),
        })),
        config: { arm: "rules", guard: false, llm: null, chunking },
    };
}

const normOf = (out: { tokens: Record<string, unknown>[] }) => out.tokens.map((t) => t.norm);

describe("chunking", () => {
    it("tiles each stream exactly once when every cut is forced", () => {
        // Three streams sharing no n-gram anywhere: the anchor search can never
        // succeed, so this is the forced path end to end.
        const a = Array.from({ length: 300 }, (_, i) => `a${i}`);
        const b = Array.from({ length: 300 }, (_, i) => `b${i}`);
        const c = Array.from({ length: 300 }, (_, i) => `c${i}`);
        const { chunks, forced } = planChunks([a, b, c], cfg({ max_tokens: 50 }));

        expect(forced).toBe(chunks.length - 1);
        expect(forced).toBeGreaterThan(0);

        for (let k = 0; k < 3; k++) {
            let pos = 0;
            for (const ch of chunks) {
                expect(ch[k][0]).toBe(pos);
                pos = ch[k][1];
            }
            expect(pos).toBe(300);
        }
    });

    it("gives the same answer twice on the forced path", () => {
        const a = Array.from({ length: 300 }, (_, i) => `a${i}`);
        const b = Array.from({ length: 300 }, (_, i) => `b${i}`);
        const c = Array.from({ length: 300 }, (_, i) => `c${i}`);
        const chunking = { max_tokens: 50, anchor_n: 3, search_radius: 200 };
        const { chunks, forced } = planChunks([a, b, c], cfg(chunking));

        const p = payloadFor([a, b, c], chunking);
        const first = fuse(p, policy);
        const second = fuse(p, policy);

        expect(normOf(first)).toEqual(normOf(second));
        const echoed = first.config.chunking as Record<string, unknown>;
        expect(echoed.forced_cuts).toBe(forced);
        expect(echoed.n_chunks).toBe(chunks.length);
        expect((echoed.seams as number[]).length).toBe(chunks.length - 1);
    });

    it("refuses an n-gram that occurs more than once as an anchor", () => {
        // One phrase repeated forever: nothing occurs exactly once in any
        // neighbourhood, so accepting any of it as an anchor would be cutting
        // at a place the three streams do not actually share.
        const phrase = ["και", "το", "θεμα"];
        const stream = Array.from({ length: 200 }, () => phrase).flat();
        const { chunks, forced } = planChunks([stream, [...stream], [...stream]],
            cfg({ max_tokens: 100, anchor_n: 3, search_radius: 200 }));

        expect(forced, "an ambiguous n-gram was accepted as an anchor")
            .toBe(chunks.length - 1);
    });

    it("leaves a found anchor at the start of the following chunk", () => {
        const left = Array.from({ length: 300 }, (_, i) => `L${i}`);
        const anchor = ["ξεχωριστη", "μοναδικη", "φρασηδω"];
        const right = Array.from({ length: 300 }, (_, i) => `R${i}`);
        const a = [...left, ...anchor, ...right];
        const mark = (suffix: string) => a.map((t) => (/^[LR]/.test(t) ? t + suffix : t));

        const { chunks, forced } = planChunks([a, mark("x"), mark("y")],
            cfg({ max_tokens: 400, anchor_n: 3, search_radius: 200 }));

        expect(forced, "a unique unanimous anchor was not found").toBe(0);
        const cut = chunks[0][0][1];
        expect(a.slice(cut, cut + 3), "the anchor did not start the next chunk").toEqual(anchor);
    });

    it("rejects a configuration that cannot work", () => {
        expect(() => cfg({ max_tokens: 0 })).toThrow();
        expect(() => cfg({ anchor_n: 0 })).toThrow();
        expect(() => cfg({ search_radius: -1 })).toThrow();
        expect(() => cfg({ nonsense: 1 })).toThrow();
    });

    it("ignores the fields the engine echoes back into its own config", () => {
        // The output carries the effective config plus what happened, and that
        // whole object gets handed back on the next call.
        const c = cfg({ rev: "chunk/1", max_tokens: 120, n_chunks: 3, forced_cuts: 1, seams: [7] });
        expect(c.max_tokens).toBe(120);
        expect(c.rev).toBe(DEFAULT_CHUNK_CONFIG.rev);
    });

    it("caps every stream, not just the one the cut is measured on", () => {
        // The aligner allocates on the longest of the three spans, so a cap on
        // scribe's side alone does not bound the memory. A stream that runs ten
        // times longer -- a verbose system, or one that did not stop when the
        // others did -- used to be handed a proportional cut far past the cap.
        const c = cfg({ max_tokens: 120, anchor_n: 3, search_radius: 200 });
        const streams = [
            Array.from({ length: 60 }, (_, i) => `α${i}`),
            Array.from({ length: 600 }, (_, i) => `β${i}`),
            Array.from({ length: 60 }, (_, i) => `γ${i}`),
        ];
        const { chunks } = planChunks(streams, c);

        for (const chunk of chunks) {
            for (let k = 0; k < 3; k++) {
                const [start, end] = chunk[k];
                expect(end - start, `stream ${k} span`).toBeLessThanOrEqual(c.max_tokens);
            }
        }

        for (let k = 0; k < 3; k++) {
            const spans = chunks.map((ch) => ch[k]);
            expect(spans[0][0]).toBe(0);
            expect(spans[spans.length - 1][1]).toBe(streams[k].length);
            for (let i = 0; i + 1 < spans.length; i++) {
                expect(spans[i][1]).toBe(spans[i + 1][0]);
            }
        }
    });

    it("terminates on input that makes no progress in two of three streams", () => {
        // One stream long, two empty. A cut that advances nothing would loop.
        const { chunks } = planChunks(
            [Array.from({ length: 500 }, (_, i) => `x${i}`), [], []],
            cfg({ max_tokens: 50 }),
        );
        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks[chunks.length - 1][0][1]).toBe(500);
    });

    it("emits a single chunk for input that already fits", () => {
        const short = Array.from({ length: 10 }, (_, i) => `w${i}`);
        const { chunks, forced } = planChunks([short, short, short], cfg({ max_tokens: 800 }));
        expect(chunks.length).toBe(1);
        expect(forced).toBe(0);
        expect(chunks[0]).toEqual([[0, 10], [0, 10], [0, 10]]);
    });

    it("emits a single empty chunk for three empty streams", () => {
        const { chunks, forced } = planChunks([[], [], []], cfg({ max_tokens: 800 }));
        expect(chunks).toEqual([[[0, 0], [0, 0], [0, 0]]]);
        expect(forced).toBe(0);
    });
});
