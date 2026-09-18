import { describe, it, expect, vi, beforeEach } from "vitest";
import { FixTranscriptRequest } from "../../types.js";
import { NO_USAGE } from "../../lib/ai.js";
import { TaskCancelledError } from "../../lib/taskControl.js";

const identifySpeakers = vi.fn();
vi.mock("../../lib/speakerIdentification.js", () => ({ identifySpeakers: (...args: unknown[]) => identifySpeakers(...args) }));

const { buildIdentificationInput, toSpeakerHints, identifyTranscriptSpeakers } = await import("./speakerHints.js");

type Segment = FixTranscriptRequest["transcript"][number];
const segment = (speakerTagId: string | undefined, start: number, texts: string[], speakerName: string | null = null): Segment => ({
    speakerName, speakerParty: null, speakerRole: null, speakerId: speakerName ? "p-known" : null,
    speakerSegmentId: `seg-${start}`, speakerTagId, text: texts.join(" "),
    utterances: texts.map((text, i) => ({ text, utteranceId: `u-${start}-${i}`, startTimestamp: start + i, endTimestamp: start + i + 1 })),
});

const request = (over: Partial<FixTranscriptRequest> = {}): FixTranscriptRequest => ({
    callbackUrl: "https://example.test/cb", topicLabels: [], cityName: "Χανιά", cityLanguage: "el",
    administrativeBodyName: "Δημοτικό Συμβούλιο", partiesWithPeople: [], date: "2026-09-09",
    transcript: [segment("tag-a", 0, ["Τον λόγο έχει ο κ. Αλόγλου."], "Πρόεδρος"), segment("tag-b", 10, ["Ευχαριστώ."])],
    roster: [{ id: "p1", name: "Αναστάσιος Αλόγλου", role: null, party: null }],
    ...over,
});

beforeEach(() => {
    identifySpeakers.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("buildIdentificationInput", () => {
    it("labels tags in order of first speech and never passes names on", () => {
        const { segments, tagIdByLabel } = buildIdentificationInput([
            segment("tag-b", 20, ["Δεύτερος."], "Γνωστός Ομιλητής"),
            segment("tag-a", 5, ["Πρώτος.", "  ", "Συνεχίζω."]),
            segment("tag-b", 40, ["Ξανά."]),
        ]);
        expect(segments).toEqual([
            { speakerLabel: "S1", start: 5, end: 8, text: "Πρώτος. Συνεχίζω." },
            { speakerLabel: "S2", start: 20, end: 21, text: "Δεύτερος." },
            { speakerLabel: "S2", start: 40, end: 41, text: "Ξανά." },
        ]);
        expect([...tagIdByLabel]).toEqual([["S1", "tag-a"], ["S2", "tag-b"]]);
        expect(JSON.stringify(segments)).not.toContain("Γνωστός");
    });

    it("leaves out segments without a tag id, without utterances, or without text", () => {
        const { segments, tagIdByLabel } = buildIdentificationInput([segment(undefined, 0, ["Χωρίς ετικέτα."]), segment("tag-a", 5, []), segment("tag-b", 9, [" "])]);
        expect(segments).toEqual([]);
        expect([...tagIdByLabel.values()]).toEqual(["tag-b"]);
    });
});

describe("toSpeakerHints", () => {
    it("keeps named speakers and maps labels back to tag ids", () => {
        const hints = toSpeakerHints([
            { speakerLabel: "S1", personId: "p1", evidenceKind: "named", contested: false, actionable: true, confidence: 95, evidence: "e1", alternatives: [], known: false },
            { speakerLabel: "S2", personId: null, evidenceKind: null, contested: false, actionable: false, confidence: 0, evidence: "", alternatives: [], known: false },
            { speakerLabel: "S9", personId: "p2", evidenceKind: "named", contested: false, actionable: true, confidence: 90, evidence: "no such label", alternatives: [], known: false },
        ], new Map([["S1", "tag-a"], ["S2", "tag-b"]]));
        expect(hints).toEqual([{ speakerTagId: "tag-a", personId: "p1", actionable: true, evidenceKind: "named", confidence: 95, evidence: "e1" }]);
    });

    it("keeps a name the pass would not act on, marked as such", () => {
        const hints = toSpeakerHints([
            { speakerLabel: "S1", personId: "p1", evidenceKind: "roleBehaviour", contested: false, actionable: false, confidence: 60, evidence: "chairs", alternatives: [], known: false },
            { speakerLabel: "S2", personId: "p2", evidenceKind: "named", contested: true, actionable: false, confidence: 90, evidence: "floor", alternatives: [{ personId: "p3", confidence: 80 }], known: false },
        ], new Map([["S1", "tag-a"], ["S2", "tag-b"]]));
        expect(hints.map(h => [h.speakerTagId, h.actionable, h.evidenceKind])).toEqual([["tag-a", false, "roleBehaviour"], ["tag-b", false, "named"]]);
    });
});

describe("identifyTranscriptSpeakers", () => {
    it("does not run without a roster or without speaker tag ids", async () => {
        expect((await identifyTranscriptSpeakers(request({ roster: undefined }))).result).toBeUndefined();
        expect((await identifyTranscriptSpeakers(request({ roster: [] }))).result).toBeUndefined();
        expect((await identifyTranscriptSpeakers(request({ transcript: [segment(undefined, 0, ["Κάτι."])] }))).result).toBeUndefined();
        expect(identifySpeakers).not.toHaveBeenCalled();
    });

    it("runs blind to known speakers and returns hints by tag id", async () => {
        identifySpeakers.mockResolvedValue({
            result: [{ speakerLabel: "S2", personId: "p1", evidenceKind: "named", contested: false, actionable: true, confidence: 92, evidence: "[00:00:00] floor grant", alternatives: [], known: false }],
            usage: { ...NO_USAGE, input_tokens: 10 },
        });
        const { result, usage } = await identifyTranscriptSpeakers(request());
        expect(result).toEqual([{ speakerTagId: "tag-b", personId: "p1", actionable: true, evidenceKind: "named", confidence: 92, evidence: "[00:00:00] floor grant" }]);
        expect(usage.input_tokens).toBe(10);
        const args = identifySpeakers.mock.calls[0][0];
        expect(args).toMatchObject({ cityName: "Χανιά", language: "el", meetingDate: "2026-09-09", administrativeBodyName: "Δημοτικό Συμβούλιο" });
        expect(args.knownSpeakers).toBeUndefined();
    });

    it("returns an empty list when the pass ran and named nobody", async () => {
        identifySpeakers.mockResolvedValue({ result: [], usage: NO_USAGE });
        expect((await identifyTranscriptSpeakers(request())).result).toEqual([]);
    });

    it("swallows a failure but lets a cancellation through", async () => {
        identifySpeakers.mockRejectedValueOnce(new Error("model unavailable"));
        expect((await identifyTranscriptSpeakers(request())).result).toBeUndefined();

        identifySpeakers.mockRejectedValueOnce(new TaskCancelledError());
        await expect(identifyTranscriptSpeakers(request())).rejects.toBeInstanceOf(TaskCancelledError);
    });
});
