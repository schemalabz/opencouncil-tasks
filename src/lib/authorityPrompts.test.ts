import { describe, it, expect, vi } from "vitest";

vi.mock("./ai.js", () => ({ aiChat: vi.fn(), addUsage: vi.fn(), NO_USAGE: {}, NO_USAGE_STATS: {} }));

import { getBatchProcessingSystemPrompt, getSpeakerContributionsSystemPrompt } from "../tasks/summarize/prompts.js";
import { getMergeSubjectsSystemPrompt } from "../tasks/summarize/mergeSubjects.js";
import { getSystemPrompt as getAgendaSystemPrompt, getUserPrompt as getAgendaUserPrompt } from "../tasks/processAgenda.js";
import { buildSystemPrompt as buildFixSystemPrompt, buildUserPrompt as buildFixUserPrompt } from "../tasks/fixTranscript.js";
import { meetingsOnlySystemPrompt } from "./agendaMeetingRecord.js";
import { buildSubjectContextPrompts } from "./claudeSearch.js";
import { IMPORTANCE_GUIDELINES } from "./importanceGuidelines.js";
import { buildSystemPrompt as buildSpeakerSystemPrompt, buildUserPrompt as buildSpeakerUserPrompt } from "./speakerIdentification.js";
import type { ProcessAgendaRequest, RosterPerson } from "../types.js";

const topicLabels = [{ name: "Περιβάλλον", description: "Πράσινο, απορρίμματα, ανακύκλωση" }];

const agendaRequest: Omit<ProcessAgendaRequest, "callbackUrl"> = {
    agendaUrl: "https://example.org/agenda.pdf",
    people: [{ id: "p1", name: "Μαρία Παππά", role: "Δήμαρχος", party: "Πόλη Μπροστά" }],
    topicLabels,
    cityName: "Χαλάνδρι",
    cityLanguage: "el",
    date: "2026-03-04",
};

const roster: RosterPerson[] = [
    { id: "p1", name: "Μαρία Παππά", role: "Πρόεδρος", party: "Πόλη Μπροστά", partyHead: true, memberOfMeetingBody: true },
    { id: "p2", name: "Νίκος Δήμου", role: "Αντιδήμαρχος Καθαριότητας", party: null, memberOfMeetingBody: false },
];

/**
 * Every prompt that names the kind of the authority, as a municipality gets it.
 * The pipeline words its prompts for a region too (schemalabz/opencouncil-tasks#124),
 * and these snapshots prove that the text for a municipality stays the same,
 * character for character.
 */
describe("the prompts of a municipality", () => {
    it("summarize: batch processing", () => {
        expect(getBatchProcessingSystemPrompt({
            cityName: "Χαλάνδρι",
            cityLanguage: "el",
            date: "2026-03-04",
            topicLabels,
            administrativeBodyName: "Δημοτικό Συμβούλιο",
        })).toMatchSnapshot();
    });

    it("summarize: speaker contributions", () => {
        expect(getSpeakerContributionsSystemPrompt("Δημοτικό Συμβούλιο", "el")).toMatchSnapshot();
    });

    it("summarize: subject merge", () => {
        expect(getMergeSubjectsSystemPrompt()).toMatchSnapshot();
    });

    it("processAgenda: system prompt", () => {
        expect(getAgendaSystemPrompt("el")).toMatchSnapshot();
    });

    it("processAgenda: user prompt", () => {
        expect(getAgendaUserPrompt({ kind: "pdf", base64: "" }, agendaRequest)).toMatchSnapshot();
    });

    it("the meeting record of an invitation", () => {
        expect(meetingsOnlySystemPrompt()).toMatchSnapshot();
    });

    it("fixTranscript", () => {
        expect(buildFixSystemPrompt("el")).toMatchSnapshot();
        expect(buildFixUserPrompt("Χαλάνδρι", [{ name: "Πόλη Μπροστά", people: [{ name: "Μαρία Παππά" }] }], [{ name: "Έγκριση προϋπολογισμού" }], ["πρώτο", "δεύτερο"])).toMatchSnapshot();
    });

    it("speaker identification", () => {
        expect(buildSpeakerSystemPrompt("el")).toMatchSnapshot();
        expect(buildSpeakerUserPrompt({
            cityName: "Χαλάνδρι",
            administrativeBodyName: "Δημοτικό Συμβούλιο",
            meetingDate: "2026-03-04",
            roster,
            knownSpeakers: [],
            chunkIndex: 0,
            chunkCount: 1,
            segments: [{ speakerLabel: "S1", start: 0, end: 4, text: "Καλησπέρα σας." }],
        })).toMatchSnapshot();
    });

    it("subject context search", () => {
        expect(buildSubjectContextPrompts({
            subjectName: "Ανάπλαση πλατείας",
            subjectDescription: "Προς έγκριση η μελέτη ανάπλασης.",
            cityName: "Χαλάνδρι",
            cityLanguage: "el",
            administrativeBodyName: "Δημοτικό Συμβούλιο",
            date: "2026-03-04",
        })).toMatchSnapshot();
    });
});

/**
 * The words of a municipality. A whole word for «δήμος» and for "city", because
 * «δημόσιος», «ΔΗΜΟΣΙΕΥΣΗ» and "capacity" are not about a municipality.
 */
const MUNICIPAL_WORDS = /(?<!\p{L})δ[ηή]μ(ος|ου|ο|οι|ων|ους)(?!\p{L})|δημοτικ|δ[ηή]μ[αά]ρχ|municipal|mayor|(?<!\p{L})city(?!\p{L})/giu;

/**
 * The text that stays municipal on purpose (schemalabz/opencouncil-tasks#124):
 * - the importance guidelines, which are the notification work of the main app;
 * - `municipality`, the name of a field that opencouncil reads;
 * - «δημοτικά σχολεία», which are primary schools.
 */
function municipalWordsIn(prompt: string): string[] {
    const checked = prompt
        .replace(IMPORTANCE_GUIDELINES, "")
        .replace(/^municipality:/gm, "")
        .replace(/δημοτικά σχολεία/g, "");
    return [...checked.matchAll(MUNICIPAL_WORDS)].map(match => checked.slice(Math.max(0, match.index - 40), match.index + 40));
}

const regionRoster: RosterPerson[] = [
    { id: "p1", name: "Μαρία Παππά", role: "Πρόεδρος", party: "Θεσσαλία Μπροστά", partyHead: true, memberOfMeetingBody: true },
    { id: "p2", name: "Νίκος Γεωργίου", role: "Αντιπεριφερειάρχης Υποδομών", party: null, memberOfMeetingBody: false },
];

const regionAgendaRequest: Omit<ProcessAgendaRequest, "callbackUrl"> = {
    ...agendaRequest,
    people: [{ id: "p1", name: "Μαρία Παππά", role: "Περιφερειάρχης", party: "Θεσσαλία Μπροστά" }],
    cityName: "Θεσσαλία",
    authorityType: "region",
};

/** The same prompts as a region gets them: no word of a municipality, and the region's own words. */
describe("the prompts of a region", () => {
    const prompts: Record<string, () => string> = {
        "summarize: batch processing": () => getBatchProcessingSystemPrompt({
            cityName: "Θεσσαλία",
            cityLanguage: "el",
            date: "2026-03-04",
            topicLabels,
            administrativeBodyName: "Περιφερειακό Συμβούλιο",
            authorityType: "region",
        }),
        "summarize: speaker contributions": () => getSpeakerContributionsSystemPrompt("Περιφερειακό Συμβούλιο", "el", "region"),
        "summarize: subject merge": () => getMergeSubjectsSystemPrompt("region"),
        "processAgenda: system prompt": () => getAgendaSystemPrompt("el", "region"),
        "processAgenda: user prompt": () => getAgendaUserPrompt({ kind: "pdf", base64: "" }, regionAgendaRequest),
        "the meeting record of an invitation": () => meetingsOnlySystemPrompt("region"),
        "fixTranscript: system prompt": () => buildFixSystemPrompt("el", "region"),
        "fixTranscript: user prompt": () => buildFixUserPrompt("Θεσσαλία", [{ name: "Θεσσαλία Μπροστά", people: [{ name: "Μαρία Παππά" }] }], [{ name: "Έγκριση προϋπολογισμού" }], ["πρώτο"], "region"),
        "speaker identification: system prompt": () => buildSpeakerSystemPrompt("el", "region"),
        "speaker identification: user prompt": () => buildSpeakerUserPrompt({
            cityName: "Θεσσαλία",
            authorityType: "region",
            administrativeBodyName: "Περιφερειακό Συμβούλιο",
            meetingDate: "2026-03-04",
            roster: regionRoster,
            knownSpeakers: [],
            chunkIndex: 0,
            chunkCount: 1,
            segments: [{ speakerLabel: "S1", start: 0, end: 4, text: "Καλησπέρα σας." }],
        }),
        "subject context search: system prompt": () => buildSubjectContextPrompts({
            subjectName: "Συντήρηση επαρχιακού δρόμου",
            subjectDescription: "Προς έγκριση η μελέτη συντήρησης.",
            cityName: "Θεσσαλία",
            cityLanguage: "el",
            administrativeBodyName: "Περιφερειακό Συμβούλιο",
            date: "2026-03-04",
            authorityType: "region",
        }).systemPrompt,
        "subject context search: user prompt": () => buildSubjectContextPrompts({
            subjectName: "Συντήρηση επαρχιακού δρόμου",
            subjectDescription: "Προς έγκριση η μελέτη συντήρησης.",
            cityName: "Θεσσαλία",
            cityLanguage: "el",
            administrativeBodyName: "Περιφερειακό Συμβούλιο",
            date: "2026-03-04",
            authorityType: "region",
        }).userPrompt,
    };

    it.each(Object.keys(prompts))("%s has no word of a municipality", name => {
        expect(municipalWordsIn(prompts[name]())).toEqual([]);
    });

    it("finds the words of a municipality in the prompts of a municipality", () => {
        expect(municipalWordsIn(getAgendaSystemPrompt("el"))).not.toEqual([]);
        expect(municipalWordsIn(buildSpeakerSystemPrompt("el"))).not.toEqual([]);
        expect(municipalWordsIn("Η ΔΗΜΟΣΙΕΥΣΗ έγινε σε δημόσιο χώρο, unlistedCapacity")).toEqual([]);
    });

    it("names the region and its officers", () => {
        expect(prompts["summarize: batch processing"]()).toContain("Περιφέρεια: Θεσσαλία");
        expect(prompts["processAgenda: user prompt"]()).toContain("της περιφέρειας Θεσσαλία");
        expect(prompts["processAgenda: user prompt"]()).toContain('"ΕΙΣΗΓΗΤΗΣ: ΠΕΡΙΦΕΡΕΙΑΡΧΗΣ"');
        expect(prompts["fixTranscript: user prompt"]()).toContain("Region: Θεσσαλία");
        expect(prompts["speaker identification: user prompt"]()).toContain("Region: Θεσσαλία");
    });

    it("asks for the town of a place, which a municipality must not write", () => {
        expect(prompts["summarize: batch processing"]()).toContain("«Οδός Κύπρου 12, Λάρισα»");
        expect(prompts["processAgenda: system prompt"]()).toContain("«Οδός Κύπρου 12, Λάρισα»");
        expect(getAgendaSystemPrompt("el")).toContain("ΜΗΝ προσθέτεις πόλη, περιοχή ή χώρα");
    });

    it("gives the kinds of a region meeting with no article of the municipal Code", () => {
        const rules = meetingsOnlySystemPrompt("region");
        expect(rules).not.toMatch(/\(άρθρ/);
        expect(rules).toContain("Λογοδοσίας της περιφερειακής αρχής");
        expect(meetingsOnlySystemPrompt()).toContain("(άρθρο 150)");
    });
});
