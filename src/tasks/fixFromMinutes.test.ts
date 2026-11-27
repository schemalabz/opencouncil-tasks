import { describe, it, expect, vi } from "vitest";

const { mockAiChat } = vi.hoisted(() => ({ mockAiChat: vi.fn() }));
vi.mock("../lib/ai.js", async importOriginal => ({ ...(await importOriginal<typeof import("../lib/ai.js")>()), aiChat: mockAiChat }));

import { NO_USAGE } from "../lib/ai.js";
import { checkRequest, fixFromMinutesWith, timedUtterances } from "./fixFromMinutes.js";
import type { FixFromMinutesRequest } from "../types.js";
import type { MinutesPage } from "../lib/municipalMinutes/read.js";

const words = (n: number, seed: number) => Array.from({ length: n }, (_, i) => `λέξη${(i * 31 + seed * 17) % 997}`).join(" ");

const chairSpeech = `Καλησπέρα σας κυρίες και κύριοι συνάδελφοι ${words(40, 1)} ο κύριος Ρημάκης έχει τον λόγο ${words(30, 2)}`;
const memberSpeech = `Ευχαριστώ κύριε Πρόεδρε ${words(50, 3)} για τη Μεσόγειον ${words(30, 4)}`;
const minutesChair = chairSpeech.replace("Ρημάκης", "Δημάκης");
const minutesMember = memberSpeech.replace("Μεσόγειον", "Μεσογείων");

const pages: MinutesPage[] = [
    { page: 1, lines: ["ΠΡΑΚΤΙΚΑ", "27ης ΣΥΝΕΔΡΙΑΣΗΣ", "ΔΕΥΤΕΡΑ 20 ΟΚΤΩΒΡΙΟΥ 2025", "ΘΕΜΑ 1ο: Έγκριση κάτι"] },
    { page: 2, lines: [`ΠΡΟΕΔΡΟΣ: ${minutesChair}`, `Κ. ΔΗΜΑΚΗΣ: ${minutesMember}`, "ΠΡΟΕΔΡΟΣ: Ευχαριστούμε. (Διαλογικές συζητήσεις)"] },
];

const request: FixFromMinutesRequest = {
    callbackUrl: "",
    municipalMinutesUrl: "https://example.org/minutes.pdf",
    meetingDate: "2025-10-20",
    sessionNumber: 27,
    transcript: [
        {
            speakerName: null, speakerParty: null, speakerRole: null, speakerId: "chair", speakerSegmentId: "s1", speakerTagId: "tag-chair", text: chairSpeech,
            utterances: [
                { utteranceId: "u1", text: chairSpeech.split(" ").slice(0, 45).join(" "), startTimestamp: 0, endTimestamp: 30 },
                { utteranceId: "u2", text: chairSpeech.split(" ").slice(45).join(" "), startTimestamp: 30, endTimestamp: 60 },
            ],
        },
        {
            speakerName: null, speakerParty: null, speakerRole: null, speakerId: null, speakerSegmentId: "s2", speakerTagId: "tag-member", text: memberSpeech,
            utterances: [{ utteranceId: "u3", text: memberSpeech, startTimestamp: 61, endTimestamp: 120 }],
        },
        {
            speakerName: null, speakerParty: null, speakerRole: null, speakerId: null, speakerSegmentId: "s3", speakerTagId: "tag-chair", text: "Ευχαριστούμε.",
            utterances: [{ utteranceId: "u4", text: "Ευχαριστούμε.", startTimestamp: 121, endTimestamp: 122 }],
        },
    ],
    topicLabels: [],
    cityName: "Νέα Φιλαδέλφεια",
    cityLanguage: "el",
    administrativeBodyName: "Δημοτικό Συμβούλιο",
    people: [
        { id: "chair", name: "Ελευθέριος Αντωνόπουλος", role: "Πρόεδρος, Δημοτικό Συμβούλιο", party: null, memberOfMeetingBody: true },
        { id: "dimakis", name: "Κωνσταντίνος Δημάκης", role: null, party: "Παράταξη", memberOfMeetingBody: true },
    ],
    date: "2025-10-20T16:00:00.000Z",
};

describe("checkRequest", () => {
    it("fails a malformed request with every problem named, before any download", () => {
        expect(() => checkRequest(request)).not.toThrow();
        expect(() => checkRequest({ ...request, sessionNumber: null })).not.toThrow();
        const bad = { ...request, municipalMinutesUrl: "minutes.pdf", meetingDate: "20/10/2025", sessionNumber: "27" } as unknown as FixFromMinutesRequest;
        expect(() => checkRequest(bad)).toThrow(/invalid request: municipalMinutesUrl must be an http\(s\) URL; meetingDate must be YYYY-MM-DD; sessionNumber must be an integer or null/);
        expect(() => checkRequest({ ...request, transcript: undefined } as unknown as FixFromMinutesRequest)).toThrow(/transcript must be a list/);
    });
});

describe("timedUtterances", () => {
    it("flattens the segments in time order with their speaker tag and speaker", () => {
        const utterances = timedUtterances(request.transcript);
        expect(utterances.map(u => u.utteranceId)).toEqual(["u1", "u2", "u3", "u4"]);
        expect(utterances[0]).toMatchObject({ speakerTagId: "tag-chair", speakerId: "chair", start: 0, end: 30 });
    });
});

describe("fixFromMinutes", () => {
    it("corrects the misheard words, names the speakers and reports, with the model check and the name matcher mocked", async () => {
        mockAiChat.mockImplementation(async ({ label }: { label?: string }) => {
            if (label?.startsWith("minutes-turn-check")) return { result: { notSpeakers: [], missedTurns: [] }, usage: NO_USAGE };
            return { result: { matches: [] }, usage: NO_USAGE };
        });
        const progress: string[] = [];
        const result = await fixFromMinutesWith(request, stage => progress.push(stage), { pages });

        expect(result.updateUtterances.map(u => u.utteranceId).sort()).toEqual(["u2", "u3"]);
        expect(result.updateUtterances.find(u => u.utteranceId === "u2")).toMatchObject({ markUncertain: false, source: { page: 2, label: "ΠΡΟΕΔΡΟΣ", turnIndex: 0 } });
        expect(result.updateUtterances.find(u => u.utteranceId === "u2")!.text).toContain("ο κύριος Δημάκης έχει τον λόγο");
        expect(result.updateUtterances.find(u => u.utteranceId === "u3")!.text).toContain("για τη Μεσογείων");

        expect(result.speakerHints).toEqual([
            expect.objectContaining({ speakerTagId: "tag-chair", personId: "chair", actionable: true, confidence: 100 }),
            expect.objectContaining({ speakerTagId: "tag-member", personId: "dimakis", actionable: true, confidence: 100 }),
        ]);

        expect(result.report.document).toEqual({ section: null, coverage: expect.any(Number), checkAdded: 0, checkRemoved: 0, checkDropped: 0, checkFailedChunks: 0 });
        expect(result.report.document.coverage).toBeGreaterThan(0.9);
        expect(result.report.alignment).toEqual({ turns: 3, alignedTurns: 3, turnsUnderGate: 0, utterancesUnmatched: 0 });
        expect(result.report.corrections).toEqual({ utterancesChanged: 2, substitutions: 2, insertionsSkipped: 0, deletionsSkipped: 0 });
        expect(result.report.speakers).toEqual({ actionable: 2, contested: [], disagreements: [], unresolvedLabels: [] });
        expect(progress).toContain("checking the turns");
        expect(mockAiChat).toHaveBeenCalledWith(expect.objectContaining({ label: "minutes-turn-check:1/1", model: "claude-haiku-5-5" }));
    });

    it("fails before any model call when the document holds no section for the meeting", async () => {
        mockAiChat.mockClear();
        await expect(fixFromMinutesWith({ ...request, meetingDate: "2025-11-03" }, () => {}, { pages })).rejects.toThrow(/no section of the minutes matches the meeting of 2025-11-03, session 27/);
        expect(mockAiChat).not.toHaveBeenCalled();
    });

    it("fails when too little of the document falls inside speaker turns", async () => {
        const noLabels: MinutesPage[] = [{ page: 1, lines: ["27ης ΣΥΝΕΔΡΙΑΣΗΣ 20/10/2025", words(200, 9), words(200, 8)] }];
        await expect(fixFromMinutesWith(request, () => {}, { pages: noLabels, skipCheck: true })).rejects.toThrow(/0% of the minutes falls inside speaker turns/);
        const front: MinutesPage[] = [{ page: 1, lines: ["27ης ΣΥΝΕΔΡΙΑΣΗΣ 20/10/2025", words(300, 9), `ΠΡΟΕΔΡΟΣ: ${minutesChair}`] }];
        await expect(fixFromMinutesWith(request, () => {}, { pages: front, skipCheck: true })).rejects.toThrow(/falls inside speaker turns \(floor 80%\)/);
    });

    it("reports the section it read when the document holds several meetings, and the check chunks that failed", async () => {
        mockAiChat.mockRejectedValue(new Error("overloaded"));
        const several: MinutesPage[] = [
            { page: 1, lines: ["26ης ΣΥΝΕΔΡΙΑΣΗΣ 6/10/2025", "ΠΡΟΕΔΡΟΣ: Καλησπέρα."] },
            { page: 2, lines: ["27ης ΣΥΝΕΔΡΙΑΣΗΣ 20/10/2025", `ΠΡΟΕΔΡΟΣ: ${minutesChair}`] },
            { page: 3, lines: ["ΠΡΟΕΔΡΟΣ: Ευχαριστώ."] },
        ];
        const result = await fixFromMinutesWith(request, () => {}, { pages: several });
        expect(result.report.document).toMatchObject({ section: { page: 2, pages: 2 }, checkAdded: 0, checkRemoved: 0, checkDropped: 0, checkFailedChunks: 1 });
    });

    it("gives no speaker hints at all without a roster or without speaker tags", async () => {
        const noRoster = await fixFromMinutesWith({ ...request, people: [] }, () => {}, { pages, skipCheck: true });
        expect(noRoster.speakerHints).toBeUndefined();
        expect(noRoster.updateUtterances).toHaveLength(2);
        const noTags = await fixFromMinutesWith({ ...request, transcript: request.transcript.map(s => ({ ...s, speakerTagId: undefined })) }, () => {}, { pages, skipCheck: true });
        expect(noTags.speakerHints).toBeUndefined();
    });
});
