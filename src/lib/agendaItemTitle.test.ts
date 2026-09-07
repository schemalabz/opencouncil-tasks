import { describe, it, expect } from "vitest";
import { AGENDA_ITEM_TITLE_RULES, normalizeAgendaItemTitle } from "./agendaItemTitle.js";

describe("normalizeAgendaItemTitle", () => {
    it("collapses whitespace and trims", () => {
        expect(normalizeAgendaItemTitle("  ΕΓΚΡΙΣΗ\n ΠΡΟΫΠΟΛΟΓΙΣΜΟΥ   2026 ")).toBe("ΕΓΚΡΙΣΗ ΠΡΟΫΠΟΛΟΓΙΣΜΟΥ 2026");
    });

    it("returns null for empty, whitespace-only, null, and undefined values", () => {
        expect(normalizeAgendaItemTitle("")).toBeNull();
        expect(normalizeAgendaItemTitle("  \n\t")).toBeNull();
        expect(normalizeAgendaItemTitle(null)).toBeNull();
        expect(normalizeAgendaItemTitle(undefined)).toBeNull();
    });

    it("keeps the printed text as it is", () => {
        const title = "ΔΙΑΓΡΑΦΗ ΟΦΕΙΛΩΝ ΑΠΟ ΠΡΟΣΤΙΜΑ Κ.Ο.Κ. (ΑΡ.ΠΡΩΤ. 12345/2026)";
        expect(normalizeAgendaItemTitle(title)).toBe(title);
    });
});

describe("AGENDA_ITEM_TITLE_RULES", () => {
    it("names the field and the rapporteur exclusion", () => {
        expect(AGENDA_ITEM_TITLE_RULES).toContain("agendaItemTitle");
        expect(AGENDA_ITEM_TITLE_RULES).toContain("ΕΙΣΗΓΗΤΗΣ");
    });
});
