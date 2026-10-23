import { describe, it, expect } from "vitest";
import { matchMinutes, passesGate, type TimedUtterance, type TurnMatch } from "./matching.js";
import type { Turn } from "./turns.js";

const turn = (index: number, label: string, text: string): Turn => ({ index, label, key: label.toLowerCase(), page: 3, offset: index * 1000, text, stageDirections: 0 });
const utterance = (i: number, text: string): TimedUtterance => ({ utteranceId: `u${i}`, text, start: i * 10, end: i * 10 + 9, speakerTagId: "tag-1", speakerId: null });
const filler = (n: number, seed: number) => Array.from({ length: n }, (_, i) => `λέξη${(i * 31 + seed * 17) % 997}`).join(" ");

describe("matchMinutes", () => {
    it("counts an utterance split across two turns in both, each for its words", () => {
        const turns = [turn(0, "ΠΡΟΕΔΡΟΣ", `${filler(30, 1)} ${filler(5, 2)}`), turn(1, "ΔΗΜΑΡΧΟΣ", filler(15, 3))];
        const m = matchMinutes(turns, [utterance(0, filler(30, 1)), utterance(1, `${filler(5, 2)} ${filler(15, 3)}`)]);
        expect([...m.utterances[1].byTurn]).toEqual([[0, 5], [1, 15]]);
        expect(m.utterances[1]).toMatchObject({ tokens: 20, matched: 20 });
        expect(m.turns.map(t => t.matchRate)).toEqual([1, 1]);
    });

    it("gives an empty turn a match rate of 0, and it never passes the gate", () => {
        const turns = [turn(0, "ΠΡΟΕΔΡΟΣ", filler(20, 1)), turn(1, "ΔΗΜΑΡΧΟΣ", ""), turn(2, "ΠΡΟΕΔΡΟΣ", filler(20, 2))];
        const m = matchMinutes(turns, [utterance(0, `${filler(20, 1)} ${filler(20, 2)}`)]);
        expect(m.turns[1]).toEqual({ tokens: 0, matched: 0, matchRate: 0 });
        expect(passesGate(m.turns[1])).toBe(false);
    });
});

describe("passesGate", () => {
    it("passes a turn exactly at the gate and fails one word under", () => {
        const at: TurnMatch = { tokens: 10, matched: 6, matchRate: 0.6 };
        expect(passesGate(at)).toBe(true);
        expect(passesGate({ ...at, matched: 5, matchRate: 0.5 })).toBe(false);
    });
});
