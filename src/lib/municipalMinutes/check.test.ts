import { describe, it, expect, vi } from "vitest";

const { mockAiChat } = vi.hoisted(() => ({ mockAiChat: vi.fn() }));
vi.mock("../ai.js", async importOriginal => ({ ...(await importOriginal<typeof import("../ai.js")>()), aiChat: mockAiChat }));

import { applyCheckAnswers, checkTurns, chunkSection, locateBoundary, locateMissedTurn, markChunk } from "./check.js";
import { parseTurns } from "./turns.js";

const lines = [
    "ΠΡΟΕΔΡΟΣ: Καλησπέρα σας. Ο κύριος Γκιων;",
    "κ. Γκιων: Παρών.",
    "ΠΡΟΕΔΡΟΣ: Ωραία. Ο κύριος Ροΐδης;",
    "κ. Ροΐδης: Παρών.",
    "ΜΕΙΟΝ: 5.000,00",
    "ΜΕΙΟΝ: 7.000,00",
    "ΠΡΟΕΔΡΟΣ: Προχωράμε.",
    "κ. Ροΐδης: Ευχαριστώ.",
].map(text => ({ text, page: 7 }));

describe("chunkSection", () => {
    it("cuts at line ends and repeats the tail of a chunk at the start of the next", () => {
        const text = Array.from({ length: 50 }, (_, i) => `γραμμή ${i} κείμενο`).join("\n") + "\n";
        const chunks = chunkSection(text, 300, 60);
        expect(chunks.length).toBeGreaterThan(2);
        for (let i = 1; i < chunks.length; i++) {
            expect(chunks[i].start).toBeLessThan(chunks[i - 1].end);
            expect(text[chunks[i].start - 1]).toBe("\n");
        }
        expect(chunks[chunks.length - 1].end).toBe(text.length);
    });
});

describe("markChunk, locateBoundary and locateMissedTurn", () => {
    const parsed = parseTurns(lines, []);
    const chunk = { start: 0, end: parsed.section.text.length };

    it("marks the parser's turn starts for the model", () => {
        const marked = markChunk(parsed.section.text, chunk, parsed.boundaries);
        expect(marked.split("⟦T⟧ ").length - 1).toBe(parsed.boundaries.length);
        expect(marked.startsWith("⟦T⟧ ΠΡΟΕΔΡΟΣ:")).toBe(true);
    });

    it("finds a marked label by its label and first words, and tells recurring labels apart by the words", () => {
        const found = locateBoundary(parsed.section.text, chunk, parsed.boundaries, { label: "ΠΡΟΕΔΡΟΣ", firstWords: "Ωραία. Ο κύριος Ροΐδης" });
        expect(found?.offset).toBe(parsed.section.text.indexOf("ΠΡΟΕΔΡΟΣ: Ωραία"));
        // The model's copy of the first words drops the punctuation.
        expect(locateBoundary(parsed.section.text, chunk, parsed.boundaries, { label: "ΠΡΟΕΔΡΟΣ:", firstWords: "Ωραία Ο κύριος" })?.offset).toBe(found?.offset);
        expect(locateBoundary(parsed.section.text, chunk, parsed.boundaries, { label: "ΠΡΟΕΔΡΟΣ", firstWords: "κάτι που δεν υπάρχει" })).toBeNull();
    });

    it("locates a missed turn at a line start by its label and first words", () => {
        const found = locateMissedTurn(parsed.section.text, chunk, { label: "κ. Γκιων", firstWords: "Παρών." });
        expect(found?.offset).toBe(parsed.section.text.indexOf("κ. Γκιων:"));
        expect(parsed.section.text.slice(found!.labelEnd)).toMatch(/^Παρών\./);
        expect(locateMissedTurn(parsed.section.text, chunk, { label: "κ. Ροΐδης", firstWords: "Ευχαριστώ" })?.offset).toBe(parsed.section.text.indexOf("κ. Ροΐδης: Ευχαριστώ"));
        expect(locateMissedTurn(parsed.section.text, chunk, { label: "κύριος Γκιων", firstWords: "Παρών" })).toBeNull();
    });
});

describe("applyCheckAnswers", () => {
    const parsed = parseTurns(lines, []);
    const chunks = [{ start: 0, end: parsed.section.text.length }];

    it("adds the missed turns, removes the labels that are not speakers, and drops what it cannot find", () => {
        expect(parsed.turns.map(t => t.key)).toEqual(["προεδροσ", "προεδροσ", "κ. ροιδησ", "μειον", "μειον", "προεδροσ", "κ. ροιδησ"]);
        const outcome = applyCheckAnswers(parsed.section, parsed.boundaries, chunks, [{
            notSpeakers: [{ label: "ΜΕΙΟΝ", firstWords: "5.000,00" }, { label: "ΜΕΙΟΝ", firstWords: "7.000,00" }, { label: "ΣΥΝΟΛΟ", firstWords: "7" }],
            missedTurns: [{ label: "κ. Γκιων", firstWords: "Παρών." }, { label: "κ. Ροΐδης", firstWords: "Παρών." }, { label: "ΑΝΥΠΑΡΚΤΟΣ", firstWords: "τίποτα" }],
        }]);
        expect(outcome).toMatchObject({ added: 1, removed: 2, dropped: 2, failedChunks: 0 });
        expect(outcome.boundaries.map(b => b.key)).toEqual(["προεδροσ", "κ. γκιων", "προεδροσ", "κ. ροιδησ", "προεδροσ", "κ. ροιδησ"]);
    });

    it("leaves the parser's boundaries alone in a chunk whose call failed", () => {
        const outcome = applyCheckAnswers(parsed.section, parsed.boundaries, chunks, [null]);
        expect(outcome).toMatchObject({ added: 0, removed: 0, dropped: 0, failedChunks: 1 });
        expect(outcome.boundaries).toEqual(parsed.boundaries);
    });

    it("counts a turn start or a label that two overlapping chunks both report once", () => {
        const text = parsed.section.text;
        // Both chunks hold the «κ. Γκιων» line and the first «ΜΕΙΟΝ» line, as chunkSection's overlap does.
        const overlapping = [{ start: 0, end: text.indexOf("ΜΕΙΟΝ: 7") }, { start: text.indexOf("κ. Γκιων"), end: text.length }];
        const answer = { notSpeakers: [{ label: "ΜΕΙΟΝ", firstWords: "5.000,00" }], missedTurns: [{ label: "κ. Γκιων", firstWords: "Παρών." }] };
        const outcome = applyCheckAnswers(parsed.section, parsed.boundaries, overlapping, [answer, answer]);
        expect(outcome).toMatchObject({ added: 1, removed: 1, dropped: 0 });
        expect(outcome.boundaries.filter(b => b.key === "κ. γκιων")).toHaveLength(1);
    });

    it("gives an added turn the key the parser would give its label", () => {
        const found = locateMissedTurn(parsed.section.text, chunks[0], { label: "Ο κ. Γκιων", firstWords: "" });
        expect(found).toBeNull();
        const added = applyCheckAnswers(parsed.section, parsed.boundaries, chunks, [{ notSpeakers: [], missedTurns: [{ label: "κ. Γκιων:", firstWords: "Παρών" }] }]);
        expect(added.boundaries.find(b => b.label === "κ. Γκιων")?.key).toBe("κ. γκιων");
    });
});

describe("checkTurns", () => {
    it("keeps the parser's boundaries and counts the chunk when the model call fails", async () => {
        mockAiChat.mockRejectedValue(new Error("overloaded"));
        const parsed = parseTurns(lines, []);
        const { result } = await checkTurns(parsed.section, parsed.boundaries);
        expect(result).toMatchObject({ added: 0, removed: 0, dropped: 0, failedChunks: 1 });
        expect(result.boundaries).toEqual(parsed.boundaries);
    });
});
