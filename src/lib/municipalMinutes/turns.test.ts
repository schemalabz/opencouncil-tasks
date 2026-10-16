import { describe, it, expect } from "vitest";
import fs from "fs";
import { parsePagedText } from "./pagedText.js";
import { splitSections } from "./read.js";
import { buildSectionText, canonicalRole, coverage, COVERAGE_FLOOR, cutTurns, joinBrokenWords, joinWrappedLabels, labelKey, parseLabel, parseTurns, stripStageDirections } from "./turns.js";

const fixture = (name: string) => {
    const pages = parsePagedText(fs.readFileSync(`fixtures/municipal-minutes/${name}.txt`, "utf-8"));
    const [section] = splitSections(pages);
    return section;
};

const labelKeys = (lines: ReturnType<typeof fixture>["lines"], roster: { id: string; name: string }[] = []) =>
    new Set(parseTurns(lines, roster).turns.map(t => t.key));

describe("parseLabel", () => {
    it.each([
        ["ΠΡΟΕΔΡΟΣ", "προεδροσ", "προεδροσ"],
        ["Ο ΠΡΟΕΔΡΟΣ", "προεδροσ", "προεδροσ"],
        ["Δήμαρχος (κ. Γεώργιος Κουτουζής)", "δημαρχοσ (κ. γεωργιοσ κουτουζησ)", "δημαρχοσ"],
        ["ΓΕΝ. ΓΡΑΜΜΑΤΕΑΣ", "γεν. γραμματεασ", "γενικοσ γραμματεασ"],
        ["Γενική Γραμματέας", "γενικη γραμματεασ", "γενικοσ γραμματεασ"],
        ["ΠΡΟΕΔΡΟΣ Δ.Σ.", "προεδροσ δ.σ.", "προεδροσ"],
        ["ΑΝΤΙΔ. ΠΑΙΔΕΙΑΣ", "αντιδ. παιδειασ", "αντιδημαρχοσ παιδειασ"],
        ["Πρόεδρος Δημοτικής Κοινότητας", "προεδροσ δημοτικησ κοινοτητασ", "προεδροσ δημοτικησ κοινοτητασ"],
        ["ΜΕΛΗ", "μελη", "μελη"],
        ["Κ. ΤΟΜΠΟΥΛΟΓΛΟΥ", "κ. τομπουλογλου", null],
        ["Κος Παπαδόπουλος", "κοσ παπαδοπουλοσ", null],
        ["Δ. – Ε. ΓΚΟΥΜΑ", "δ. – ε. γκουμα", null],
        ["κα Κανατσίδη", "κα κανατσιδη", null],
        ["ΔΑΡΔΑΜΑΝΕΛΗΣ Θ.", "δαρδαμανελησ θ.", null],
        ["ΒΑΝΔΩΡΟΣ Π. (ΥΠΑΛΛΗΛΟΣ ΓΡΑΦΕΙΟΥ ΔΙΑ ΒΙΟΥ ΜΑΘΗΣΗΣ)", "βανδωροσ π.", null],
        ["ΥΠ/ΚΟΣ ΠΑΡΑΓΩΝ", "υπ/κοσ παραγων", "υπηρεσιακοσ παραγων"],
    ])("accepts «%s»", (raw, key, role) => {
        const parsed = parseLabel(raw);
        expect(parsed?.key).toBe(key);
        expect(parsed?.role ?? null).toBe(role);
    });

    it.each(["ΘΕΜΑ 1ο", "ΘΕΜΑ 2Ο", "Τηλ.", "Ταχ. Δ/νση", "Το Δ.Σ. αφού πήρε υπόψη", "ως εξής", "e-mail", "Αρ. Πρωτ.", "ΘΕΜΑ.", "", "Ο κ. Α. Β. Γ. Δ. Ε. Ζ."])(
        "rejects «%s»", raw => {
            expect(parseLabel(raw)).toBeNull();
        });

    it("gives the name to look up without honorifics and dashes", () => {
        expect(parseLabel("κ. Δημητριάδης")?.name).toBe("Δημητριάδης");
        expect(parseLabel("Κος Παπαδόπουλος")?.name).toBe("Παπαδόπουλος");
        expect(parseLabel("Δ. – Ε. ΓΚΟΥΜΑ")?.name).toBe("Δ. Ε. ΓΚΟΥΜΑ");
        expect(parseLabel("Ειδικότερα")?.bareWord).toBe(true);
        expect(parseLabel("ΜΕΙΟΝ")?.bareWord).toBe(false);
    });

    it("gives a role label's parenthesis as the name to look up, honorifics removed, and keeps it in the key", () => {
        expect(parseLabel("ΑΝΤΙΔΗΜΑΡΧΟΣ (κ. Τράκας)")).toMatchObject({ role: "αντιδημαρχοσ", name: null, parenthesisName: "Τράκας", key: "αντιδημαρχοσ (κ. τρακασ)" });
        expect(parseLabel("ΑΝΤΙΔΗΜΑΡΧΟΣ (κ. Πέτρου)")?.key).toBe("αντιδημαρχοσ (κ. πετρου)");
        expect(parseLabel("ΒΑΝΔΩΡΟΣ Π. (ΥΠΑΛΛΗΛΟΣ ΓΡΑΦΕΙΟΥ)")).toMatchObject({ role: null, name: "ΒΑΝΔΩΡΟΣ Π.", parenthesisName: null, key: "βανδωροσ π." });
    });

    it("labelKey and canonicalRole are the one place the key and the role come from", () => {
        expect(labelKey("Ο ΠΡΟΕΔΡΟΣ")).toBe("προεδροσ");
        expect(labelKey("ΘΕΜΑ 1ο")).toBe("θεμα 1ο");
        expect(canonicalRole("Πρόεδρος, Δημοτικό Συμβούλιο".toLowerCase())).toBeNull();
        expect(canonicalRole("γενικη γραμματεασ")).toBe("γενικοσ γραμματεασ");
        expect(canonicalRole("αντιδημαρχοσ οικονομικων")).toBe("αντιδημαρχοσ οικονομικων");
        expect(canonicalRole("συμβουλιο")).toBeNull();
    });
});

describe("joinWrappedLabels and joinBrokenWords", () => {
    it("joins a label whose parenthesis wrapped to the next line", () => {
        const lines = joinWrappedLabels([
            { text: "ΜΑΥΡΟΜΜΑΤΗ Δ. (ΠΡΟΪΣΤΑΜΕΝΗ ΤΜΗΜΑΤΟΣ ΔΙΟΙΚΗΣΗΣ ΚΑΙ ΑΝΘΡΩΠΙΝΟΥ", page: 14 },
            { text: "ΔΥΝΑΜΙΚΟΥ): Όταν το παίρνεις", page: 14 },
            { text: "ΝΤΙΝΤΗ: Ναι.", page: 14 },
        ]);
        expect(lines.map(l => l.text)).toEqual(["ΜΑΥΡΟΜΜΑΤΗ Δ. (ΠΡΟΪΣΤΑΜΕΝΗ ΤΜΗΜΑΤΟΣ ΔΙΟΙΚΗΣΗΣ ΚΑΙ ΑΝΘΡΩΠΙΝΟΥ ΔΥΝΑΜΙΚΟΥ): Όταν το παίρνεις", "ΝΤΙΝΤΗ: Ναι."]);
    });

    it("rejoins a word the layout broke with a hyphen", () => {
        const lines = joinBrokenWords([{ text: "των συμμετεχόντων και παρακολου-", page: 3 }, { text: "θούντων ότι η δημόσια", page: 3 }, { text: "ΠΡΟΕΔΡΟΣ: Ναι - ", page: 3 }, { text: "Όχι", page: 3 }]);
        expect(lines.map(l => l.text)).toEqual(["των συμμετεχόντων και παρακολουθούντων ότι η δημόσια", "ΠΡΟΕΔΡΟΣ: Ναι - ", "Όχι"]);
    });
});

describe("stripStageDirections", () => {
    it("removes what the secretary wrote in place of speech and counts it", () => {
        const { text, count } = stripStageDirections("Διάλογος θα γίνεται (Παρέμβαση εκτός μικροφώνου) μετά… (δεν ακούγεται καθαρά)... το [...] τέλος (ΟΑΕΔ) ναι.");
        expect(text.replace(/\s+/g, " ")).toBe("Διάλογος θα γίνεται μετά… ... το τέλος (ΟΑΕΔ) ναι.");
        expect(count).toBe(3);
    });
});

describe("parseTurns on the real documents", () => {
    it("Νέα Φιλαδέλφεια: role labels, and initials-plus-surname labels through the roster", () => {
        const section = fixture("nea-filadelfeia");
        expect(section).toMatchObject({ sessionNumber: 27, date: "2025-10-20" });
        const withoutRoster = labelKeys(section.lines);
        expect(withoutRoster).toContain("προεδροσ");
        expect(withoutRoster).toContain("δημαρχοσ");
        expect(withoutRoster).not.toContain("ημερα");
        const withRoster = labelKeys(section.lines, [{ id: "p1", name: "Γεωργαμλής Λύσανδρος" }, { id: "p2", name: "Κουτσάκης Μιχαήλ" }]);
        expect(withRoster).toContain("λ. γεωργαμλησ");
        expect(withRoster).toContain("μ. κουτσακησ");
    });

    it("Παπάγου-Χολαργός: capital surnames, Latin homoglyphs in the header, and the roll-call answers through the roster", () => {
        const section = fixture("papagou-cholargos");
        expect(section).toMatchObject({ sessionNumber: 20, date: "2026-10-07" });
        const withoutRoster = labelKeys(section.lines);
        for (const key of ["προεδροσ", "γραμματεασ", "χαμηλοθωρη", "κουκησ", "συμβουλοσ"]) expect(withoutRoster).toContain(key);
        expect(withoutRoster).not.toContain("υφαντησ");
        // A role word with a body after it is a speaker in its own right.
        expect(withoutRoster).toContain("προεδροσ δσ νεων");
        const withRoster = labelKeys(section.lines, [{ id: "p1", name: "Μιχαήλ Υφαντής" }, { id: "p2", name: "Μιχαήλ Τράκας" }]);
        expect(withRoster).toContain("υφαντησ");
        expect(withRoster).toContain("τρακασ");
    });

    it("Πόρος: role labels in mixed case, honorific labels through the roster, and the invitation's fields are not labels", () => {
        const section = fixture("poros");
        expect(section).toMatchObject({ sessionNumber: 12, date: "2025-03-17" });
        const parsed = parseTurns(section.lines, [{ id: "p1", name: "Ελένη Κουτουζή" }]);
        const keys = new Set(parsed.turns.map(t => t.key));
        for (const key of ["προεδροσ", "δημαρχοσ", "πρακτικογραφοσ", "κα κουτουζη"]) expect(keys).toContain(key);
        for (const rejected of ["Τηλ.", "Πληροφορίες", "ΠΡΟΣ", "ΘΕΜΑ"]) expect(keys).not.toContain(rejected.toLowerCase());
        // A one-off speaker the roster does not know is left for the model check.
        expect(parsed.rejectedLabels).toContain("κ. Γκιων");
        expect(parsed.turns.some(t => t.label === "Δήμαρχος (κ. Γεώργιος Κουτουζής)")).toBe(true);
    });

    it("Καλαμαριά: the decision block's headings are not labels, and a wrapped parenthesis is read as one label", () => {
        const section = fixture("kalamaria");
        expect(section).toMatchObject({ sessionNumber: 16, date: "2017-07-24" });
        const parsed = parseTurns(section.lines, [{ id: "p1", name: "Αντωνάκης Βικέντιος" }, { id: "p2", name: "Ματσαρίδης Στυλιανός" }]);
        const keys = new Set(parsed.turns.map(t => t.key));
        for (const key of ["προεδροσ", "δημαρχοσ", "παπαδοπουλοσ", "αντωνακησ", "ματσαριδησ"]) expect(keys).toContain(key);
        expect(keys).not.toContain("το δ.σ. αφου πηρε υποψη");
        expect(parsed.rejectedLabels).toContain("ΜΑΥΡΟΜΜΑΤΗ Δ. (ΠΡΟΪΣΤΑΜΕΝΗ ΤΜΗΜΑΤΟΣ ΔΙΟΙΚΗΣΗΣ ΚΑΙ ΑΝΘΡΩΠΙΝΟΥ ΔΥΝΑΜΙΚΟΥ)");
    });

    it("Παύλος Μελάς: indented capital surnames", () => {
        const section = fixture("pavlos-melas");
        expect(section).toMatchObject({ sessionNumber: 1, date: "2021-01-27" });
        const keys = labelKeys(section.lines, [{ id: "p1", name: "Σαββίδου Μαρία" }]);
        for (const key of ["προεδροσ", "βαρφησ", "αλεξανδριδου", "σαββιδου"]) expect(keys).toContain(key);
        expect(keys).not.toContain("παροντεσ");
    });

    it("reads a label with a space before the colon", () => {
        const parsed = parseTurns([{ text: "   ΛΑΛΕΣ : Κι εγώ θέλω να πω κάτι.", page: 9 }, { text: "   ΠΡΟΕΔΡΟΣ: Ναι.", page: 9 }, { text: "   ΛΑΛΕΣ: Ευχαριστώ.", page: 9 }], []);
        expect(parsed.turns.map(t => t.key)).toEqual(["λαλεσ", "προεδροσ", "λαλεσ"]);
    });

    it("measures the share of the section's text from the first turn on", () => {
        // Each fixture is the first pages of its document; the front matter weighs more here than in the whole.
        for (const name of ["nea-filadelfeia", "papagou-cholargos", "poros", "pavlos-melas"]) {
            const parsed = parseTurns(fixture(name).lines, []);
            expect(coverage(parsed.section, parsed.turns), name).toBeGreaterThanOrEqual(COVERAGE_FLOOR);
        }
        const kalamaria = parseTurns(fixture("kalamaria").lines, []);
        expect(coverage(kalamaria.section, kalamaria.turns)).toBeCloseTo(0.66, 2);
        expect(coverage(kalamaria.section, [])).toBe(0);
    });

    it("confirms a repeated label, but not a repeated bare mixed-case word the roster does not know", () => {
        const parsed = parseTurns([
            { text: "ΠΡΟΕΔΡΟΣ: Ξεκινάμε.", page: 1 },
            { text: "Ειδικότερα: το ποσό των 5.000 ευρώ.", page: 1 },
            { text: "ΛΑΛΕΣ: Ναι.", page: 1 },
            { text: "Ειδικότερα: το ποσό των 7.000 ευρώ.", page: 1 },
            { text: "ΛΑΛΕΣ: Όχι.", page: 1 },
        ], []);
        expect(parsed.turns.map(t => t.key)).toEqual(["προεδροσ", "λαλεσ", "λαλεσ"]);
        expect(parsed.rejectedLabels).toEqual(["Ειδικότερα"]);
    });
});

describe("cutTurns", () => {
    it("runs each turn from its label to the next, keeps the page, and strips stage directions", () => {
        const section = buildSectionText([
            { text: "ΠΡΟΕΔΡΟΣ: Καλησπέρα. (Διαλογικές συζητήσεις)", page: 4 },
            { text: "Συνεχίζουμε.", page: 4 },
            { text: "ΔΗΜΑΡΧΟΣ: Ναι.", page: 5 },
        ]);
        const parsed = parseTurns([
            { text: "ΠΡΟΕΔΡΟΣ: Καλησπέρα. (Διαλογικές συζητήσεις)", page: 4 },
            { text: "Συνεχίζουμε.", page: 4 },
            { text: "ΔΗΜΑΡΧΟΣ: Ναι.", page: 5 },
        ], []);
        const turns = cutTurns(section, parsed.boundaries);
        expect(turns).toHaveLength(2);
        expect(turns[0]).toMatchObject({ index: 0, label: "ΠΡΟΕΔΡΟΣ", page: 4, stageDirections: 1 });
        expect(turns[0].text.replace(/\s+/g, " ")).toBe("Καλησπέρα. Συνεχίζουμε.");
        expect(turns[1]).toMatchObject({ index: 1, label: "ΔΗΜΑΡΧΟΣ", page: 5, text: "Ναι." });
        expect(coverage(section, turns)).toBe(1);
    });
});
