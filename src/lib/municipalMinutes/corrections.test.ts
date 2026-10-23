import { describe, it, expect } from "vitest";
import { core, correctFromTurns, mayReplace, rewriteUtterance, soundsAlike } from "./corrections.js";
import { matchMinutes, type TimedUtterance } from "./matching.js";
import type { Turn } from "./turns.js";

const turn = (index: number, label: string, text: string): Turn => ({ index, label, key: label.toLowerCase(), page: 3, offset: index * 1000, text, stageDirections: 0 });
const utterance = (i: number, text: string, tag = "tag-1"): TimedUtterance => ({ utteranceId: `u${i}`, text, start: i * 10, end: i * 10 + 9, speakerTagId: tag, speakerId: null });
const filler = (n: number, seed: number) => Array.from({ length: n }, (_, i) => `λέξη${(i * 31 + seed * 17) % 997}`).join(" ");
const run = (turns: Turn[], utterances: TimedUtterance[]) => correctFromTurns(turns, utterances, matchMinutes(turns, utterances));
/** One turn that prints `printed`, one utterance that says `spoken`, both between the same filler. */
const single = (spoken: string, printed: string) => run([turn(0, "ΠΡΟΕΔΡΟΣ", `${filler(20, 1)} ${printed} ${filler(20, 2)}`)], [utterance(0, `${filler(20, 1)} ${spoken} ${filler(20, 2)}`)]);

describe("rewriteUtterance and core", () => {
    it("replaces the words one by one and keeps our punctuation around and between them", () => {
        expect(rewriteUtterance("Ο κύριος Ρημάκης, παρακαλώ.", [{ index: 2, word: "Δημάκης" }])).toBe("Ο κύριος Δημάκης, παρακαλώ.");
        expect(rewriteUtterance("«Έξυπνες διαβάσεις» λοιπόν.", [{ index: 0, word: "Έξυπνοι" }, { index: 1, word: "δρόμοι»" }])).toBe("«Έξυπνοι δρόμοι» λοιπόν.");
        expect(rewriteUtterance("στη Θουκιδίδου, – Μεσόγειον και", [{ index: 1, word: "Θουκυδίδου" }, { index: 3, word: "Μεσογείων" }])).toBe("στη Θουκυδίδου, – Μεσογείων και");
    });

    it("keeps the dot of an abbreviation and drops a sentence-final dot, so our dot is never doubled", () => {
        expect(core("Δ.Σ.,")).toBe("Δ.Σ.");
        expect(core("κ.")).toBe("κ.");
        expect(core("Μεσογείων.")).toBe("Μεσογείων");
        expect(core("της.")).toBe("της");
        expect(rewriteUtterance("τη γνώμη τους.", [{ index: 2, word: "της." }])).toBe("τη γνώμη της.");
    });

    it("keeps an elision apostrophe as part of the word", () => {
        expect(core("απ'")).toBe("απ'");
        expect(rewriteUtterance("Άρα γι' αυτό", [{ index: 1, word: "γι'" }])).toBe("Άρα γι' αυτό");
    });
});

describe("soundsAlike", () => {
    it.each([
        ["Μεσόγειον", "Μεσογείων", true],
        ["διαπερής", "διαμπερής", true],
        ["Ρημάκης", "Δημάκης", true],
        ["Ωραία", "Λοιπόν", false],
        ["Είπατε", "Ήταν", false],
        ["παράγραφο", "παρ.", false],
        // A word with a short key is never a mishearing: not «θα» for «να», and not «η» for «οι» though they sound the same.
        ["θα", "να", false],
        ["το", "τα", false],
        ["η", "οι", false],
        ["της", "τις", false],
        ["Ναι", "Και", false],
    ])("%s vs %s → %s", (a, b, alike) => {
        expect(soundsAlike(a, b)).toBe(alike);
    });
});

describe("mayReplace", () => {
    const token = (text: string, norm = text.toLowerCase()) => ({ text, norm, index: 0, source: 0 });

    it("refuses a word the minutes print elsewhere: the secretary knows it and chose another", () => {
        const vocabulary = new Set(["πλειοψηφιασ", "μειοψηφιασ", "απουσα", "παρουσα"]);
        expect(mayReplace(token("Πλειοψηφίας", "πλειοψηφιασ"), token("μειοψηφίας", "μειοψηφιασ"), vocabulary)).toBe(false);
        expect(mayReplace(token("Απούσα", "απουσα"), token("παρούσα", "παρουσα"), vocabulary)).toBe(false);
        expect(mayReplace(token("Ρημάκης", "ρημακησ"), token("Δημάκης", "δημακησ"), vocabulary)).toBe(true);
    });

    it("refuses a change of digits however alike the words sound", () => {
        expect(mayReplace(token("3.200.000", "3200000"), token("3.200", "3200"), new Set())).toBe(false);
        expect(mayReplace(token("91,69%", "9169"), token("99,69%", "9969"), new Set())).toBe(false);
        expect(mayReplace(token("δεκαπέντε", "15"), token("δεκαέξι", "16"), new Set())).toBe(false);
        expect(mayReplace(token("15ης", "15ησ"), token("15ης,", "15ησ"), new Set())).toBe(true);
    });
});

describe("correctFromTurns", () => {
    it("writes a one-for-one, bounded substitution of a word the minutes never print, inside a verbatim turn", () => {
        const spoken = `${filler(20, 1)} ο κύριος Ρημάκης έχει τον λόγο ${filler(20, 2)}`;
        const printed = `${filler(20, 1)} ο κ. Δημάκης έχει το λόγο ${filler(20, 2)}`;
        const turns = [turn(0, "ΠΡΟΕΔΡΟΣ", printed)];
        // The misheard name opens the second utterance; the equal word before it is in the first.
        const utterances = [utterance(0, spoken.split(" ").slice(0, 21).join(" ")), utterance(1, spoken.split(" ").slice(21).join(" "))];
        const { corrections, counts } = run(turns, utterances);
        expect(corrections).toHaveLength(1);
        expect(corrections[0]).toMatchObject({ utteranceId: "u1", markUncertain: false, source: { page: 3, label: "ΠΡΟΕΔΡΟΣ", turnIndex: 0 } });
        expect(corrections[0].text).toContain("κύριος Δημάκης έχει τον λόγο");
        expect(counts).toEqual({ utterancesChanged: 1, substitutions: 1, insertionsSkipped: 0, deletionsSkipped: 0 });
    });

    it("never writes an insertion or a deletion, and counts their words", () => {
        const spoken = `${filler(20, 1)} ε να πούμε ότι ${filler(20, 2)}`;
        const printed = `${filler(20, 1)} να πούμε λοιπόν ότι ${filler(20, 2)}`;
        const { corrections, counts } = run([turn(0, "ΠΡΟΕΔΡΟΣ", printed)], [utterance(0, spoken)]);
        expect(corrections).toEqual([]);
        expect(counts).toMatchObject({ substitutions: 0, insertionsSkipped: 1, deletionsSkipped: 1 });
    });

    it("corrects nothing from a turn under the verbatim gate", () => {
        const spoken = `${filler(30, 1)} ο κύριος Ρημάκης είπε ${filler(30, 2)}`;
        const printed = `${filler(30, 1)} ο κύριος Δημάκης είπε ${filler(30, 3)} ${filler(40, 4)}`;
        const turns = [turn(0, "ΠΡΟΕΔΡΟΣ", printed)];
        const utterances = [utterance(0, spoken)];
        const matching = matchMinutes(turns, utterances);
        expect(matching.turns[0].matchRate).toBeLessThan(0.6);
        expect(correctFromTurns(turns, utterances, matching).corrections).toEqual([]);
    });

    it("skips a region whose word counts differ, a rewording, and a spacing-only difference", () => {
        const spoken = `${filler(20, 1)} είναι μόνο ${filler(20, 2)} ωραία ${filler(20, 3)} εν τάξει ${filler(20, 4)}`;
        // pdf.js split «είναι» in a justified line; «λοιπόν» is the secretary's word.
        const printed = `${filler(20, 1)} είνα ι μόνον ${filler(20, 2)} λοιπόν ${filler(20, 3)} εντάξει ${filler(20, 4)}`;
        const { corrections, counts } = run([turn(0, "ΠΡΟΕΔΡΟΣ", printed)], [utterance(0, spoken)]);
        expect(corrections).toEqual([]);
        expect(counts.substitutions).toBe(0);
        expect(counts.insertionsSkipped).toBe(4);
        expect(counts.deletionsSkipped).toBe(3);
    });

    it("skips five words even when each sounds like its pair", () => {
        const { corrections, counts } = single("Θουκιδίδου Μεσόγειον διαπερής Ρημάκης Μεσόγειον", "Θουκυδίδου Μεσογείων διαμπερής Δημάκης Μεσογείων");
        expect(corrections).toEqual([]);
        expect(counts).toMatchObject({ substitutions: 0, insertionsSkipped: 5, deletionsSkipped: 5 });
    });

    it("writes up to four words when every pair passes, keeping our punctuation between them, and none when one pair fails", () => {
        expect(single("Θουκιδίδου Μεσόγειον διαπερής Ρημάκης", "Θουκυδίδου Μεσογείων διαμπερής Δημάκης").corrections[0]?.text).toContain("Θουκυδίδου Μεσογείων διαμπερής Δημάκης");
        expect(single("Θουκιδίδου, – Μεσόγειον", "Θουκυδίδου Μεσογείων").corrections[0]?.text).toContain("Θουκυδίδου, – Μεσογείων");
        expect(single("Θουκιδίδου Μεσόγειον ωραία Ρημάκης", "Θουκυδίδου Μεσογείων λοιπόν Δημάκης").corrections).toEqual([]);
    });

    it("leaves the first word of the transcript alone, with no equal word before it", () => {
        const turns = [turn(0, "ΠΡΟΕΔΡΟΣ", `Δημάκης έχει το λόγο ${filler(30, 1)}`)];
        const { corrections, counts } = run(turns, [utterance(0, `Ρημάκης έχει τον λόγο ${filler(30, 1)}`)]);
        expect(corrections).toEqual([]);
        expect(counts).toMatchObject({ substitutions: 0, insertionsSkipped: 1, deletionsSkipped: 1 });
    });

    it("leaves a region that spans two utterances alone", () => {
        const turns = [turn(0, "ΠΡΟΕΔΡΟΣ", `${filler(20, 1)} Μεσογείων Δημάκης ${filler(20, 2)}`)];
        expect(run(turns, [utterance(0, `${filler(20, 1)} Μεσόγειον`), utterance(1, `Ρημάκης ${filler(20, 2)}`)]).corrections).toEqual([]);
    });

    it("leaves a region whose minutes words fall in two turns alone", () => {
        const turns = [turn(0, "ΠΡΟΕΔΡΟΣ", `${filler(20, 1)} Δημάκης`), turn(1, "ΔΗΜΑΡΧΟΣ", `Μεσογείων ${filler(20, 2)}`)];
        expect(run(turns, [utterance(0, `${filler(20, 1)} Ρημάκης Μεσόγειον ${filler(20, 2)}`)]).corrections).toEqual([]);
    });

    it("leaves a word alone when the minutes print it elsewhere, and a number alone always", () => {
        const turns = [turn(0, "ΠΡΟΕΔΡΟΣ", `${filler(20, 1)} η μειοψηφίας ${filler(20, 2)} της πλειοψηφίας ${filler(20, 3)} 3.200 ευρώ ${filler(20, 4)}`)];
        const { corrections } = run(turns, [utterance(0, `${filler(20, 1)} η πλειοψηφίας ${filler(20, 2)} της πλειοψηφίας ${filler(20, 3)} 3.200.000 ευρώ ${filler(20, 4)}`)]);
        expect(corrections).toEqual([]);
    });

    it("corrects a one-word utterance whose neighbours align", () => {
        const turns = [turn(0, "ΠΡΟΕΔΡΟΣ", `${filler(20, 1)} Μεσογείων ${filler(20, 2)}`)];
        const { corrections } = run(turns, [utterance(0, filler(20, 1)), utterance(1, "Μεσόγειον."), utterance(2, filler(20, 2))]);
        expect(corrections).toEqual([expect.objectContaining({ utteranceId: "u1", text: "Μεσογείων." })]);
    });
});
