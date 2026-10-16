import { describe, it, expect } from "vitest";
import { alignStreams, longestChain, uniqueAnchors } from "./align.js";

const words = (text: string) => text.split(/\s+/).filter(Boolean);
const lorem = (n: number, seed = 1) => Array.from({ length: n }, (_, i) => `λ${(i * 7919 + seed * 104729) % 100003}`);

describe("uniqueAnchors and longestChain", () => {
    it("takes no anchor from a 4-gram that occurs twice on one side", () => {
        const a = words("α β γ δ α β γ δ ε");
        const b = words("α β γ δ ε");
        expect(uniqueAnchors(a, 0, a.length, b, 0, b.length)).toEqual([[5, 1]]);
    });

    it("keeps the 4-grams unique on both sides and chains them in order", () => {
        const a = words("α β γ δ ε ζ η θ ι κ");
        const b = words("ε ζ η θ ι κ α β γ δ");
        const anchors = uniqueAnchors(a, 0, a.length, b, 0, b.length);
        expect(anchors.length).toBeGreaterThan(0);
        const chain = longestChain(anchors);
        for (let i = 1; i < chain.length; i++) {
            expect(chain[i][0]).toBeGreaterThan(chain[i - 1][0]);
            expect(chain[i][1]).toBeGreaterThan(chain[i - 1][1]);
        }
    });
});

describe("alignStreams", () => {
    it("aligns identical streams word for word", () => {
        const a = lorem(500);
        const { aToB, edits, unaligned } = alignStreams(a, [...a]);
        expect([...aToB].every((j, i) => j === i)).toBe(true);
        expect(edits).toEqual([]);
        expect(unaligned).toEqual([]);
    });

    it("reports a substitution, an insertion and a deletion as edits between equal words", () => {
        const a = [...lorem(30), "ρημακης", ...lorem(30, 2), "και", ...lorem(30, 3)];
        const b = [...lorem(30), "δημακης", ...lorem(30, 2), ...lorem(30, 3), "τελος"];
        const { aToB, edits } = alignStreams(a, b);
        expect(aToB[30]).toBe(-1);
        expect(aToB[29]).toBe(29);
        expect(aToB[31]).toBe(31);
        expect(edits).toContainEqual({ aStart: 30, aEnd: 31, bStart: 30, bEnd: 31 });
        expect(edits).toContainEqual({ aStart: 61, aEnd: 62, bStart: 61, bEnd: 61 });
        expect(edits).toContainEqual({ aStart: 92, aEnd: 92, bStart: 91, bEnd: 92 });
    });

    it("never aligns out of order: a reordered passage stays unmatched on one side", () => {
        const p = lorem(300, 1), q = lorem(300, 2), r = lorem(300, 3);
        const a = [...p, ...q, ...r];
        const b = [...p, ...r, ...q];
        const { aToB } = alignStreams(a, b);
        const matched = (from: number, to: number) => [...aToB.slice(from, to)].filter(j => j >= 0).length;
        expect(matched(0, 300)).toBe(300);
        // Of q and r, only one can follow p in order; the other is left alone.
        expect(Math.min(matched(300, 600), matched(600, 900))).toBe(0);
        expect(Math.max(matched(300, 600), matched(600, 900))).toBe(300);
        for (let i = 1; i < a.length; i++) if (aToB[i] >= 0 && aToB[i - 1] >= 0) expect(aToB[i]).toBeGreaterThan(aToB[i - 1]);
    });

    it("copes with repeated 4-grams that are unique nowhere", () => {
        const refrain = words("ναι ναι ναι ναι");
        const a = [...lorem(50, 1), ...refrain, ...lorem(50, 2), ...refrain, ...lorem(50, 3)];
        const b = [...lorem(50, 1), ...refrain, ...lorem(50, 2), ...refrain, ...lorem(50, 3)];
        const { aToB } = alignStreams(a, b);
        expect([...aToB].every((j, i) => j === i)).toBe(true);
    });

    it("leaves an empty side as one edit", () => {
        const a = lorem(10);
        expect(alignStreams(a, []).edits).toEqual([{ aStart: 0, aEnd: 10, bStart: 0, bEnd: 0 }]);
        expect(alignStreams([], a).edits).toEqual([{ aStart: 0, aEnd: 0, bStart: 0, bEnd: 10 }]);
    });

    it("does not trust one chance anchor inside a long gap", () => {
        const k = words("κοινό τετράγραμμο μόνο εδώ");
        const a = [...lorem(2500, 2), ...k, ...lorem(2500, 5)];
        const b = [...lorem(2500, 4), ...k, ...lorem(2500, 6)];
        const { aToB, unaligned } = alignStreams(a, b);
        expect(aToB[2500]).toBe(-1);
        expect(unaligned).toEqual([{ aStart: 0, aEnd: 5004, bStart: 0, bEnd: 5004 }]);
    });

    it("leaves a long lopsided gap unaligned: its words are on one side only", () => {
        const a = [...lorem(20, 1), ...lorem(400, 2), ...lorem(20, 3)];
        const b = [...lorem(20, 1), ...lorem(400, 2).slice(0, 30).reverse(), ...lorem(20, 3)];
        const { unaligned, aToB } = alignStreams(a, b);
        expect(unaligned).toEqual([{ aStart: 20, aEnd: 420, bStart: 20, bEnd: 50 }]);
        expect([...aToB.slice(20, 420)].every(j => j === -1)).toBe(true);
        expect(aToB[420]).toBe(50);
    });

    it("leaves a long gap with no anchors unaligned instead of diffing it", () => {
        const a = [...lorem(20, 1), ...lorem(3000, 2), ...lorem(20, 3)];
        const b = [...lorem(20, 1), ...lorem(3000, 4), ...lorem(20, 3)];
        const { unaligned, aToB } = alignStreams(a, b);
        expect(unaligned).toHaveLength(1);
        expect(aToB[0]).toBe(0);
        expect(aToB[3039]).toBe(3039);
    });
});
