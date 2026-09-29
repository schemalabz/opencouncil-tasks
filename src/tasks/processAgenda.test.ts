import { describe, it, expect, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

// processAgenda.ts imports the AI client, the enrichment, and the document
// reader at module level. These are mocked so no network or model call runs.
// The extractAgendaSubjects tests below drive the aiChat and
// fetchAgendaDocument mocks directly.
vi.mock("../lib/ai.js", () => ({ aiChat: vi.fn(), addUsage: vi.fn(), NO_USAGE: {} }));
vi.mock("../lib/subjectEnrichment.js", () => ({ enrichSubjectData: vi.fn() }));
vi.mock("../lib/documentConversion.js", () => ({ fetchAgendaDocument: vi.fn() }));
vi.mock("../lib/usageLogging.js", () => ({ logMultiPhaseUsage: vi.fn() }));

import {
    normalizeExtractedTitles,
    fillMissingAgendaIndices,
    normalizeExtractedSections,
    warnDuplicateAgendaPositions,
    getSystemPrompt,
    extractedSubjectToApiSubject,
    extractAgendaSubjects,
    AGENDA_EXTRACTION_SCHEMA,
    type ExtractedSubject,
} from "./processAgenda.js";
import { AGENDA_ITEM_TITLE_RULES } from "../lib/agendaItemTitle.js";
import { enrichSubjectData } from "../lib/subjectEnrichment.js";
import { aiChat, type ResultWithUsage } from "../lib/ai.js";
import { fetchAgendaDocument } from "../lib/documentConversion.js";

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

    it("forbids composing a section title and names the body line for a bundled invitation", () => {
        const prompt = getSystemPrompt("el");

        // A bundled PDF has no heading over each invitation, so the model used to
        // invent one ("Πρόσκληση 43 — ..."). It must quote the letterhead instead.
        expect(prompt).toContain("ΜΗΝ συνθέτεις δικό σου τίτλο");
        expect(prompt).toContain("ΔΗΜΟΤΙΚΗ ΕΠΙΤΡΟΠΗ");
    });

    it("declares the section fields and tells the model to keep the printed number", () => {
        const prompt = getSystemPrompt("el");

        expect(prompt).toContain("agendaSectionIndex: number | null;");
        expect(prompt).toContain("agendaSectionTitle: string | null;");
        expect(prompt).toContain("ΜΗΝ αλλάζεις την αρίθμηση");
        expect(prompt).toContain("ΓΕΝΙΚΑ ΘΕΜΑΤΑ");
    });
});

describe("AGENDA_EXTRACTION_SCHEMA", () => {
    it("declares agendaItemTitle as nullable and requires it", () => {
        expect(AGENDA_EXTRACTION_SCHEMA.items.properties.agendaItemTitle).toEqual({ type: ["string", "null"] });
        expect(AGENDA_EXTRACTION_SCHEMA.items.required).toContain("agendaItemTitle");
    });

    it("declares the section fields as nullable and requires them", () => {
        expect(AGENDA_EXTRACTION_SCHEMA.items.properties.agendaSectionIndex).toEqual({ type: ["number", "null"] });
        expect(AGENDA_EXTRACTION_SCHEMA.items.properties.agendaSectionTitle).toEqual({ type: ["string", "null"] });
        expect(AGENDA_EXTRACTION_SCHEMA.items.required).toContain("agendaSectionIndex");
        expect(AGENDA_EXTRACTION_SCHEMA.items.required).toContain("agendaSectionTitle");
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
            agendaSectionIndex: null,
            agendaSectionTitle: null,
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

    it("forwards a section as one object, and no section as null", async () => {
        vi.mocked(enrichSubjectData).mockResolvedValue({ result: {}, usage: {}, resolvedModel: "m", batchMode: false } as never);

        const base: ExtractedSubject = {
            name: "Παράταση ωραρίου",
            description: "Παράταση ωραρίου μουσικής.",
            agendaItemTitle: "“ΚΑΦΕ ΜΠΑΡ” στην οδό Χ",
            agendaItemIndex: 3,
            agendaSectionIndex: 2,
            agendaSectionTitle: "ΠΑΡΑΤΑΣΕΙΣ ΩΡΑΡΙΟΥ ΜΟΥΣΙΚΗΣ",
            introducedByPersonId: null,
            speakerContributions: [],
            locationText: null,
            topicLabel: null,
            topicImportance: "normal",
            proximityImportance: "none",
        };

        await extractedSubjectToApiSubject(base, "Αθήνα", "el", undefined, "2026-09-05");
        expect(vi.mocked(enrichSubjectData).mock.calls.at(-1)![0]).toMatchObject({
            agendaSection: { index: 2, title: "ΠΑΡΑΤΑΣΕΙΣ ΩΡΑΡΙΟΥ ΜΟΥΣΙΚΗΣ" },
        });

        await extractedSubjectToApiSubject({ ...base, agendaSectionIndex: null, agendaSectionTitle: null }, "Αθήνα", "el", undefined, "2026-09-05");
        expect(vi.mocked(enrichSubjectData).mock.calls.at(-1)![0]).toMatchObject({ agendaSection: null });
    });
});

describe("extractAgendaSubjects", () => {
    it("renumbers sections, fills a missing index within its section, and collapses a title", async () => {
        const usage: Anthropic.Messages.Usage = {
            input_tokens: 120,
            output_tokens: 45,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            cache_creation: null,
            server_tool_use: null,
            service_tier: null,
            inference_geo: null,
            output_tokens_details: null,
        };
        const modelItems: Omit<ExtractedSubject, "speakerContributions">[] = [
            {
                name: "Γλυπτό",
                description: "Περιγραφή για Γλυπτό.",
                agendaItemTitle: "ΤΙΤΛΟΣ  Α",
                agendaItemIndex: 1,
                agendaSectionIndex: 3,
                agendaSectionTitle: "ΓΕΝΙΚΑ ΘΕΜΑΤΑ",
                introducedByPersonId: null,
                locationText: null,
                topicLabel: null,
                topicImportance: "normal",
                proximityImportance: "none",
            },
            {
                name: "Παρέα",
                description: "Περιγραφή για Παρέα.",
                agendaItemTitle: "ΤΙΤΛΟΣ Παρέα",
                agendaItemIndex: null,
                agendaSectionIndex: 7,
                agendaSectionTitle: "ΠΑΡΑΤΑΣΕΙΣ ΩΡΑΡΙΟΥ ΜΟΥΣΙΚΗΣ",
                introducedByPersonId: null,
                locationText: null,
                topicLabel: null,
                topicImportance: "normal",
                proximityImportance: "none",
            },
        ];
        vi.mocked(fetchAgendaDocument).mockResolvedValue({ kind: "pdf", base64: "" });
        vi.mocked(aiChat).mockResolvedValue({
            result: modelItems,
            usage,
            resolvedModel: "m",
            batchMode: false,
        } as ResultWithUsage<Omit<ExtractedSubject, "speakerContributions">[]>);

        const extraction = await extractAgendaSubjects({
            agendaUrl: "https://example.org/agenda.pdf",
            people: [],
            topicLabels: [],
            cityName: "Αθήνα",
            cityLanguage: "el",
            date: "2026-09-05",
        }, () => { });

        // The two sections (3, 7) are renumbered to 1, 2 in order of appearance.
        expect(extraction.extracted.map(s => [s.name, s.agendaSectionIndex, s.agendaItemIndex])).toEqual([
            ["Γλυπτό", 1, 1], ["Παρέα", 2, 1],
        ]);
        expect(extraction.extracted.map(s => s.agendaSectionTitle)).toEqual([
            "ΓΕΝΙΚΑ ΘΕΜΑΤΑ", "ΠΑΡΑΤΑΣΕΙΣ ΩΡΑΡΙΟΥ ΜΟΥΣΙΚΗΣ",
        ]);
        // A double space in the first item's title is collapsed to one.
        expect(extraction.extracted[0].agendaItemTitle).toBe("ΤΙΤΛΟΣ Α");
        // The second item's missing index is filled to 1, the first number
        // within its own (renumbered) section.
        expect(extraction.warnings).toHaveLength(1);
        expect(extraction.warnings[0].code).toBe("MISSING_AGENDA_ITEM_INDEX");
        expect(extraction.extracted.map(s => s.speakerContributions)).toEqual([[], []]);
        expect(extraction.extraction.usage).toEqual(usage);
    });
});

describe("normalizeExtractedSections", () => {
    const item = (name: string, agendaSectionIndex: number | null, agendaSectionTitle: string | null) =>
        ({ name, agendaSectionIndex, agendaSectionTitle });

    it("collapses whitespace in titles and keeps a two-section agenda as it is", () => {
        const subjects = [
            item("Γλυπτό", 1, "ΓΕΝΙΚΑ  ΘΕΜΑΤΑ"),
            item("Στέγη", 1, "ΓΕΝΙΚΑ ΘΕΜΑΤΑ"),
            item("Παρέα", 2, "ΠΑΡΑΤΑΣΕΙΣ ΩΡΑΡΙΟΥ\nΜΟΥΣΙΚΗΣ"),
        ];

        const warnings = normalizeExtractedSections(subjects);

        expect(warnings).toEqual([]);
        expect(subjects.map(s => [s.agendaSectionIndex, s.agendaSectionTitle])).toEqual([
            [1, "ΓΕΝΙΚΑ ΘΕΜΑΤΑ"], [1, "ΓΕΝΙΚΑ ΘΕΜΑΤΑ"], [2, "ΠΑΡΑΤΑΣΕΙΣ ΩΡΑΡΙΟΥ ΜΟΥΣΙΚΗΣ"],
        ]);
    });

    it("drops a half section and names the subject", () => {
        const subjects = [
            item("Γλυπτό", 1, "ΓΕΝΙΚΑ ΘΕΜΑΤΑ"),
            item("Στέγη", 1, null),
            item("Παρέα", null, "ΠΑΡΑΤΑΣΕΙΣ"),
            item("Μπρίκι", 2, "ΠΑΡΑΤΑΣΕΙΣ"),
        ];

        const warnings = normalizeExtractedSections(subjects);

        expect(warnings.map(w => w.code)).toEqual(["INCONSISTENT_AGENDA_SECTION", "PARTIAL_AGENDA_SECTIONS"]);
        expect(warnings[0].message).toContain("Στέγη");
        expect(warnings[0].message).toContain("Παρέα");
        expect(warnings[0].message).not.toContain("Γλυπτό");
        expect(subjects[1]).toEqual(item("Στέγη", null, null));
        expect(subjects[2]).toEqual(item("Παρέα", null, null));
    });

    it("turns one section shared by every item into no section", () => {
        const subjects = [
            item("Προϋπολογισμός", 1, "ΘΕΜΑΤΑ ΗΜΕΡΗΣΙΑΣ ΔΙΑΤΑΞΗΣ"),
            item("Οδοποιία", 1, "ΘΕΜΑΤΑ ΗΜΕΡΗΣΙΑΣ ΔΙΑΤΑΞΗΣ"),
        ];

        const warnings = normalizeExtractedSections(subjects);

        expect(warnings).toEqual([]);
        expect(subjects.every(s => s.agendaSectionIndex === null && s.agendaSectionTitle === null)).toBe(true);
    });

    it("leaves an agenda with no sections untouched and silent", () => {
        const subjects = [item("Προϋπολογισμός", null, null), item("Οδοποιία", null, null)];

        expect(normalizeExtractedSections(subjects)).toEqual([]);
        expect(subjects).toEqual([item("Προϋπολογισμός", null, null), item("Οδοποιία", null, null)]);
    });

    it("warns when only some items carry a section and keeps what the model said", () => {
        const subjects = [
            item("Γλυπτό", 1, "ΓΕΝΙΚΑ ΘΕΜΑΤΑ"),
            item("Παρέα", 2, "ΠΑΡΑΤΑΣΕΙΣ"),
            item("Λογοδοσία", null, null),
        ];

        const warnings = normalizeExtractedSections(subjects);

        expect(warnings.map(w => w.code)).toEqual(["PARTIAL_AGENDA_SECTIONS"]);
        expect(warnings[0].message).toContain("Λογοδοσία");
        expect(subjects[2]).toEqual(item("Λογοδοσία", null, null));
        expect(subjects[0].agendaSectionIndex).toBe(1);
    });

    it("renumbers sections 1..K by the model's own index", () => {
        const subjects = [
            item("Α1", 0, "Α. Θέματα παρ.2"),
            item("Β1", 5, "Β. Τακτικά θέματα"),
            item("Β2", 5, "Β. Τακτικά θέματα"),
            item("Α2", 0, "Α. Θέματα παρ.2"),
        ];

        normalizeExtractedSections(subjects);

        expect(subjects.map(s => s.agendaSectionIndex)).toEqual([1, 2, 2, 1]);
    });

    it("emits the document's own section order, not the order the model listed", () => {
        const subjects = [
            item("Β1", 2, "Β. Τακτικά θέματα"),
            item("Β2", 2, "Β. Τακτικά θέματα"),
            item("Α1", 1, "Α. Θέματα παρ.2"),
            item("Α2", 1, "Α. Θέματα παρ.2"),
        ];

        const warnings = normalizeExtractedSections(subjects);

        expect(subjects.map(s => s.agendaSectionIndex)).toEqual([2, 2, 1, 1]);
        expect(warnings).toEqual([]);
    });

    it("a stray stop or a casing variant does not split a section", () => {
        const subjects = [
            item("Α1", 1, "ΓΕΝΙΚΑ ΘΕΜΑΤΑ"),
            item("Α2", 1, "ΓΕΝΙΚΑ ΘΕΜΑΤΑ."),
            item("Α3", 1, "Γενικά Θέματα"),
            item("Β1", 2, "ΠΑΡΑΤΑΣΕΙΣ ΩΡΑΡΙΟΥ ΜΟΥΣΙΚΗΣ"),
            item("Β2", 2, "ΠΑΡΑΤΑΣΕΙΣ ΩΡΑΡΙΟΥ ΜΟΥΣΙΚΗΣ"),
        ];

        const warnings = normalizeExtractedSections(subjects);

        expect(warnings).toEqual([]);
        expect(subjects.map(s => s.agendaSectionIndex)).toEqual([1, 1, 1, 2, 2]);
        expect(subjects.map(s => s.agendaSectionTitle)).toEqual([
            "ΓΕΝΙΚΑ ΘΕΜΑΤΑ",
            "ΓΕΝΙΚΑ ΘΕΜΑΤΑ.",
            "Γενικά Θέματα",
            "ΠΑΡΑΤΑΣΕΙΣ ΩΡΑΡΙΟΥ ΜΟΥΣΙΚΗΣ",
            "ΠΑΡΑΤΑΣΕΙΣ ΩΡΑΡΙΟΥ ΜΟΥΣΙΚΗΣ",
        ]);
    });

    it("two different titles under one index stay one section and warn", () => {
        const subjects = [
            item("Α1", 1, "ΓΕΝΙΚΑ ΘΕΜΑΤΑ"),
            item("Α2", 1, "ΓΕΝΙΚΑ ΘΕΜΑΤΑ"),
            item("Β1", 1, "ΠΑΡΑΤΑΣΕΙΣ ΩΡΑΡΙΟΥ ΜΟΥΣΙΚΗΣ"),
            item("Β2", 2, "ΑΝΑΚΟΙΝΩΣΕΙΣ"),
        ];

        const warnings = normalizeExtractedSections(subjects);

        expect(subjects.map(s => s.agendaSectionIndex)).toEqual([1, 1, 1, 2]);
        expect(subjects.map(s => s.agendaSectionTitle)).toEqual([
            "ΓΕΝΙΚΑ ΘΕΜΑΤΑ", "ΓΕΝΙΚΑ ΘΕΜΑΤΑ", "ΠΑΡΑΤΑΣΕΙΣ ΩΡΑΡΙΟΥ ΜΟΥΣΙΚΗΣ", "ΑΝΑΚΟΙΝΩΣΕΙΣ",
        ]);
        expect(warnings.map(w => w.code)).toEqual(["INCONSISTENT_AGENDA_SECTION"]);
        expect(warnings[0].message).toContain("ΓΕΝΙΚΑ ΘΕΜΑΤΑ");
        expect(warnings[0].message).toContain("ΠΑΡΑΤΑΣΕΙΣ ΩΡΑΡΙΟΥ ΜΟΥΣΙΚΗΣ");
    });

    it("collapses one section to null even when an item is unsectioned, and still warns", () => {
        const subjects = [
            item("Προϋπολογισμός", 1, "ΘΕΜΑΤΑ ΗΜΕΡΗΣΙΑΣ ΔΙΑΤΑΞΗΣ"),
            item("Οδοποιΐα", 1, "ΘΕΜΑΤΑ ΗΜΕΡΗΣΙΑΣ ΔΙΑΤΑΞΗΣ"),
            item("Λογοδοσία", null, null),
        ];

        const warnings = normalizeExtractedSections(subjects);

        expect(warnings.map(w => w.code)).toEqual(["PARTIAL_AGENDA_SECTIONS"]);
        expect(warnings[0].message).toContain("Λογοδοσία");
        expect(subjects.every(s => s.agendaSectionIndex === null && s.agendaSectionTitle === null)).toBe(true);
    });

    it("an ambiguous single index keeps its section instead of collapsing", () => {
        const subjects = [
            item("Α1", 1, "ΓΕΝΙΚΑ ΘΕΜΑΤΑ"),
            item("Β1", 1, "ΠΑΡΑΤΑΣΕΙΣ"),
        ];

        const warnings = normalizeExtractedSections(subjects);

        expect(warnings.map(w => w.code)).toEqual(["INCONSISTENT_AGENDA_SECTION"]);
        expect(subjects.map(s => s.agendaSectionIndex)).toEqual([1, 1]);
    });

    it("one section under two indices stays two sections", () => {
        const subjects = [item("Α1", 1, "Α"), item("Α2", 2, "Α")];

        const warnings = normalizeExtractedSections(subjects);

        expect(subjects.map(s => s.agendaSectionIndex)).toEqual([1, 2]);
        expect(warnings).toEqual([]);
    });
});

describe("normalizeExtractedSections — the collapse is guarded", () => {
    it("keeps the section when dropping it would put two items on one number", () => {
        // A heading over items 1-3, then a bare list numbered from 1 again. One
        // distinct section, so the old rule collapsed and merged the two runs into
        // a single numbering domain. The section is what keeps them apart.
        const subjects = [
            { name: "Γλυπτό", agendaItemIndex: 1, agendaSectionIndex: 1, agendaSectionTitle: "ΓΕΝΙΚΑ ΘΕΜΑΤΑ" },
            { name: "Στέγη", agendaItemIndex: 2, agendaSectionIndex: 1, agendaSectionTitle: "ΓΕΝΙΚΑ ΘΕΜΑΤΑ" },
            { name: "Παρέα", agendaItemIndex: 1, agendaSectionIndex: null, agendaSectionTitle: null },
            { name: "ΜΠΡΙΚΙ", agendaItemIndex: 2, agendaSectionIndex: null, agendaSectionTitle: null },
        ];

        const warnings = normalizeExtractedSections(subjects);

        expect(subjects.map(s => s.agendaSectionIndex)).toEqual([1, 1, null, null]);
        expect(subjects[0].agendaSectionTitle).toBe("ΓΕΝΙΚΑ ΘΕΜΑΤΑ");
        expect(warnings.map(w => w.code)).toEqual(["PARTIAL_AGENDA_SECTIONS"]);
    });

    it("still collapses a partial single list when the numbers do not collide", () => {
        // The common case: one heading, the model forgot it on the last item, and
        // the numbering runs straight through. There is no section to preserve.
        const subjects = [
            { name: "Δικαστικός καθορισμός", agendaItemIndex: 1, agendaSectionIndex: 1, agendaSectionTitle: "ΘΕΜΑΤΑ ΗΜΕΡΗΣΙΑΣ ΔΙΑΤΑΞΗΣ" },
            { name: "Προγραμματική σύμβαση", agendaItemIndex: 2, agendaSectionIndex: 1, agendaSectionTitle: "ΘΕΜΑΤΑ ΗΜΕΡΗΣΙΑΣ ΔΙΑΤΑΞΗΣ" },
            { name: "Επιχορήγηση", agendaItemIndex: 3, agendaSectionIndex: null, agendaSectionTitle: null },
        ];

        const warnings = normalizeExtractedSections(subjects);

        expect(subjects.every(s => s.agendaSectionIndex === null && s.agendaSectionTitle === null)).toBe(true);
        expect(warnings.map(w => w.code)).toEqual(["PARTIAL_AGENDA_SECTIONS"]);
    });

    it("an item still awaiting a number cannot block the collapse", () => {
        // fillMissingAgendaIndices runs after this and gives it a free number.
        const subjects = [
            { name: "Α", agendaItemIndex: 1, agendaSectionIndex: 1, agendaSectionTitle: "ΘΕΜΑΤΑ" },
            { name: "Β", agendaItemIndex: null, agendaSectionIndex: 1, agendaSectionTitle: "ΘΕΜΑΤΑ" },
        ];

        normalizeExtractedSections(subjects);

        expect(subjects.every(s => s.agendaSectionIndex === null)).toBe(true);
    });
});

describe("warnDuplicateAgendaPositions", () => {
    it("is silent when every (section, number) pair is unique, across sections that reuse numbers", () => {
        const subjects = [
            { name: "Γλυπτό", agendaItemIndex: 1, agendaSectionIndex: 1 },
            { name: "Παρέα", agendaItemIndex: 1, agendaSectionIndex: 2 },
            { name: "Λογοδοσία", agendaItemIndex: 2, agendaSectionIndex: null },
        ];

        expect(warnDuplicateAgendaPositions(subjects)).toEqual([]);
    });

    it("reports every repeated pair with the subjects that share it", () => {
        const subjects = [
            { name: "Καρυές", agendaItemIndex: 1, agendaSectionIndex: null },
            { name: "Καρυές (δις)", agendaItemIndex: 1, agendaSectionIndex: null },
            { name: "Ξενία", agendaItemIndex: 3, agendaSectionIndex: 2 },
            { name: "Γουδέ", agendaItemIndex: 3, agendaSectionIndex: 2 },
            { name: "Μόνο", agendaItemIndex: 4, agendaSectionIndex: 2 },
        ];

        const warnings = warnDuplicateAgendaPositions(subjects);

        expect(warnings).toHaveLength(1);
        expect(warnings[0].code).toBe("DUPLICATE_AGENDA_ITEM_INDEX");
        expect(warnings[0].message).toContain("Καρυές / Καρυές (δις)");
        expect(warnings[0].message).toContain("Ξενία / Γουδέ");
        expect(warnings[0].message).not.toContain("Μόνο");
        expect(warnings[0].message).toContain("#1: Καρυές");
        expect(warnings[0].message).toContain("2:3: Ξενία");
    });
});

describe("fillMissingAgendaIndices", () => {
    it("fills a gap after the last number of its own section", () => {
        const subjects = [
            { agendaItemIndex: 1, agendaSectionIndex: 1 },
            { agendaItemIndex: 2, agendaSectionIndex: 1 },
            { agendaItemIndex: null, agendaSectionIndex: 1 },
            { agendaItemIndex: 1, agendaSectionIndex: 2 },
            { agendaItemIndex: null, agendaSectionIndex: 2 },
            { agendaItemIndex: null, agendaSectionIndex: 2 },
        ];

        const warnings = fillMissingAgendaIndices(subjects);

        expect(subjects.map(s => s.agendaItemIndex)).toEqual([1, 2, 3, 1, 2, 3]);
        expect(warnings.map(w => w.code)).toEqual(["MISSING_AGENDA_ITEM_INDEX"]);
    });

    it("fills after the overall maximum when there are no sections", () => {
        const subjects = [{ agendaItemIndex: 4 }, { agendaItemIndex: null }, { agendaItemIndex: 2 }];

        fillMissingAgendaIndices(subjects);

        expect(subjects.map(s => s.agendaItemIndex)).toEqual([4, 5, 2]);
    });

    it("starts a section at 1 when every one of its items lacks a number", () => {
        const subjects = [
            { agendaItemIndex: null, agendaSectionIndex: 5 },
            { agendaItemIndex: null, agendaSectionIndex: 5 },
            { agendaItemIndex: 2, agendaSectionIndex: 1 },
        ];

        const warnings = fillMissingAgendaIndices(subjects);

        expect(subjects.map(s => s.agendaItemIndex)).toEqual([1, 2, 2]);
        expect(warnings.map(w => w.code)).toEqual(["MISSING_AGENDA_ITEM_INDEX"]);
    });
});
