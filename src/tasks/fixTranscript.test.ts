import { describe, it, expect } from "vitest";
import { buildUserPrompt, parseNumberedUtterances } from "./fixTranscript.js";

describe("parseNumberedUtterances", () => {
    it("parses sequential numbered lines", () => {
        const text = "1. Καλησπέρα κύριοι συνάδελφοι.\n2. Ξεκινάει η 35η συνεδρίαση.\n3. Υπάρχει απαρτία;";

        expect(parseNumberedUtterances(text, 3)).toEqual([
            "Καλησπέρα κύριοι συνάδελφοι.",
            "Ξεκινάει η 35η συνεδρίαση.",
            "Υπάρχει απαρτία;",
        ]);
    });

    it("tolerates surrounding whitespace and blank lines between entries", () => {
        const text = "\n1. πρώτο\n\n2. δεύτερο\n";

        expect(parseNumberedUtterances(text, 2)).toEqual(["πρώτο", "δεύτερο"]);
    });

    it("joins wrapped continuation lines into the previous utterance", () => {
        const text = "1. μια μεγάλη πρόταση\nπου συνεχίζεται στην επόμενη γραμμή\n2. δεύτερο";

        expect(parseNumberedUtterances(text, 2)).toEqual([
            "μια μεγάλη πρόταση που συνεχίζεται στην επόμενη γραμμή",
            "δεύτερο",
        ]);
    });

    it("rejects out-of-sequence numbered lines instead of merging them", () => {
        // Folding a misnumbered line into the previous utterance would corrupt
        // the record silently — a retry is always safer
        expect(parseNumberedUtterances("1. ένα\n3. τρία\n2. δύο", 2)).toBeNull();
        expect(parseNumberedUtterances("1. ένα\n2. δύο\n2. τρία\n3. τέσσερα", 4)).toBeNull();
    });

    it("treats lines starting with a decimal number as continuations", () => {
        const text = "1. το κόστος ανέρχεται σε\n3.5 εκατομμύρια ευρώ\n2. δεύτερο";

        expect(parseNumberedUtterances(text, 2)).toEqual([
            "το κόστος ανέρχεται σε 3.5 εκατομμύρια ευρώ",
            "δεύτερο",
        ]);
    });

    it("returns null when the count does not match", () => {
        expect(parseNumberedUtterances("1. μόνο ένα", 2)).toBeNull();
        expect(parseNumberedUtterances("1. ένα\n2. δύο\n3. τρία", 2)).toBeNull();
    });

    it("returns null on preamble before the first numbered line", () => {
        expect(parseNumberedUtterances("Here are the corrected lines:\n1. ένα", 1)).toBeNull();
    });

    it("returns null when numbering does not start at 1", () => {
        expect(parseNumberedUtterances("2. ένα\n3. δύο", 2)).toBeNull();
    });
});

describe("buildUserPrompt", () => {
    const parties = [
        { name: "Παράταξη Α", people: [{ name: "Γιώργος Δημάκης", role: "μέλος" }, { name: "Άννα Ξηνταροπούλου", role: "μέλος" }] },
        { name: "Παράταξη Β", people: [{ name: "Νίκος Αδραχτάς", role: "επικεφαλής" }] },
    ];

    it("formats the roster as readable lines and numbers the utterances", () => {
        const prompt = buildUserPrompt("Αθήνα", parties, [], "Γιώργος Δημάκης", ["πρώτο", "δεύτερο"]);

        expect(prompt).toContain("City: Αθήνα");
        expect(prompt).toContain("Speaker: Γιώργος Δημάκης");
        expect(prompt).toContain("Παράταξη Α: Γιώργος Δημάκης, Άννα Ξηνταροπούλου");
        expect(prompt).toContain("Παράταξη Β: Νίκος Αδραχτάς");
        expect(prompt).toContain("1. πρώτο\n2. δεύτερο");
        expect(prompt).not.toContain("Agenda items");
    });

    it("includes numbered agenda items when provided", () => {
        const agenda = [{ name: "Ανάπλαση οδού Ερμού" }, { name: "Κανονισμός ύδρευσης (άρθρο 75)" }];

        const prompt = buildUserPrompt("Αθήνα", parties, agenda, "Γιώργος Δημάκης", ["πρώτο"]);

        expect(prompt).toContain("Agenda items of this meeting (source for street/project/entity names):");
        expect(prompt).toContain("1. Ανάπλαση οδού Ερμού\n2. Κανονισμός ύδρευσης (άρθρο 75)");
    });
});
