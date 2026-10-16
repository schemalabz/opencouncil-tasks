import { describe, it, expect } from "vitest";
import { cityDate, scoreCorrections, scoringWords, wordErrorRate } from "./minutesBacktest.js";
import type { FixFromMinutesRequest, FixFromMinutesResult } from "../../types.js";

describe("scoringWords and wordErrorRate", () => {
    it("folds case, accents and punctuation, and nothing the task's own rules equate", () => {
        expect(scoringWords("Ο κύριος Δημάκης, ναι.")).toEqual(["ο", "κυριοσ", "δημακησ", "ναι"]);
        expect(scoringWords("κ. δύο τον")).toEqual(["κ", "δυο", "τον"]);
        expect(wordErrorRate([{ hypothesis: "ο κύριος Ρημάκης", reference: "ο κύριος Δημάκης" }, { hypothesis: "ναι", reference: "ναι" }])).toEqual({ errors: 1, words: 4, rate: 0.25 });
        // The task sees «κ.» and «κύριος» as equal; the scorer counts the difference.
        expect(wordErrorRate([{ hypothesis: "ο κ. Δημάκης", reference: "ο κύριος Δημάκης" }]).errors).toBe(1);
    });
});

describe("cityDate", () => {
    it("gives the date in Athens time", () => {
        expect(cityDate("2026-10-07T16:00:00.000Z")).toBe("2026-10-07");
        expect(cityDate("2026-10-07T22:30:00.000Z")).toBe("2026-10-08");
    });
});

describe("scoreCorrections", () => {
    const request = {
        transcript: [{ utterances: [{ utteranceId: "u1", text: "ο κύριος Ρημάκης" }, { utteranceId: "u2", text: "καλησπέρα σας" }, { utteranceId: "u3", text: "ωραία λοιπόν" }] }],
    } as unknown as FixFromMinutesRequest;
    const result = {
        updateUtterances: [
            { utteranceId: "u1", text: "ο κύριος Δημάκης", markUncertain: false, source: { page: 1, label: "ΠΡΟΕΔΡΟΣ", turnIndex: 0 } },
            { utteranceId: "u2", text: "καλησπέρα σε όλους", markUncertain: false, source: { page: 1, label: "ΠΡΟΕΔΡΟΣ", turnIndex: 0 } },
        ],
    } as unknown as FixFromMinutesResult;
    const reviewed = new Map([["u1", "ο κύριος Δημάκης"], ["u2", "καλησπέρα σας"], ["u3", "ωραία λοιπόν"]]);

    it("measures the word error rate before and after, and the outcome of each changed utterance", () => {
        const score = scoreCorrections(request, result, reviewed);
        expect(score.before).toEqual({ errors: 1, words: 7, rate: 1 / 7 });
        expect(score.after).toEqual({ errors: 2, words: 7, rate: 2 / 7 });
        expect(score.changed.map(c => c.outcome)).toEqual(["fixed", "broke"]);
        expect(score.outcomes).toEqual({ fixed: 1, broke: 1, closer: 0, further: 0, same: 0 });
    });

    it("tells closer, further and same apart", () => {
        const three = { transcript: [{ utterances: [{ utteranceId: "u1", text: "α β γ δ" }, { utteranceId: "u2", text: "α β γ δ" }, { utteranceId: "u3", text: "α β" }] }] } as unknown as FixFromMinutesRequest;
        const source = { page: 1, label: "ΠΡΟΕΔΡΟΣ", turnIndex: 0 };
        const updates = { updateUtterances: [
            { utteranceId: "u1", text: "α β γ ε", markUncertain: false, source },
            { utteranceId: "u2", text: "α ζ η δ", markUncertain: false, source },
            { utteranceId: "u3", text: "α δ", markUncertain: false, source },
        ] } as unknown as FixFromMinutesResult;
        const truth = new Map([["u1", "α β ε ε"], ["u2", "α β ε δ"], ["u3", "α γ"]]);
        expect(scoreCorrections(three, updates, truth).changed.map(c => c.outcome)).toEqual(["closer", "further", "same"]);
    });
});
