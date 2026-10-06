import { describe, it, expect, vi } from "vitest";

vi.mock("../lib/ai.js", async (importOriginal) => ({
    ...await importOriginal<typeof import("../lib/ai.js")>(),
    aiChat: vi.fn(),
}));
vi.mock("./utils/speakerHints.js", () => ({ identifyTranscriptSpeakers: vi.fn() }));

import { applyCorrections, buildUserPrompt, fixTranscript, groupPeopleByParty, parseNumberedUtterances } from "./fixTranscript.js";
import { aiChat, NO_USAGE } from "../lib/ai.js";
import { identifyTranscriptSpeakers } from "./utils/speakerHints.js";
import { FixTranscriptRequest, SpeakerHint } from "../types.js";

describe("parseNumberedUtterances", () => {
    it("parses sequential numbered lines", () => {
        const text = "1. Καλησπέρα κύριοι συνάδελφοι.\n2. Ξεκινάει η 35η συνεδρίαση.\n3. Υπάρχει απαρτία;";

        expect(parseNumberedUtterances(text, 3)).toEqual([
            "Καλησπέρα κύριοι συνάδελφοι.",
            "Ξεκινάει η 35η συνεδρίαση.",
            "Υπάρχει απαρτία;",
        ]);
    });

    it("tolerates surrounding whitespace and blank lines between entries", () => {
        const text = "\n1. πρώτο\n\n2. δεύτερο\n";

        expect(parseNumberedUtterances(text, 2)).toEqual(["πρώτο", "δεύτερο"]);
    });

    it("joins wrapped continuation lines into the previous utterance", () => {
        const text = "1. μια μεγάλη πρόταση\nπου συνεχίζεται στην επόμενη γραμμή\n2. δεύτερο";

        expect(parseNumberedUtterances(text, 2)).toEqual([
            "μια μεγάλη πρόταση που συνεχίζεται στην επόμενη γραμμή",
            "δεύτερο",
        ]);
    });

    it("rejects out-of-sequence numbered lines instead of merging them", () => {
        // Folding a misnumbered line into the previous utterance would corrupt
        // the record silently — a retry is always safer
        expect(parseNumberedUtterances("1. ένα\n3. τρία\n2. δύο", 2)).toBeNull();
        expect(parseNumberedUtterances("1. ένα\n2. δύο\n2. τρία\n3. τέσσερα", 4)).toBeNull();
    });

    it("treats lines starting with a decimal number as continuations", () => {
        const text = "1. το κόστος ανέρχεται σε\n3.5 εκατομμύρια ευρώ\n2. δεύτερο";

        expect(parseNumberedUtterances(text, 2)).toEqual([
            "το κόστος ανέρχεται σε 3.5 εκατομμύρια ευρώ",
            "δεύτερο",
        ]);
    });

    it("returns null when the count does not match", () => {
        expect(parseNumberedUtterances("1. μόνο ένα", 2)).toBeNull();
        expect(parseNumberedUtterances("1. ένα\n2. δύο\n3. τρία", 2)).toBeNull();
    });

    it("returns null on preamble before the first numbered line", () => {
        expect(parseNumberedUtterances("Here are the corrected lines:\n1. ένα", 1)).toBeNull();
    });

    it("returns null when numbering does not start at 1", () => {
        expect(parseNumberedUtterances("2. ένα\n3. δύο", 2)).toBeNull();
    });
});

describe("groupPeopleByParty", () => {
    const person = (name: string, party: string | null) => ({ id: name, name, role: null, party });

    it("lists each party's people on one line, and the people with no party last", () => {
        const parties = groupPeopleByParty([
            person("Άννα Ξηνταροπούλου", "Παράταξη Α"),
            person("Γενικός Γραμματέας", null),
            person("Νίκος Αδραχτάς", "Παράταξη Β"),
            { ...person("Γιώργος Δημάκης", "Παράταξη Α"), partyHead: true },
        ]);

        expect(parties).toEqual([
            { name: "Παράταξη Α", people: [{ name: "Άννα Ξηνταροπούλου" }, { name: "Γιώργος Δημάκης" }] },
            { name: "Παράταξη Β", people: [{ name: "Νίκος Αδραχτάς" }] },
            { name: "No party", people: [{ name: "Γενικός Γραμματέας" }] },
        ]);
        expect(buildUserPrompt("Αθήνα", parties, [], ["πρώτο"])).toContain("No party: Γενικός Γραμματέας");
    });

    it("adds no line when everyone has a party", () => {
        expect(groupPeopleByParty([person("Άννα Ξηνταροπούλου", "Παράταξη Α")]).map(p => p.name)).toEqual(["Παράταξη Α"]);
    });
});

describe("buildUserPrompt", () => {
    const parties = [
        { name: "Παράταξη Α", people: [{ name: "Γιώργος Δημάκης", role: "μέλος" }, { name: "Άννα Ξηνταροπούλου", role: "μέλος" }] },
        { name: "Παράταξη Β", people: [{ name: "Νίκος Αδραχτάς", role: "επικεφαλής" }] },
    ];

    it("formats the roster as readable lines and numbers the utterances", () => {
        const prompt = buildUserPrompt("Αθήνα", parties, [], ["πρώτο", "δεύτερο"]);

        expect(prompt).toContain("City: Αθήνα");
        expect(prompt).toContain("Παράταξη Α: Γιώργος Δημάκης, Άννα Ξηνταροπούλου");
        expect(prompt).toContain("Παράταξη Β: Νίκος Αδραχτάς");
        expect(prompt).toContain("1. πρώτο\n2. δεύτερο");
        expect(prompt).not.toContain("Agenda items");
    });

    it("never names the speaker: the tag's person is a guess the identification must not read back", () => {
        expect(buildUserPrompt("Αθήνα", parties, [], ["πρώτο"])).not.toMatch(/Speaker/);
    });

    it("includes numbered agenda items when provided", () => {
        const agenda = [{ name: "Ανάπλαση οδού Ερμού" }, { name: "Κανονισμός ύδρευσης (άρθρο 75)" }];

        const prompt = buildUserPrompt("Αθήνα", parties, agenda, ["πρώτο"]);

        expect(prompt).toContain("Agenda items of this meeting (source for street/project/entity names):");
        expect(prompt).toContain("1. Ανάπλαση οδού Ερμού\n2. Κανονισμός ύδρευσης (άρθρο 75)");
    });
});

describe("applyCorrections", () => {
    const utterance = (utteranceId: string, text: string) => ({ utteranceId, text, startTimestamp: 0, endTimestamp: 1 });
    const segment = (speakerTagId: string, utterances: ReturnType<typeof utterance>[]) => ({
        speakerName: null, speakerParty: null, speakerRole: null, speakerId: null, speakerSegmentId: `seg-${speakerTagId}`, speakerTagId,
        text: utterances.map(u => u.text).join(" "), utterances,
    });

    it("puts the corrected text in place, and leaves the rest as it was", () => {
        const transcript = [
            segment("a", [utterance("u1", "Τον λόγο έχει ο κύριος Νέκας."), utterance("u2", "Ευχαριστώ.")]),
            segment("b", [utterance("u3", "Καλησπέρα.")]),
        ];
        const corrected = applyCorrections(transcript, [{ utteranceId: "u1", text: "Τον λόγο έχει ο κύριος Λέκκας.", markUncertain: false }]);

        expect(corrected[0].utterances.map(u => u.text)).toEqual(["Τον λόγο έχει ο κύριος Λέκκας.", "Ευχαριστώ."]);
        expect(corrected[0].text).toBe("Τον λόγο έχει ο κύριος Λέκκας. Ευχαριστώ.");
        expect(corrected[0].utterances[0]).toMatchObject({ utteranceId: "u1", startTimestamp: 0, endTimestamp: 1 });
        expect(corrected[1]).toEqual(transcript[1]);
        // The request's own transcript is untouched: it is what the task returns corrections against.
        expect(transcript[0].utterances[0].text).toBe("Τον λόγο έχει ο κύριος Νέκας.");
    });
});

describe("fixTranscript", () => {
    it("identifies the speakers once the corrections are in, from the corrected text", async () => {
        const utterance = (utteranceId: string, text: string) => ({ utteranceId, text, startTimestamp: 0, endTimestamp: 1 });
        const segment = (speakerTagId: string, utterances: ReturnType<typeof utterance>[]) => ({
            speakerName: null, speakerParty: null, speakerRole: null, speakerId: null, speakerSegmentId: `seg-${speakerTagId}`, speakerTagId,
            text: utterances.map(u => u.text).join(" "), utterances,
        });
        const request: FixTranscriptRequest = {
            callbackUrl: "http://app.test/callback",
            cityName: "Χαλάνδρι",
            cityLanguage: "el",
            administrativeBodyName: "Δημοτικό Συμβούλιο",
            date: "2026-07-30",
            topicLabels: [],
            people: [{ id: "p1", name: "Γιώργος Λέκκας", role: null, party: null }],
            transcript: [
                segment("a", [utterance("u1", "Τον λόγο έχει ο κύριος Νέκας."), utterance("u2", "Ευχαριστώ.")]),
                segment("b", [utterance("u3", "Καλησπέρα.")]),
            ],
        };

        // What happened, in order. A correction that returns on the next tick
        // makes an identification that did not wait show up first.
        const events: string[] = [];
        vi.mocked(aiChat).mockImplementation(async ({ userPrompt }) => {
            await new Promise(resolve => setTimeout(resolve, 5));
            events.push("corrected");
            const numbered = userPrompt.split("Correct the numbered utterances:\n")[1];
            return { result: numbered.replace("Νέκας", "Λέκκας"), usage: NO_USAGE };
        });
        const hints: SpeakerHint[] = [{ speakerTagId: "a", personId: "p1", actionable: true, evidenceKind: "addressed", confidence: 90, evidence: "Τον λόγο έχει ο κύριος Λέκκας." }];
        vi.mocked(identifyTranscriptSpeakers).mockImplementation(async () => {
            events.push("identified");
            return { result: hints, usage: NO_USAGE };
        });
        const onProgress = vi.fn();

        const result = await fixTranscript(request, onProgress);

        expect(events).toEqual(["corrected", "corrected", "identified"]);
        expect(onProgress.mock.calls.at(-1)).toEqual(["identifying speakers", 0]);

        const identified = vi.mocked(identifyTranscriptSpeakers).mock.calls[0][0];
        expect(identified.people).toBe(request.people);
        expect(identified.transcript[0].utterances.map(u => u.text)).toEqual(["Τον λόγο έχει ο κύριος Λέκκας.", "Ευχαριστώ."]);
        expect(identified.transcript[0].text).toBe("Τον λόγο έχει ο κύριος Λέκκας. Ευχαριστώ.");
        expect(identified.transcript[0]).toMatchObject({ speakerTagId: "a", speakerSegmentId: "seg-a" });
        expect(identified.transcript[1]).toEqual(request.transcript[1]);

        expect(result.updateUtterances).toEqual([{ utteranceId: "u1", text: "Τον λόγο έχει ο κύριος Λέκκας.", markUncertain: false }]);
        expect(result.speakerHints).toBe(hints);
    });
});
