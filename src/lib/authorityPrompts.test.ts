import { describe, it, expect, vi } from "vitest";

vi.mock("./ai.js", () => ({ aiChat: vi.fn(), addUsage: vi.fn(), NO_USAGE: {}, NO_USAGE_STATS: {} }));

import { getBatchProcessingSystemPrompt, getSpeakerContributionsSystemPrompt } from "../tasks/summarize/prompts.js";
import { getMergeSubjectsSystemPrompt } from "../tasks/summarize/mergeSubjects.js";
import { getSystemPrompt as getAgendaSystemPrompt, getUserPrompt as getAgendaUserPrompt } from "../tasks/processAgenda.js";
import { buildSystemPrompt as buildFixSystemPrompt, buildUserPrompt as buildFixUserPrompt } from "../tasks/fixTranscript.js";
import { MEETINGS_ONLY_SYSTEM_PROMPT } from "./agendaMeetingRecord.js";
import { buildSubjectContextPrompts } from "./claudeSearch.js";
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
        expect(MEETINGS_ONLY_SYSTEM_PROMPT).toMatchSnapshot();
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
