import { describe, it, expect } from "vitest";
import fs from "fs";
import { parsePagedText } from "./pagedText.js";
import { splitSections } from "./read.js";
import { buildSectionText, canonicalRole, coverage, cutTurns, findBareLabels, joinBrokenWords, joinWrappedLabels, labelKey, parseLabel, parseTurns, stripStageDirections } from "./turns.js";

const fixture = (name: string) => {
    const pages = parsePagedText(fs.readFileSync(`fixtures/municipal-minutes/${name}.txt`, "utf-8"));
    const [section] = splitSections(pages);
    return section;
};

const labelKeys = (lines: ReturnType<typeof fixture>["lines"], roster: { id: string; name: string }[] = []) =>
    new Set(parseTurns(lines, roster).turns.map(t => t.key));

const onPage = (texts: string[], page = 1) => texts.map(text => ({ text, page }));

/** The label keys of a fixture with the number of turns of each, and the coverage. */
const measured = (name: string, roster: { id: string; name: string }[] = []) => {
    const section = fixture(name);
    const parsed = parseTurns(section.lines, roster);
    const counts: Record<string, number> = {};
    for (const turn of parsed.turns) counts[turn.key] = (counts[turn.key] ?? 0) + 1;
    return { section, parsed, counts, coverage: coverage(parsed.section, parsed.turns) };
};

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

    it.each(["ΥΠΕΡ (22)", "ΚΑΤΑ (4)", "ΛΕΥΚΑ (3)", "ΛΕΥΚΟ", "ΑΠΟΧΗ", "ΑΠΟΝΤΕΣ (13)", "ΠΑΡΟΝΤΕΣ", "Αρ. Απόφασης", "Αριθμός Απόφασης"])(
        "rejects the record heading «%s»", raw => {
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

    it("reads a label that is one parenthesis: a role and a name, or one of the two", () => {
        expect(parseLabel("(Πρόεδρος Δ.Σ., Λουκογεωργάκης Ευστάθιος)")).toMatchObject({
            role: "προεδροσ", name: null, parenthesisName: "Λουκογεωργάκης Ευστάθιος", key: "προεδροσ δ.σ. (λουκογεωργακησ ευσταθιοσ)", bareWord: false,
        });
        expect(parseLabel("(Δημοτικός Σύμβουλος, Παπαδάκης Ιωάννης)")).toMatchObject({ role: "συμβουλοσ", parenthesisName: "Παπαδάκης Ιωάννης" });
        expect(parseLabel("(Ομιλητής)")).toMatchObject({ role: "ομιλητησ", key: "ομιλητησ", bareWord: false });
        // A note of the secretary, and a vote heading, are not labels.
        expect(parseLabel("(Αποχώρησαν από τη συνεδρίαση οι Δ.Σ. Μ. Κούπκας, Β. Τομπουλίδης)")).toBeNull();
        expect(parseLabel("(ΥΠΕΡ)")).toBeNull();
    });

    it("labelKey and canonicalRole are the one place the key and the role come from", () => {
        expect(labelKey("Ο ΠΡΟΕΔΡΟΣ")).toBe("προεδροσ");
        expect(labelKey("ΘΕΜΑ 1ο")).toBe("θεμα 1ο");
        expect(canonicalRole("Πρόεδρος, Δημοτικό Συμβούλιο".toLowerCase())).toBeNull();
        expect(canonicalRole("γενικη γραμματεασ")).toBe("γενικοσ γραμματεασ");
        expect(canonicalRole("αντιδημαρχοσ οικονομικων")).toBe("αντιδημαρχοσ οικονομικων");
        expect(canonicalRole("συμβουλιο")).toBeNull();
        // A surname, not the legal adviser.
        expect(canonicalRole("νομικοσ")).toBeNull();
        expect(canonicalRole("νομικοσ συμβουλοσ")).toBe("νομικοσ συμβουλοσ");
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
        // «Πρόεδρος ΔΣ Νέων: Αρμάος Μιχάλης» is a line of the attendance list, not a turn.
        expect(withoutRoster).not.toContain("προεδροσ δσ νεων");
        expect(parseLabel("Πρόεδρος ΔΣ Νέων")).toMatchObject({ role: "προεδροσ δσ νεων" });
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

    it("Δράμα: a surname that repeats is a speaker without the roster; a surname that answers the roll call once is not", () => {
        const { section, parsed, counts, coverage: share } = measured("drama");
        expect(section).toMatchObject({ sessionNumber: 32, date: "2026-10-21" });
        expect(counts).toEqual({ "προεδροσ": 10, "πυργιλησ": 4 });
        for (const label of ["ΓΚΑΡΟΖΗΣ", "ΜΛΕΚΑΝΗΣ", "Δράμας"]) expect(parsed.rejectedLabels).toContain(label);
        expect(share).toBeCloseTo(0.665, 2);
    });

    it("Ελληνικό-Αργυρούπολη: the officers of the title block, with an honorific before the name, are not turns", () => {
        const { section, parsed, counts } = measured("elliniko-argyroupoli");
        expect(section).toMatchObject({ sessionNumber: 34, date: "2026-09-30" });
        expect(counts).toEqual({ "προεδροσ": 5, "γραμματεασ": 1 });
        expect(parsed.turns[0].text).toMatch(/^Κύριοι συνάδελφοι καλησπέρα σας/);
        expect(parsed.rejectedLabels).toContain("ΗΜΕΡΑ");
    });

    it("Ίλιον: a title block with a role and a body («ΠΡΟΕΔΡΟΣ Δ.Σ. :»), and a document that states no session number", () => {
        const { section, parsed, counts } = measured("ilion");
        expect(section).toMatchObject({ sessionNumber: null, date: null });
        expect(counts).toEqual({ "προεδροσ": 4, "ζενετοσ": 2 });
        expect(Object.keys(counts)).not.toContain("αντιπροεδροσ δ.σ.");
        expect(parsed.turns[0].text).toMatch(/^Κυρίες και κύριοι συνάδελφοι, υπάρχει η απαιτούμενη απαρτία/);
    });

    it("Ηλιούπολη: two fields of the title block on one line, and a role label with the name in a parenthesis", () => {
        const { section, parsed, counts } = measured("ilioupoli");
        expect(section).toMatchObject({ sessionNumber: 15, date: "2026-06-19" });
        expect(counts).toEqual({ "προεδροσ (δ.κορμα-γκουτζιανα)": 1, "προεδροσ": 4 });
        expect(parsed.turns[0].text).toMatch(/^Καλησπέρα σε όλους/);
    });

    it("Ηράκλειο Αττικής: the title block in capitals, the turns in mixed case", () => {
        const { section, parsed, counts } = measured("irakleio-attikis");
        expect(section).toMatchObject({ sessionNumber: 18, date: "2026-10-07" });
        expect(counts).toEqual({ "προεδροσ": 6, "γραμματεασ": 5 });
        expect(parsed.turns[0]).toMatchObject({ label: "Πρόεδρος", text: "Κύριε Παρασκευόπουλε να πάρουμε παρουσίες." });
    });

    it("Κάλυμνος: a label alone on its line with the speech on the next line, and «Κος» labels", () => {
        const { section, parsed, counts, coverage: share } = measured("kalymnos");
        expect(section).toMatchObject({ sessionNumber: 12, date: "2026-07-03" });
        expect(counts).toEqual({ "προεδροσ": 18, "δημαρχοσ": 11, "κοσ πλατσησ": 2, "γραμματεασ": 1 });
        expect(parsed.turns[0].text).toMatch(/^Καλησπέρα σε όλους/);
        expect(parsed.rejectedLabels).toContain("ΩΡΑ ΕΝΑΡΞΗΣ");
        expect(share).toBeCloseTo(0.84, 2);
    });

    it("Κατερίνη: a document with no title block starts with a turn", () => {
        const { section, parsed, counts, coverage: share } = measured("katerini");
        expect(section).toMatchObject({ sessionNumber: 40, date: "2026-10-12" });
        expect(counts).toEqual({ "προεδροσ": 7, "δημαρχοσ": 1 });
        expect(parsed.turns[0].text).toMatch(/^Καθίστε στις θέσεις σας/);
        expect(share).toBeCloseTo(0.99, 2);
    });

    it("Πέραμα: the roll call of the secretary, and the surnames that repeat", () => {
        const { section, parsed, counts, coverage: share } = measured("perama");
        expect(section).toMatchObject({ sessionNumber: 20, date: "2026-10-14" });
        expect(counts).toEqual({ "προεδροσ": 2, "γραμματεασ": 20, "ζερβακησ": 4, "γιαλελησ": 4, "βατιστασ": 3, "δημαρχοσ": 2 });
        // Known limit: «ΠΡΟΕΔΡΟΣ: (Πενταρβάνης Κωνσταντίνος):» leaves the name in the text of the first turn.
        expect(parsed.turns[0].text).toMatch(/^\(Πενταρβάνης Κωνσταντίνος\):/);
        expect(share).toBeCloseTo(0.91, 2);
    });

    it("Ρέθυμνο: a letter-spaced document, and labels that are one parenthesis with the role and the name", () => {
        const { section, parsed, counts } = measured("rethymno");
        expect(section).toMatchObject({ sessionNumber: 27, date: "2026-11-03" });
        expect(counts).toEqual({
            "προεδροσ δ.σ. (λουκογεωργακησ ευσταθιοσ)": 9,
            "γραμματεασ δ.σ. (δακαναλη ιωαννα)": 4,
            "αντιδημαρχοσ δ.σ. (προβιασ νικολαοσ)": 1,
        });
        expect(parsed.turns[0].text).toMatch(/^Σας παρακαλώ να\s+προσέλθετε στην αίθουσα/);
        expect(parsed.rejectedLabels).toEqual([]);
    });

    it("Σέρρες: three officers in the title block, and long turns", () => {
        const { section, parsed, counts } = measured("serres");
        expect(section).toMatchObject({ sessionNumber: 3, date: "2020-02-27" });
        expect(counts).toEqual({ "προεδροσ": 1, "δημαρχοσ": 1 });
        expect(parsed.turns[0].text).toMatch(/^Παρακαλώ, κύριοι συνάδελφοι, να αρχίσει η συνεδρίαση/);
        expect(parsed.rejectedLabels).toContain("ΠΑΡΟΝΤΕΣ ΔΗΜΟΤΙΚΟΙ ΣΥΜΒΟΥΛΟΙ");
    });

    it("Θεσσαλονίκη: labels alone on a line with no colon, the surnames from the document's own attendance list", () => {
        const { section, parsed, counts, coverage: share } = measured("thessaloniki");
        expect(section).toMatchObject({ sessionNumber: 20, date: "2026-09-21" });
        expect(counts).toEqual({ "προεδροσ": 12, "δημαρχοσ": 2, "γιαννακιδου": 1, "ιακωβου": 3, "γακησ": 1, "χρυσιδου": 1, "καλογηροσ": 3 });
        expect(parsed.turns[0]).toMatchObject({ label: "Πρόεδρος" });
        expect(parsed.turns[0].text).toMatch(/^Σε 5\./);
        expect(share).toBeCloseTo(0.86, 2);
    });

    it("Ωρωπός: the title block is not a turn, and the secretary who calls a name after it is", () => {
        const { section, parsed, counts } = measured("oropos");
        expect(section).toMatchObject({ sessionNumber: 15, date: "2026-07-05" });
        expect(counts).toEqual({ "προεδροσ": 6, "γραμματεασ": 7, "δημαρχοσ": 2 });
        expect(parsed.turns[0].text).toMatch(/^Σήμερα στην ειδική αυτή συνεδρίαση/);
        expect(parsed.turns[1]).toMatchObject({ label: "ΓΡΑΜΜΑΤΕΑΣ" });
        expect(parsed.turns[1].text).toMatch(/^Λούπης Νικόλαος\./);
    });

    it("Μακρακώμη: a first name and a surname as the label, and a document that states no session number", () => {
        const { section, parsed, counts, coverage: share } = measured("makrakomi");
        expect(section).toMatchObject({ sessionNumber: null, date: null });
        expect(counts).toEqual({ "προεδρευων": 18, "αθανασιοσ μαγουλασ": 4, "συμβουλοσ": 1, "δημαρχοσ": 7, "προεδροσ": 4 });
        // A speaker with one turn in these pages is left for the roster or the model check.
        expect(parsed.rejectedLabels).toContain("ΙΩΑΝΝΗΣ ΚΑΤΣΙΚΑΣ");
        expect(labelKeys(section.lines, [{ id: "p1", name: "Κατσίκας Ιωάννης" }])).toContain("ιωαννησ κατσικασ");
        expect(share).toBeCloseTo(1, 2);
    });

    it("Επίδαυρος: an honorific before the role («κ. ΠΡΟΕΔΡΟΣ»), and a first name after the surname of two members with one surname", () => {
        const { section, parsed, counts } = measured("epidavros");
        expect(section).toMatchObject({ sessionNumber: 1, date: "2021-01-26" });
        expect(counts).toEqual({ "κ. προεδροσ": 9, "κ. δημαρχοσ": 1, "κ. γαλανησ αθανασιοσ": 2 });
        expect(parseLabel("κ. ΠΡΟΕΔΡΟΣ")).toMatchObject({ role: "προεδροσ" });
        // The three officers of the title block are not turns.
        expect(parsed.turns[0]).toMatchObject({ label: "κ. ΠΡΟΕΔΡΟΣ" });
        expect(parsed.turns[0].text).toMatch(/^Να ξεκινήσουμε την αποψινή συνεδρίαση/);
    });

    it("reads a label with a space before the colon", () => {
        const parsed = parseTurns([{ text: "   ΛΑΛΕΣ : Κι εγώ θέλω να πω κάτι.", page: 9 }, { text: "   ΠΡΟΕΔΡΟΣ: Ναι.", page: 9 }, { text: "   ΛΑΛΕΣ: Ευχαριστώ.", page: 9 }], []);
        expect(parsed.turns.map(t => t.key)).toEqual(["λαλεσ", "προεδροσ", "λαλεσ"]);
    });

    it("measures the share of the section's text that is inside the turns", () => {
        // Each fixture is a few pages of its document. The title block, the attendance list and the agenda
        // are outside the turns, and they weigh more here than in the whole document (91% to 99.8% there).
        const expected: Record<string, number> = { "nea-filadelfeia": 0.76, "papagou-cholargos": 0.76, poros: 0.84, "pavlos-melas": 0.99, kalamaria: 0.66 };
        for (const [name, share] of Object.entries(expected)) expect(measured(name).coverage, name).toBeCloseTo(share, 2);
        const kalamaria = parseTurns(fixture("kalamaria").lines, []);
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

describe("the title block", () => {
    const keysAndTexts = (texts: string[]) => parseTurns(onPage(texts), []).turns.map(t => [t.key, t.text]);

    it("drops the officers that the title block names, in capitals or in mixed case", () => {
        expect(keysAndTexts([
            "ΔΗΜΑΡΧΟΣ: κ. ΜΠΑΜΠΑΛΟΣ ΝΙΚΟΛΑΟΣ",
            "ΠΡΟΕΔΡΟΣ: ΚΟΡΜΑ-ΓΚΟΥΤΖΙΑΝΑ Δ. ΓΡΑΜΜΑΤΕΑΣ: ΚΕΦΑΛΑΣ ΕΥΑΓΓΕΛΟΣ",
            "ΓΡΑΜΜΑΤΕΑΣ: ΤΣΕΝΕΜΠΗΣ (ΣΤΑΥΡΑΚΑΚΗΣ) ΔΗΜΗΤΡΙΟΣ (ΤΖΙΜΗΣ)",
            "Πρόεδρος ΔΣ Νέων: Αρμάος Μιχάλης",
            "ΠΡΟΕΔΡΟΣ: Καλησπέρα σας, αρχίζει η συνεδρίαση.",
            "ΔΗΜΑΡΧΟΣ: Ευχαριστώ.",
        ])).toEqual([["προεδροσ", "Καλησπέρα σας, αρχίζει η συνεδρίαση."], ["δημαρχοσ", "Ευχαριστώ."]]);
    });

    it("ends at the first label with speech after it: a later line of the same shape is a turn", () => {
        expect(keysAndTexts([
            "ΠΡΟΕΔΡΟΣ: ΤΡΟΜΠΟΥΚΗΣ ΧΡΗΣΤΟΣ",
            "ΠΡΟΕΔΡΟΣ: Παρακαλώ τον Γραμματέα να πάρει παρουσίες.",
            "ΓΡΑΜΜΑΤΕΑΣ: Δέδες Πέτρος",
            "ΔΕΔΕΣ: Παρών.",
            "ΓΡΑΜΜΑΤΕΑΣ: Λούπης Νικόλαος",
            "ΔΕΔΕΣ: Απών.",
        ]).map(([key]) => key)).toEqual(["προεδροσ", "γραμματεασ", "δεδεσ", "γραμματεασ", "δεδεσ"]);
    });

    it("keeps a first turn that is a name with a period, one word, or a sentence", () => {
        expect(keysAndTexts(["ΓΡΑΜΜΑΤΕΑΣ: Λούπης Νικόλαος.", "ΠΡΟΕΔΡΟΣ: Ναι."])).toHaveLength(2);
        expect(keysAndTexts(["ΠΡΟΕΔΡΟΣ: Ευχαριστώ", "ΔΗΜΑΡΧΟΣ: Ναι."])).toHaveLength(2);
        expect(keysAndTexts(["ΠΡΟΕΔΡΟΣ: Ξεκινάμε τη συνεδρίαση με το πρώτο θέμα", "ΔΗΜΑΡΧΟΣ: Ναι."])).toHaveLength(2);
    });
});

describe("findBareLabels", () => {
    const attendance = ["ΠΑΡΟΝΤΕΣ-ΠΑΡΟΥΣΕΣ", "Στέλιος Αγγελούδης Ιωάννης Ιακώβου", "Κυριακή (Κούλα) Γιαννακίδου Πέτρος Γάκης", "Σπύρος Καλογήρος Μαρία Χρυσίδου", "Η συνεδρίαση αρχίζει στις 18:00."];
    const bareKeys = (texts: string[], roster: { id: string; name: string }[] = []) =>
        findBareLabels(buildSectionText(onPage(texts)), roster).map(b => b.key);

    it("reads a role, a surname of the document's own attendance list, and a name of the roster", () => {
        const texts = [...attendance, "Πρόεδρος", "Καλησπέρα σας.", "Ιακώβου", "Ναι, κύριε Πρόεδρε.", "Γιαννακίδου", "Συμφωνώ.", "Παπαδόπουλος", "Κι εγώ."];
        expect(bareKeys(texts)).toEqual(["προεδροσ", "ιακωβου", "γιαννακιδου"]);
        expect(bareKeys(texts, [{ id: "p1", name: "Νίκος Παπαδόπουλος" }])).toEqual(["προεδροσ", "ιακωβου", "γιαννακιδου", "παπαδοπουλοσ"]);
    });

    it("rejects a word of speech alone on its line, a short first name, a line with a colon and a note in a parenthesis", () => {
        const list = [attendance[0], "Ρία Καλφακάκου Κων Ζέρβας", ...attendance.slice(1)];
        expect(bareKeys([...list, "Λοιπόν", "Να προχωρήσουμε.", "Ναι", "Συμφωνώ.", "Ρία", "Εντάξει.", "Γάκης: Ναι.", "Εντάξει.", "(Αποχωρεί ο Γάκης)", "Εντάξει."])).toEqual([]);
        expect(bareKeys([...list, "Καλφακάκου", "Εντάξει."])).toEqual(["καλφακακου"]);
    });

    it("rejects a label next to another bare label or next to a line of names: that is a list", () => {
        expect(bareKeys([...attendance, "Πρόεδρος", "Δήμαρχος", "Καλησπέρα σας."])).toEqual([]);
        expect(bareKeys(["Στέλιος Αγγελούδης Ιωάννης Ιακώβου", "Κυριακή Γιαννακίδου Πέτρος Γάκης", "Σπύρος Καλογήρος Μαρία Χρυσίδου", "Πρόεδρος", "Καλησπέρα σας."])).toEqual([]);
    });

    it("parseTurns reads the bare style only when it finds ten labels and twice the labels of the colon style", () => {
        const exchange = (n: number) => Array.from({ length: n }, (_, i) => [i % 2 ? "Ιακώβου" : "Πρόεδρος", `Ομιλία ${i + 1}.`]).flat();
        const keys = (texts: string[]) => parseTurns(onPage(texts), []).turns.map(t => t.key);
        expect(keys([...attendance, ...exchange(9)])).toEqual([]);
        expect(keys([...attendance, ...exchange(10)])).toHaveLength(10);
        // Six labels with a colon: ten bare labels are not twice as many, and the colon style stands.
        const colon = Array.from({ length: 6 }, (_, i) => `${i % 2 ? "ΔΗΜΑΡΧΟΣ" : "ΠΡΟΕΔΡΟΣ"}: Ομιλία ${i + 1}.`);
        expect(keys([...attendance, ...colon, ...exchange(10)])).toHaveLength(6);
        expect(keys([...attendance, ...colon.slice(0, 4), ...exchange(10)])).toHaveLength(14);
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
