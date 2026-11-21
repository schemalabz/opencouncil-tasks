import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = { label: string; systemPrompt: string; userPrompt: string };
const calls: Call[] = [];
const geocoded: { fn: string; args: unknown[] }[] = [];

vi.mock("./geocode.js", () => ({
    DEFAULT_COUNTRY: "GR",
    geocodeLocation: vi.fn(async (...args: unknown[]) => { geocoded.push({ fn: "geocodeLocation", args }); return { lat: 39.6, lng: 22.4 }; }),
    geocodeInRegion: vi.fn(async (...args: unknown[]) => { geocoded.push({ fn: "geocodeInRegion", args }); return { lat: 39.6, lng: 22.4 }; }),
}));

vi.mock("./documentConversion.js", async (importOriginal) => ({
    ...await importOriginal<typeof import("./documentConversion.js")>(),
    fetchAgendaDocument: vi.fn(async () => ({ kind: "html", html: "<p>Πρόσκληση</p>" })),
}));

// The model answers each step with the least that lets the task go on, and the test keeps what it was asked.
vi.mock("./ai.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./ai.js")>();
    const usage = actual.NO_USAGE;
    return {
        ...actual,
        aiChat: vi.fn(async (args: { label?: string; systemPrompt: string; userPrompt: string }) => {
            const label = args.label ?? "";
            calls.push({ label, systemPrompt: args.systemPrompt, userPrompt: args.userPrompt });
            if (label.startsWith("batch-processing")) {
                const utteranceIds = [...args.userPrompt.matchAll(/"utteranceId": "([^"]+)"/g)].map(m => m[1]);
                const segmentIds = [...args.userPrompt.matchAll(/"speakerSegmentId": "([^"]+)"/g)].map(m => m[1]);
                const subject = (id: string, locationText: string | null) => ({
                    id, type: "BEFORE_AGENDA", agendaItemIndex: "BEFORE_AGENDA", name: `Θέμα ${id}`, description: "Περιγραφή", topicImportance: "normal",
                    proximityImportance: "none", introducedByPersonId: null, locationText, topicLabel: null, speakerContributions: [], discussedIn: null,
                });
                return {
                    result: {
                        segmentSummaries: segmentIds.map(id => ({ id, summary: "s", labels: [], type: "SUBSTANTIAL" })),
                        subjects: [subject("new-001", "Πλατεία Ηρώων, Τρίκαλα"), subject("new-002", null)],
                        utteranceStatuses: utteranceIds.map((utteranceId, i) => ({ utteranceId, status: "SUBJECT_DISCUSSION", subjectId: i % 2 === 0 ? "new-001" : "new-002" })),
                        meetingProgressSummary: "πρόοδος",
                    },
                    usage,
                };
            }
            if (label === "subject-merge") return { result: { merges: [] }, usage };
            if (label.startsWith("contributions")) return { result: { speakerContributions: [] }, usage };
            if (label.startsWith("subject-context-search")) return { result: "πλαίσιο", usage };
            if (label === "transcript-fix") return { result: args.userPrompt.split("Correct the numbered utterances:")[1]?.trim() ?? "1. x", usage };
            if (label.startsWith("speaker-identification")) return { result: { identifications: [] }, usage };
            if (label === "agenda-meetings") return { result: { meetings: [] }, usage };
            if (label === "agenda-extraction") {
                return {
                    result: {
                        meetings: [],
                        subjects: [{
                            name: "Ανάπλαση", description: "Περιγραφή", agendaItemIndex: 1, agendaItemTitle: "Ανάπλαση πλατείας", agendaSectionIndex: null,
                            agendaSectionTitle: null, locationText: "Πλατεία Ηρώων, Τρίκαλα", introducedByPersonId: null, topicLabel: null, topicImportance: "normal",
                            proximityImportance: "none", meetingIndex: 0,
                        }],
                    },
                    usage,
                };
            }
            throw new Error(`no answer for the label ${label}`);
        }),
    };
});

import { summarize } from "../tasks/summarize.js";
import { processAgenda } from "../tasks/processAgenda.js";
import { fixTranscript } from "../tasks/fixTranscript.js";
import { extractAgendaMeetings } from "./agendaMeetingRecord.js";
import { enrichSubjectData } from "./subjectEnrichment.js";
import { municipalWordsIn } from "./municipalWords.js";
import type { AuthorityType } from "./authority.js";
import type { AgendaDocument } from "./documentConversion.js";
import type { FixTranscriptRequest, ProcessAgendaRequest, SummarizeRequest } from "../types.js";

const topicLabels = [{ name: "Περιβάλλον", description: "Πράσινο, απορρίμματα" }];
const people = [
    { id: "p1", name: "Μαρία Παππά", role: "Πρόεδρος", party: "Θεσσαλία Μπροστά", partyHead: true, memberOfMeetingBody: true },
    { id: "p2", name: "Νίκος Γεωργίου", role: "Αντιπεριφερειάρχης Υποδομών", party: null, memberOfMeetingBody: false },
];
const transcript = [
    {
        speakerName: "Μαρία Παππά", speakerParty: "Θεσσαλία Μπροστά", speakerRole: "Πρόεδρος", speakerId: "p1", speakerSegmentId: "seg-1", speakerTagId: "tag-1",
        text: "Καλησπέρα σας. Ξεκινάμε.",
        utterances: [
            { text: "Καλησπέρα σας.", utteranceId: "u-1", startTimestamp: 0, endTimestamp: 2 },
            { text: "Ξεκινάμε.", utteranceId: "u-2", startTimestamp: 2, endTimestamp: 4 },
        ],
    },
    {
        speakerName: null, speakerParty: null, speakerRole: null, speakerId: null, speakerSegmentId: "seg-2", speakerTagId: "tag-2",
        text: "Για την πλατεία Ηρώων.",
        utterances: [{ text: "Για την πλατεία Ηρώων.", utteranceId: "u-3", startTimestamp: 4, endTimestamp: 6 }],
    },
];
const document = { kind: "html", html: "<p>Πρόσκληση</p>" } as AgendaDocument;
const noProgress = () => { };

/** The requests as the main app sends them. Only the kind of the authority differs between the two runs. */
function runs(authorityType: AuthorityType | undefined): Record<string, () => Promise<unknown>> {
    const transcriptRequest = {
        callbackUrl: "https://example.org/api/cities/c/meetings/m/taskStatuses/t",
        transcript, topicLabels, people, cityName: "Θεσσαλία", cityLanguage: "el", date: "2026-03-04", authorityType,
    };
    const agendaRequest = {
        agendaUrl: "https://example.org/agenda.pdf",
        people: [{ id: "p1", name: "Μαρία Παππά", role: "Πρόεδρος", party: "Θεσσαλία Μπροστά" }],
        topicLabels, cityName: "Θεσσαλία", cityLanguage: "el", country: "GR", date: "2026-03-04", authorityType,
        callbackUrl: "https://example.org/api/cities/c/meetings/m/taskStatuses/t",
    } as ProcessAgendaRequest;
    return {
        summarize: () => summarize({ ...transcriptRequest, country: "GR", requestedSubjects: [], existingSubjects: [] } as unknown as SummarizeRequest, noProgress),
        fixTranscript: () => fixTranscript({ ...transcriptRequest, agendaItems: [{ name: "Έγκριση προϋπολογισμού" }] } as unknown as FixTranscriptRequest, noProgress),
        processAgenda: () => processAgenda(agendaRequest, noProgress),
        "processAgenda: meetings only": () => extractAgendaMeetings(document, { date: "2026-03-04", body: { type: "council" }, authorityType }),
        "subject enrichment": () => enrichSubjectData({
            name: "Ανάπλαση πλατείας", description: "Περιγραφή", agendaItemIndex: 1, introducedByPersonId: null, speakerContributions: [],
            topicImportance: "normal", proximityImportance: "none", locationText: "Πλατεία Ηρώων, Τρίκαλα", topicLabel: null, discussedIn: null,
        }, "id-1", { cityName: "Θεσσαλία", cityLanguage: "el", country: "GR", date: "2026-03-04", authorityType }),
    };
}

const municipalWordsAsked = () => calls.flatMap(call => municipalWordsIn(`${call.systemPrompt}\n${call.userPrompt}`).map(words => `${call.label}: ${words}`));

/**
 * The kind of the authority must go from the request to each prompt that the
 * task builds. A call site that drops it gives a region the prompt of a
 * municipality, and neither the compiler nor a test of one prompt sees that.
 */
describe("a request of a region", () => {
    beforeEach(() => {
        calls.length = 0;
        geocoded.length = 0;
    });

    it.each(Object.keys(runs("region")))("%s asks the model with no word of a municipality", async name => {
        await runs("region")[name]();

        expect(calls.length).toBeGreaterThan(0);
        expect(municipalWordsAsked()).toEqual([]);
    });

    it("the same requests of a municipality do ask with those words", async () => {
        for (const name of Object.keys(runs(undefined))) {
            calls.length = 0;
            await runs(undefined)[name]();
            expect(municipalWordsAsked(), name).not.toEqual([]);
        }
    });

    it("asks every step of summarize, of fixTranscript and of processAgenda", async () => {
        await runs("region").summarize();
        await runs("region").fixTranscript();
        await runs("region").processAgenda();

        const labels = new Set(calls.map(call => call.label.split(":")[0]));
        expect([...labels].sort()).toEqual([
            "agenda-extraction", "batch-processing", "contributions", "speaker-identification", "subject-context-search", "subject-merge", "transcript-fix",
        ]);
    });

    it("geocodes a place of a region inside the region", async () => {
        await runs("region").summarize();
        expect(geocoded).toEqual([{ fn: "geocodeInRegion", args: ["Πλατεία Ηρώων, Τρίκαλα", "Θεσσαλία", "GR"] }]);

        geocoded.length = 0;
        await runs(undefined).summarize();
        expect(geocoded).toEqual([{ fn: "geocodeLocation", args: ["Πλατεία Ηρώων, Τρίκαλα, Θεσσαλία", "GR"] }]);
    });
});
