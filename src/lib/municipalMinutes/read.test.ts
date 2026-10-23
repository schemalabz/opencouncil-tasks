import { describe, it, expect } from "vitest";
import { checkTextLayer, findDate, findSessionNumber, linesFromTextItems, pickSection, splitSections, stripRunningLines, type MinutesPage } from "./read.js";

const item = (str: string, x: number, y: number, height = 12, hasEOL = false) =>
    ({ str, dir: "ltr", transform: [height, 0, 0, height, x, y], width: str.length * height * 0.5, height, hasEOL, fontName: "f" });

describe("linesFromTextItems", () => {
    it("joins runs on one baseline and breaks on a new one", () => {
        const lines = linesFromTextItems([item("ΠΡΟΕΔΡΟΣ:", 0, 700), item("Καλησπέρα.", 70, 700), item("ΔΗΜΑΡΧΟΣ:", 0, 684)]);
        expect(lines).toEqual(["ΠΡΟΕΔΡΟΣ: Καλησπέρα.", "ΔΗΜΑΡΧΟΣ:"]);
    });

    it("keeps a superscript ordinal on its line", () => {
        const lines = linesFromTextItems([item("27", 0, 700, 14), item("ης", 14, 705, 8), item(" ΣΥΝΕΔΡΙΑΣΗΣ", 22, 700, 14)]);
        expect(lines).toEqual(["27ης ΣΥΝΕΔΡΙΑΣΗΣ"]);
    });
});

describe("checkTextLayer", () => {
    it("fails a document with no text", () => {
        expect(() => checkTextLayer([{ page: 1, lines: ["1"] }, { page: 2, lines: [] }])).toThrow("scanned document, no text layer");
    });
});

describe("stripRunningLines", () => {
    const page = (n: number, body: string[]): MinutesPage => ({ page: n, lines: [`ΔΗΜΟΣ ΠΟΡΟΥ – ΠΡΑΚΤΙΚΑ 12ης ΣΥΝΕΔΡΙΑΣΗΣ`, ...body, String(n + 3)] });

    it("removes the lines that repeat on every page and the page numbers, wherever pdf.js put them", () => {
        const pages = [page(1, ["α"]), page(2, ["5", "β"]), page(3, ["γ"]), page(4, ["δ"])];
        const { pages: cleaned, stripped } = stripRunningLines(pages);
        expect(cleaned.map(p => p.lines)).toEqual([["α"], ["β"], ["γ"], ["δ"]]);
        expect(stripped).toBe(9);
    });

    it("keeps a short speech line that recurs at page edges but mostly sits mid-page", () => {
        const letters = ["α", "β", "γ", "δ", "ε"];
        const pages = letters.map((l, i) => ({ page: i + 1, lines: ["ΠΡΟΕΔΡΟΣ: Ναι.", `κείμενο ${l}`, "ΠΡΟΕΔΡΟΣ: Ναι.", `άλλο ${l}`, "ΠΡΟΕΔΡΟΣ: Ναι.", `τρίτο ${l}`, "ΠΡΟΕΔΡΟΣ: Ναι.", `τέλος ${l}`] }));
        const { stripped } = stripRunningLines(pages);
        expect(stripped).toBe(0);
    });
});

describe("findDate", () => {
    it.each([
        ["ΣΥΝΕΔΡIΑΣΗ 20η 7.10.2026", "2026-10-07"],
        ["27η ΤΑΚΤΙΚΗ ΣΥΝΕΔΡΙΑΣΗ ΔΗΜΟΤΙΚΟΥ ΣΥΜΒΟΥΛΙΟΥ – 20/10/2025", "2025-10-20"],
        ["ΔΕΥΤΕΡΑ 20 ΟΚΤΩΒΡΙΟΥ 2025", "2025-10-20"],
        ["Της 7ης Οκτωβρίου 2026", "2026-10-07"],
        ["ΤΗΣ 12ΗΣ ΣΥΝΕΔΡΙΑΣΗΣ ΤΗΣ 17ης ΜΑΡΤΙΟΥ 2025", "2025-03-17"],
        ["σήμερα στις 27 Ιανουαρίου του έτους 2021, ημέρα Τετάρτη", "2021-01-27"],
        ["ΠΡΑΚΤΙΚΟ ΤΗΣ 16/24.07.2017 ΣΥΝΕΔΡΙΑΣΗΣ", "2017-07-24"],
        ["ΔΗΜΟΤΙΚΗ ΠΕΡΙΟΔΟΣ 2024 - 2028", null],
    ])("%s → %s", (line, date) => {
        expect(findDate(line)).toBe(date);
    });
});

describe("findSessionNumber", () => {
    it.each([
        ["27ης (TAKTΙΚΗΣ) ΣΥΝΕΔΡΙΑΣΗΣ", 27],
        ["ΣΥΝΕΔΡIΑΣΗ 20η 7.10.2026", 20],
        ["Συνεδρίαση 19η (με τηλεδιάσκεψη)", 19],
        ["ΤΗΣ 12ΗΣ ΣΥΝΕΔΡΙΑΣΗΣ", 12],
        ["ΠΡΑΚΤΙΚΟ 1ο", 1],
        ["ΠΡΑΚΤΙΚΟ ΤΗΣ 16/24.07.2017 ΣΥΝΕΔΡΙΑΣΗΣ ΤΟΥ", 16],
        ["ΘΕΜΑ 5ο: Έγκριση πρακτικών 15ης συνεδρίασης", null],
        ["ΔΗΜΟΤΙΚΟΥ ΣΥΜΒΟΥΛΙΟΥ", null],
        // The day of a date is not a session number.
        ["ΣΥΝΕΔΡΙΑΣΗ ΤΗΣ 20ης ΟΚΤΩΒΡΙΟΥ 2025", null],
        ["ΠΡΑΚΤΙΚΑ ΤΗΣ 17ης ΜΑΡΤΙΟΥ 2025 ΣΥΝΕΔΡΙΑΣΗΣ", null],
        ["ΠΡΑΚΤΙΚΑ 12ης ΣΥΝΕΔΡΙΑΣΗΣ ΤΗΣ 17ης ΜΑΡΤΙΟΥ 2025", 12],
    ])("%s → %s", (line, number) => {
        expect(findSessionNumber(line)).toBe(number);
    });
});

describe("splitSections and pickSection", () => {
    const meeting = (n: number, date: string, firstPage: number): MinutesPage[] => [
        { page: firstPage, lines: ["ΠΡΑΚΤΙΚΑ", `${n}ης ΣΥΝΕΔΡΙΑΣΗΣ`, date, "ΠΡΟΕΔΡΟΣ: Καλησπέρα."] },
        { page: firstPage + 1, lines: ["ΔΗΜΑΡΧΟΣ: Καλησπέρα και από εμένα.", `Συνεδρίαση ${n}η συνεχίζεται`] },
    ];

    it("cuts one section per meeting and merges the pages that restate the same session", () => {
        const sections = splitSections([...meeting(26, "6/10/2025", 1), ...meeting(27, "20/10/2025", 3)]);
        expect(sections.map(s => [s.sessionNumber, s.date, s.page, s.pages])).toEqual([[26, "2025-10-06", 1, 2], [27, "2025-10-20", 3, 2]]);
    });

    it("reads a document without session headers as one section with no identity", () => {
        const sections = splitSections([{ page: 1, lines: ["ΠΡΟΕΔΡΟΣ: Καλησπέρα."] }, { page: 2, lines: ["ΔΗΜΑΡΧΟΣ: Ναι."] }]);
        expect(sections).toHaveLength(1);
        expect(sections[0]).toMatchObject({ sessionNumber: null, date: null, page: 1, pages: 2 });
        expect(pickSection(sections, "2025-10-20", 27)).toBe(sections[0]);
    });

    it("gives a cover page that states no session to the meeting that follows it", () => {
        const cover: MinutesPage = { page: 1, lines: ["ΔΗΜΟΣ ΠΟΡΟΥ", "ΠΡΑΚΤΙΚΑ ΔΗΜΟΤΙΚΟΥ ΣΥΜΒΟΥΛΙΟΥ"] };
        const sections = splitSections([cover, ...meeting(12, "17/03/2025", 2)]);
        expect(sections).toHaveLength(1);
        expect(sections[0]).toMatchObject({ sessionNumber: 12, date: "2025-03-17", page: 1, pages: 3 });
        expect(sections[0].lines[0]).toEqual({ text: "ΔΗΜΟΣ ΠΟΡΟΥ", page: 1 });
        const several = splitSections([cover, ...meeting(12, "17/03/2025", 2), ...meeting(13, "31/03/2025", 4)]);
        expect(several.map(s => [s.sessionNumber, s.page, s.pages])).toEqual([[12, 1, 3], [13, 4, 2]]);
        expect(pickSection(several, "2025-03-17", null).sessionNumber).toBe(12);
    });

    it("picks the section by date, and by session number when given", () => {
        const sections = splitSections([...meeting(26, "6/10/2025", 1), ...meeting(27, "20/10/2025", 3)]);
        expect(pickSection(sections, "2025-10-20", null).sessionNumber).toBe(27);
        expect(pickSection(sections, "2025-10-06", 26).sessionNumber).toBe(26);
        expect(pickSection(sections, null, 26).sessionNumber).toBe(26);
    });

    it("matches a section that states its session but no date on any date", () => {
        const sections = splitSections([
            { page: 1, lines: ["ΠΡΑΚΤΙΚΑ", "27ης ΣΥΝΕΔΡΙΑΣΗΣ", "ΠΡΟΕΔΡΟΣ: Καλησπέρα."] },
            { page: 2, lines: ["ΠΡΑΚΤΙΚΑ", "28ης ΣΥΝΕΔΡΙΑΣΗΣ", "ΠΡΟΕΔΡΟΣ: Καλησπέρα."] },
        ]);
        expect(sections.map(s => [s.sessionNumber, s.date])).toEqual([[27, null], [28, null]]);
        expect(pickSection(sections, "2025-10-20", 27)).toBe(sections[0]);
        expect(() => pickSection(sections, "2025-10-20", null)).toThrow(/2 sections/);
    });

    it("fails with the reason when no section or several sections match", () => {
        const sections = splitSections([...meeting(26, "6/10/2025", 1), ...meeting(27, "20/10/2025", 3)]);
        expect(() => pickSection(sections, "2025-11-03", null)).toThrow(/no section of the minutes matches the meeting of 2025-11-03; the document holds: session 26 of 2025-10-06 \(pages 1–2\); session 27/);
        expect(() => pickSection(sections, "2025-10-20", 26)).toThrow(/no section/);
        const sameDay = splitSections([...meeting(27, "20/10/2025", 1), ...meeting(28, "20/10/2025", 3)]);
        expect(() => pickSection(sameDay, "2025-10-20", null)).toThrow(/2 sections of the minutes match the meeting of 2025-10-20: session 27/);
    });

    it("does not start a section on a page whose first lines quote another session in speech", () => {
        const sections = splitSections([
            ...meeting(27, "20/10/2025", 1),
            { page: 3, lines: ["Το 1ο θέμα είναι η έγκριση των πρακτικών της 26ης συνεδρίασης, που είχαμε", "ΔΗΜΑΡΧΟΣ: Ναι."] },
            { page: 4, lines: ["ΠΡΟΕΔΡΟΣ: Όπως είπα για τα πρακτικά της 25ης συνεδρίασης, εγκρίνονται.", "ΔΗΜΑΡΧΟΣ: Ναι."] },
        ]);
        expect(sections.map(s => [s.sessionNumber, s.pages])).toEqual([[27, 4]]);
    });

    it("keeps the pages that restate the same session in one section", () => {
        const sections = splitSections([...meeting(27, "20/10/2025", 1), { page: 3, lines: ["ΤΕΛΟΣ"] }, ...meeting(27, "20/10/2025", 4)]);
        expect(sections).toHaveLength(1);
        expect(sections[0].pages).toBe(5);
    });

    it("cuts a document of several meetings before it strips their running titles", () => {
        // Three meetings of six pages each; every page of a meeting repeats its title at the top and carries a page number.
        const pages: MinutesPage[] = [];
        const speech = (page: number) => `ΠΡΟΕΔΡΟΣ: Λόγια της σελίδας ${"αβγδεζηθικλμνξοπρστ"[page]}.`;
        for (const [n, date, first] of [[26, "6/10/2025", 1], [27, "20/10/2025", 7], [28, "3/11/2025", 13]] as const) {
            for (let i = 0; i < 6; i++) {
                pages.push({ page: first + i, lines: [`ΠΡΑΚΤΙΚΑ ${n}ης ΣΥΝΕΔΡΙΑΣΗΣ – ${date}`, speech(first + i), String(first + i)] });
            }
        }
        const sections = splitSections(pages);
        expect(sections.map(s => [s.sessionNumber, s.date, s.page, s.pages, s.stripped])).toEqual([
            [26, "2025-10-06", 1, 6, 12], [27, "2025-10-20", 7, 6, 12], [28, "2025-11-03", 13, 6, 12],
        ]);
        expect(sections[1].lines.map(l => l.text)).toEqual(Array.from({ length: 6 }, (_, i) => speech(7 + i)));
        expect(pickSection(sections, "2025-10-20", 27).page).toBe(7);
        expect(() => pickSection(sections, "2025-12-01", 29)).toThrow(/no section/);
    });
});
