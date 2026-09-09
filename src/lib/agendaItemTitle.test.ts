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

    it("drops the full stop that ends an agenda item", () => {
        expect(normalizeAgendaItemTitle("Έγκριση της κίνησης του Δημοτικού Ταμείου.")).toBe("Έγκριση της κίνησης του Δημοτικού Ταμείου");
        expect(normalizeAgendaItemTitle("ΑΝΑΚΟΙΝΩΣΕΙΣ – ΕΡΩΤΗΣΕΙΣ – ΕΠΙΤΡΟΠΕΣ.")).toBe("ΑΝΑΚΟΙΝΩΣΕΙΣ – ΕΡΩΤΗΣΕΙΣ – ΕΠΙΤΡΟΠΕΣ");
        expect(normalizeAgendaItemTitle("3η τροποποίηση τεχνικού προγράμματος έτους 2026.")).toBe("3η τροποποίηση τεχνικού προγράμματος έτους 2026");
    });

    it("keeps the stop that ends an abbreviation", () => {
        // Stripping it would rewrite the abbreviation itself.
        expect(normalizeAgendaItemTitle("Διαγραφή από Χρηματικούς Καταλόγους Τ.Α.Π.")).toBe("Διαγραφή από Χρηματικούς Καταλόγους Τ.Α.Π.");
        expect(normalizeAgendaItemTitle("Σύμβαση με την ΤΡΑΠΕΖΑ ALPHA BANK Α.Ε.")).toBe("Σύμβαση με την ΤΡΑΠΕΖΑ ALPHA BANK Α.Ε.");
        expect(normalizeAgendaItemTitle("Ορισμός Προέδρων Συμβουλίων Δ.Κ.")).toBe("Ορισμός Προέδρων Συμβουλίων Δ.Κ.");
    });

    it("drops a run of stops, not only the last one", () => {
        // «Στ. Ελλάδας..» — argithea/mar26_2026 closes the item with two stops.
        expect(normalizeAgendaItemTitle("Αποκεντρωμένης Διοίκησης Θεσσαλίας – Στ. Ελλάδας..")).toBe("Αποκεντρωμένης Διοίκησης Θεσσαλίας – Στ. Ελλάδας");
        expect(normalizeAgendaItemTitle("Έγκριση προϋπολογισμού...")).toBe("Έγκριση προϋπολογισμού");
    });

    it("keeps one stop when a run closes an abbreviation", () => {
        expect(normalizeAgendaItemTitle("Καταλόγους Τ.Α.Π..")).toBe("Καταλόγους Τ.Α.Π.");
        expect(normalizeAgendaItemTitle("στην ΤΡΑΠΕΖΑ ALPHA BANK Α.Ε..")).toBe("στην ΤΡΑΠΕΖΑ ALPHA BANK Α.Ε.");
    });

    it("drops the stop after a closing bracket, keeping the abbreviation inside", () => {
        expect(normalizeAgendaItemTitle("Κοπή ξηρών δένδρων (σχετ. η 332/2026 Α.Δ.Ε.).")).toBe("Κοπή ξηρών δένδρων (σχετ. η 332/2026 Α.Δ.Ε.)");
    });

    it("leaves other terminal punctuation alone", () => {
        expect(normalizeAgendaItemTitle("Παραχώρηση χώρου «ΜΠΡΙΚΙ»")).toBe("Παραχώρηση χώρου «ΜΠΡΙΚΙ»");
        expect(normalizeAgendaItemTitle("Ερώτηση προς τον Δήμαρχο;")).toBe("Ερώτηση προς τον Δήμαρχο;");
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
