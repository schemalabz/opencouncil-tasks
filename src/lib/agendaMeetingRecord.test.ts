import { describe, it, expect } from "vitest";
import { MEETING_SCHEMA, markBody, normalizeMeeting, pickMeeting, type MeetingOfRequest, type RawAgendaMeeting } from "./agendaMeetingRecord.js";
import { AGENDA_EXTRACTION_SCHEMA } from "../tasks/processAgenda.js";
import type { AgendaMeeting } from "../types.js";

const meeting = (overrides: Partial<AgendaMeeting> = {}): AgendaMeeting => ({
    municipality: "ΔΗΜΟΣ ΧΑΛΑΝΔΡΙΟΥ",
    bodyName: "Δημοτικό Συμβούλιο",
    ofThisBody: null,
    date: "2026-02-25",
    time: null,
    kind: "ordinary",
    kindEvidence: "τακτική συνεδρίαση",
    urgent: false,
    urgentEvidence: null,
    sessionNumber: 12,
    sessionNumberEvidence: "12η Συνεδρίαση",
    format: "inPerson",
    formatEvidence: "δια ζώσης",
    ...overrides,
});

const council = { body: { name: "Δημοτικό Συμβούλιο", type: "council" as const } };

/** As the readers call it: mark the request's body, then pick. */
const pick = (meetings: AgendaMeeting[], request: MeetingOfRequest) => pickMeeting(markBody(meetings, request.body), request);

describe("the extraction schemas", () => {
    const walk = (node: unknown, visit: (n: Record<string, unknown>, path: string) => void, path = "schema") => {
        if (!node || typeof node !== "object") return;
        visit(node as Record<string, unknown>, path);
        for (const [key, value] of Object.entries(node)) walk(value, visit, `${path}.${key}`);
    };

    it("declare no enum beside a type list, which the API rejects with a 400", () => {
        const offenders: string[] = [];
        walk(MEETING_SCHEMA, (n, path) => { if (Array.isArray(n.type) && n.enum) offenders.push(path); });
        expect(offenders).toEqual([]);
    });

    it("keep the processAgenda schema under the API's limit of 16 nullable parameters", () => {
        let nullable = 0;
        walk(AGENDA_EXTRACTION_SCHEMA, (n) => {
            if (Array.isArray(n.type) && n.type.includes("null")) nullable++;
            if (Array.isArray(n.anyOf)) nullable++;
        });
        expect(nullable).toBeLessThanOrEqual(16);
    });
});

describe("normalizeMeeting", () => {
    const raw = (overrides: Partial<RawAgendaMeeting> = {}): RawAgendaMeeting => ({
        municipality: "Δήμος Χαλανδρίου", bodyName: "Δημοτικό Συμβούλιο", date: "2026-02-25", time: "19:00", kind: "ordinary", kindEvidence: "τακτική", urgent: false, urgentEvidence: "", sessionNumber: 12,
        sessionNumberEvidence: "12η Συνεδρίαση", format: "inPerson", formatEvidence: "δια ζώσης", ...overrides,
    });

    it("drops a session number that cannot be one, with its evidence", () => {
        for (const sessionNumber of [0, -3, 1.5, 2026]) {
            const m = normalizeMeeting(raw({ sessionNumber }));
            expect(m.sessionNumber).toBeNull();
            expect(m.sessionNumberEvidence).toBeNull();
        }
    });

    it("drops a value read without its phrase, which is a guess, but keeps an ordinary kind that no phrase names", () => {
        const m = normalizeMeeting(raw({ format: "inPerson", formatEvidence: "", sessionNumberEvidence: " ", kind: "budget", kindEvidence: "", urgent: true, urgentEvidence: "" }));
        expect(m).toMatchObject({ format: null, sessionNumber: null, kind: null, urgent: false, urgentEvidence: null });
        expect(normalizeMeeting(raw({ kind: "ordinary", kindEvidence: "" })).kind).toBe("ordinary");
    });

    it("keeps an urgency read with its phrase, on any kind", () => {
        const m = normalizeMeeting(raw({ kind: "budget", kindEvidence: "ειδική συνεδρίαση για την ψήφιση του προϋπολογισμού", urgent: true, urgentEvidence: "σε κατεπείγουσα συνεδρίαση" }));
        expect(m).toMatchObject({ kind: "budget", urgent: true, urgentEvidence: "σε κατεπείγουσα συνεδρίαση" });
    });

    it("turns empty texts and a time that is not HH:MM into null, and values outside the enums into null", () => {
        const m = normalizeMeeting(raw({ bodyName: "  ", time: "7μμ", kindEvidence: "", kind: "urgent" as never, format: "mixed" as never }));
        expect(m).toMatchObject({ bodyName: null, time: null, kindEvidence: null, kind: null, format: null });
    });
});

describe("pickMeeting", () => {
    it("reports an unread record when the agenda names no meeting", () => {
        const { record, thisMeeting, warnings } = pick([], council);
        expect(record).toBeNull();
        expect(thisMeeting).toBeNull();
        expect(warnings.map(w => w.code)).toEqual(["MEETING_RECORD_UNREAD"]);
    });

    it("takes a single meeting whatever body it names, without a warning", () => {
        const { record, thisMeeting, warnings } = pick([meeting({ bodyName: null })], council);
        expect(thisMeeting).toBe(0);
        expect(record).toMatchObject({ kind: "ordinary", sessionNumber: 12 });
        expect(record).not.toHaveProperty("bodyName");
        expect(warnings).toEqual([]);
    });

    it("takes the meeting of the request's body, and still warns that the agenda holds two", () => {
        const { thisMeeting, record, warnings } = pick([
            meeting({ bodyName: "ΔΗΜΟΤΙΚΗΣ ΕΠΙΤΡΟΠΗΣ", sessionNumber: 41 }),
            meeting({ bodyName: "Δημοτικού Συμβουλίου", sessionNumber: 18 }),
        ], council);
        expect(thisMeeting).toBe(1);
        expect(record?.sessionNumber).toBe(18);
        expect(warnings.map(w => w.code)).toEqual(["MULTIPLE_MEETINGS"]);
    });

    it("takes the meeting whose body is the request's body by name over another committee in the same file", () => {
        // Σπάρτη jun23_2026: the committee, then the same people as the manager of a bequest.
        const committee = { body: { name: "Δημοτική Επιτροπή", type: "committee" as const } };
        const { thisMeeting } = pick([
            meeting({ bodyName: "ΔΗΜΟΤΙΚΗ ΕΠΙΤΡΟΠΗ", time: "08:30" }),
            meeting({ bodyName: "Δημοτική –Διαχειριστική Επιτροπή Κληροδοτήματος Ηλία Κατσίχτη", time: "08:45" }),
        ], committee);
        expect(thisMeeting).toBe(0);
    });

    it("tells two meetings of one body apart by the request's time", () => {
        const two = [
            meeting({ time: "19:00", kind: "accountability", sessionNumber: 3 }),
            meeting({ time: "20:00", kind: "ordinary", sessionNumber: 18 }),
        ];
        expect(pick(two, { ...council, time: "20:00" })).toMatchObject({ thisMeeting: 1, record: { kind: "ordinary", sessionNumber: 18 } });
    });

    it("keeps only the shared fields when the time does not tell them apart", () => {
        const { thisMeeting, record, warnings } = pick([
            meeting({ kind: "accountability", sessionNumber: 3 }),
            meeting({ kind: "ordinary", sessionNumber: 18, urgent: true, urgentEvidence: "κατεπείγουσα" }),
        ], council);
        expect(thisMeeting).toBeNull();
        expect(record).toEqual({
            kind: null, kindEvidence: null,
            urgent: false, urgentEvidence: null,
            sessionNumber: null, sessionNumberEvidence: null,
            format: "inPerson", formatEvidence: "δια ζώσης",
        });
        expect(warnings.map(w => w.code)).toEqual(["MULTIPLE_MEETINGS"]);
    });
});

describe("markBody", () => {
    const at = (bodyName: string | null) => meeting({ bodyName });

    it("matches the printed body across inflection and keeps community numbers apart", () => {
        const marked = markBody([at("ΣΥΜΒΟΥΛΙΟ 1ης ΔΗΜΟΤΙΚΗΣ ΚΟΙΝΟΤΗΤΑΣ"), at("ΣΥΜΒΟΥΛΙΟ 2ης ΔΗΜΟΤΙΚΗΣ ΚΟΙΝΟΤΗΤΑΣ")],
            { name: "1η Δημοτική Κοινότητα", type: "community" });
        expect(marked.map(m => m.ofThisBody)).toEqual([true, false]);
    });

    it("never reads a community's council as the city council, even by kind of body", () => {
        // A record with no body is the council's: the app sends the type only.
        const marked = markBody([at("Συμβούλιο 1ης Δημοτικής Κοινότητας"), at("ΔΗΜΟΤΙΚΟΥ ΣΥΜΒΟΥΛΙΟΥ"), at(null)], { type: "council" });
        expect(marked.map(m => m.ofThisBody)).toEqual([false, true, null]);
    });

    it("leaves every meeting unmarked when the request names no body", () => {
        expect(markBody([at("Δημοτική Επιτροπή")], undefined).map(m => m.ofThisBody)).toEqual([null]);
    });
});

describe("pickMeeting fallbacks", () => {
    it("falls back to every meeting when none prints the request's body, then tells them apart by time", () => {
        const r = pick([meeting({ bodyName: null, time: "19:00", sessionNumber: 3 }), meeting({ bodyName: null, time: "20:00", sessionNumber: 18 })],
            { ...council, time: "20:00" });
        expect(r.thisMeeting).toBe(1);
        expect(r.record?.sessionNumber).toBe(18);
    });

    it("keeps the body's candidates when the request's time matches none of them", () => {
        // An archive record stored at 00:00 prints no such time.
        const r = pick([meeting({ time: "19:00", kind: "accountability", sessionNumber: 3 }), meeting({ time: "20:00", sessionNumber: 18 })],
            { ...council, time: "00:00" });
        expect(r.thisMeeting).toBeNull();
        expect(r.record).toMatchObject({ kind: null, sessionNumber: null });
    });
});
