import { describe, it, expect, vi } from "vitest";

// processAgenda.ts imports the AI client, the enrichment, and the document
// reader at module level. None of them run in this test.
vi.mock("../lib/ai.js", () => ({ aiChat: vi.fn(), addUsage: vi.fn(), NO_USAGE: {} }));
vi.mock("../lib/subjectEnrichment.js", () => ({ enrichSubjectData: vi.fn() }));
vi.mock("../lib/documentConversion.js", () => ({ fetchAgendaDocument: vi.fn() }));
vi.mock("../lib/usageLogging.js", () => ({ logMultiPhaseUsage: vi.fn() }));

import {
    normalizeExtractedTitles,
    fillMissingAgendaIndices,
    getSystemPrompt,
    extractedSubjectToApiSubject,
    AGENDA_EXTRACTION_SCHEMA,
    type ExtractedSubject,
} from "./processAgenda.js";
import { AGENDA_ITEM_TITLE_RULES } from "../lib/agendaItemTitle.js";
import { enrichSubjectData } from "../lib/subjectEnrichment.js";

describe("normalizeExtractedTitles", () => {
    it("collapses whitespace in place and returns no warning when every title is present", () => {
        const subjects = [
            { name: "Προϋπολογισμός", agendaItemTitle: "ΕΓΚΡΙΣΗ  ΠΡΟΫΠΟΛΟΓΙΣΜΟΥ\n2026" },
            { name: "Οδοποιία", agendaItemTitle: "ΕΓΚΡΙΣΗ ΜΕΛΕΤΗΣ ΟΔΟΠΟΙΙΑΣ" },
        ];

        const warnings = normalizeExtractedTitles(subjects);

        expect(warnings).toEqual([]);
        expect(subjects[0].agendaItemTitle).toBe("ΕΓΚΡΙΣΗ ΠΡΟΫΠΟΛΟΓΙΣΜΟΥ 2026");
    });

    it("turns empty titles into null and names only the affected subjects in one warning", () => {
        const subjects = [
            { name: "Προϋπολογισμός", agendaItemTitle: "ΕΓΚΡΙΣΗ ΠΡΟΫΠΟΛΟΓΙΣΜΟΥ 2026" },
            { name: "Οδοποιία", agendaItemTitle: "   " },
            { name: "Λογοδοσία", agendaItemTitle: "" },
        ];

        const warnings = normalizeExtractedTitles(subjects);

        expect(subjects[1].agendaItemTitle).toBeNull();
        expect(subjects[2].agendaItemTitle).toBeNull();
        expect(warnings).toHaveLength(1);
        expect(warnings[0].code).toBe("MISSING_AGENDA_ITEM_TITLE");
        expect(warnings[0].severity).toBe("warning");
        expect(warnings[0].message).toContain("Οδοποιία");
        expect(warnings[0].message).toContain("Λογοδοσία");
        expect(warnings[0].message).not.toContain("Προϋπολογισμός");
    });
});

describe("getSystemPrompt", () => {
    it("includes the shared agenda item title rules and declares the field", () => {
        const prompt = getSystemPrompt("el");

        expect(prompt).toContain(AGENDA_ITEM_TITLE_RULES);
        expect(prompt).toContain("agendaItemTitle: string | null;");
    });
});

describe("AGENDA_EXTRACTION_SCHEMA", () => {
    it("declares agendaItemTitle as nullable and requires it", () => {
        expect(AGENDA_EXTRACTION_SCHEMA.items.properties.agendaItemTitle).toEqual({ type: ["string", "null"] });
        expect(AGENDA_EXTRACTION_SCHEMA.items.required).toContain("agendaItemTitle");
    });
});

describe("agenda warning concatenation", () => {
    it("keeps both warning codes when one subject is missing its index and another its title", () => {
        const subjects = [
            { name: "Προϋπολογισμός", agendaItemIndex: null, agendaItemTitle: "ΕΓΚΡΙΣΗ ΠΡΟΫΠΟΛΟΓΙΣΜΟΥ 2026" },
            { name: "Οδοποιία", agendaItemIndex: 2, agendaItemTitle: "" },
        ];

        const warnings = fillMissingAgendaIndices(subjects);
        warnings.push(...normalizeExtractedTitles(subjects));

        expect(warnings.map(w => w.code).sort()).toEqual(["MISSING_AGENDA_ITEM_INDEX", "MISSING_AGENDA_ITEM_TITLE"]);
    });
});

describe("extractedSubjectToApiSubject", () => {
    it("forwards the verbatim agenda item title into the enrichment input", async () => {
        vi.mocked(enrichSubjectData).mockResolvedValue({ result: {}, usage: {}, resolvedModel: "m", batchMode: false } as never);

        const subject: ExtractedSubject = {
            name: "Προϋπολογισμός",
            description: "Έγκριση προϋπολογισμού.",
            agendaItemTitle: "ΕΓΚΡΙΣΗ ΠΡΟΫΠΟΛΟΓΙΣΜΟΥ 2026",
            agendaItemIndex: 1,
            introducedByPersonId: null,
            speakerContributions: [],
            locationText: null,
            topicLabel: null,
            topicImportance: "normal",
            proximityImportance: "none",
        };

        await extractedSubjectToApiSubject(subject, "Αθήνα", "el", undefined, "2026-09-05");

        expect(vi.mocked(enrichSubjectData).mock.calls[0][0]).toMatchObject({
            agendaItemTitle: "ΕΓΚΡΙΣΗ ΠΡΟΫΠΟΛΟΓΙΣΜΟΥ 2026",
        });
    });
});
