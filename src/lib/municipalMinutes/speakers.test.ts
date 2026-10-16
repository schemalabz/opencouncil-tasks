import { beforeEach, describe, it, expect, vi } from "vitest";

const { mockAiChat } = vi.hoisted(() => ({ mockAiChat: vi.fn() }));
vi.mock("../ai.js", async importOriginal => ({ ...(await importOriginal<typeof import("../ai.js")>()), aiChat: mockAiChat }));

import { NO_USAGE } from "../ai.js";
import { matchMinutes, type TimedUtterance } from "./matching.js";
import { MIN_ALIGNED_WORDS, PURITY_FLOOR, resolveLabels, speakersReport, tagOpinions, toMinutesHints } from "./speakers.js";
import { labelKey, type Turn } from "./turns.js";
import type { RosterPerson } from "../../types.js";

const turn = (index: number, label: string, text: string): Turn => ({ index, label, key: labelKey(label), page: 1, offset: index * 1000, text, stageDirections: 0 });
const words = (n: number, seed: number) => Array.from({ length: n }, (_, i) => `λέξη${(i * 31 + seed * 17) % 997}`).join(" ");
const roster: RosterPerson[] = [
    { id: "chair", name: "Αθανάσιος Βαλυράκης", role: "Πρόεδρος, Δημοτικό Συμβούλιο", party: null, memberOfMeetingBody: true },
    { id: "vice-council", name: "Γεώργιος Μάγκος", role: "Αντιπρόεδρος, Δημοτικό Συμβούλιο", party: null, memberOfMeetingBody: true },
    { id: "vice-committee", name: "Αλέξανδρος Νομικός", role: "Δημοτικό Συμβούλιο; Αντιπρόεδρος, Δημοτική Επιτροπή", party: null, memberOfMeetingBody: true },
    { id: "mayor", name: "Ηλίας Αποστολόπουλος", role: "Δήμαρχος; head, Δημοτική Επιτροπή", party: null },
    { id: "secretary", name: "Μαρία Σουράνη", role: "Γενική Γραμματέας", party: null },
    { id: "trakas", name: "Μιχαήλ Τράκας", role: "Αντιδήμαρχος Παιδείας", party: null },
    { id: "petrou", name: "Νίκος Πέτρου", role: "Αντιδήμαρχος Οικονομικών", party: null },
    { id: "chamilothori", name: "Αναστασία Χαμηλοθώρη-Κουγιουμτζοπούλου", role: null, party: "Παράταξη Α", memberOfMeetingBody: true },
    { id: "gouma", name: "Γκούμα Δανάη – Εύα", role: null, party: "Παράταξη Β", memberOfMeetingBody: true },
];

describe("resolveLabels", () => {
    beforeEach(() => {
        mockAiChat.mockReset();
    });

    it("resolves roles through the roster, in the meeting body first, and names through the name matcher", async () => {
        mockAiChat.mockResolvedValue({ result: { matches: [] }, usage: NO_USAGE });
        const turns = ["ΠΡΟΕΔΡΟΣ", "ΑΝΤΙΠΡΟΕΔΡΟΣ", "ΔΗΜΑΡΧΟΣ", "ΓΕΝ. ΓΡΑΜΜΑΤΕΑΣ", "ΑΝΤΙΔ. ΠΑΙΔΕΙΑΣ", "ΧΑΜΗΛΟΘΩΡΗ", "Δ. – Ε. ΓΚΟΥΜΑ", "ΣΥΜΒΟΥΛΟΣ", "ΥΠ/ΚΟΣ ΠΑΡΑΓΩΝ", "ΜΕΛΗ"].map((label, i) => turn(i, label, ""));
        const { result } = await resolveLabels(turns, roster, "Δημοτικό Συμβούλιο");
        expect(result.get("προεδροσ")).toBe("chair");
        expect(result.get("αντιπροεδροσ")).toBe("vice-council");
        expect(result.get("δημαρχοσ")).toBe("mayor");
        expect(result.get("γεν. γραμματεασ")).toBe("secretary");
        expect(result.get("αντιδ. παιδειασ")).toBe("trakas");
        expect(result.get("χαμηλοθωρη")).toBe("chamilothori");
        expect(result.get("δ. – ε. γκουμα")).toBe("gouma");
        expect(result.get("συμβουλοσ")).toBeNull();
        expect(result.get("υπ/κοσ παραγων")).toBeNull();
        expect(result.get("μελη")).toBeNull();
        // Generic labels and role labels never go to the model matcher.
        expect(mockAiChat).not.toHaveBeenCalled();
    });

    it("reads a bare «ΝΟΜΙΚΟΣ» as the councillor's surname, not as the legal adviser", async () => {
        mockAiChat.mockResolvedValue({ result: { matches: [] }, usage: NO_USAGE });
        const { result } = await resolveLabels([turn(0, "ΝΟΜΙΚΟΣ", ""), turn(1, "ΝΟΜΙΚΟΣ ΣΥΜΒΟΥΛΟΣ", "")], roster, "Δημοτικό Συμβούλιο");
        expect(result.get("νομικοσ")).toBe("vice-committee");
        expect(result.get("νομικοσ συμβουλοσ")).toBeNull();
        expect(mockAiChat).not.toHaveBeenCalled();
    });

    it("names the person a role label's parenthesis gives, before the role, and keeps two such labels apart", async () => {
        mockAiChat.mockResolvedValue({ result: { matches: [] }, usage: NO_USAGE });
        const turns = [turn(0, "ΑΝΤΙΔΗΜΑΡΧΟΣ (κ. Τράκας)", ""), turn(1, "ΑΝΤΙΔΗΜΑΡΧΟΣ (κ. Πέτρου)", ""), turn(2, "ΑΝΤΙΔΗΜΑΡΧΟΣ", ""), turn(3, "ΠΡΟΕΔΡΟΣ (κ. Γεώργιος Μάγκος)", "")];
        expect(new Set(turns.map(t => t.key)).size).toBe(4);
        const { result } = await resolveLabels(turns, roster, "Δημοτικό Συμβούλιο");
        expect(result.get("αντιδημαρχοσ (κ. τρακασ)")).toBe("trakas");
        expect(result.get("αντιδημαρχοσ (κ. πετρου)")).toBe("petrou");
        expect(result.get("αντιδημαρχοσ")).toBeNull();
        // The vice-chair in the chair's seat is the vice-chair, not the chair.
        expect(result.get("προεδροσ (κ. γεωργιοσ μαγκοσ)")).toBe("vice-council");
    });

    it("never falls back on the role when the printed name is unknown to the roster", async () => {
        mockAiChat.mockResolvedValue({ result: { matches: [] }, usage: NO_USAGE });
        const { result } = await resolveLabels([turn(0, "ΠΡΟΕΔΡΟΣ (κ. Αγνωστόπουλος)", "")], roster, "Δημοτικό Συμβούλιο");
        expect(mockAiChat).toHaveBeenCalledTimes(1);
        expect(result.get("προεδροσ (κ. αγνωστοπουλοσ)")).toBeNull();
    });

    it("asks the model matcher for a parenthesis name the rules do not settle", async () => {
        mockAiChat.mockResolvedValue({ result: { matches: [{ name: "Μιχάλης", personId: "trakas" }] }, usage: NO_USAGE });
        const { result } = await resolveLabels([turn(0, "ΑΝΤΙΔΗΜΑΡΧΟΣ (κ. Μιχάλης)", "")], roster, null);
        expect(mockAiChat).toHaveBeenCalledTimes(1);
        expect(result.get("αντιδημαρχοσ (κ. μιχαλησ)")).toBe("trakas");
    });

    it("resolves the committee's vice-chair when the committee meets, and nobody when two hold the role elsewhere", async () => {
        mockAiChat.mockResolvedValue({ result: { matches: [] }, usage: NO_USAGE });
        const turns = [turn(0, "ΑΝΤΙΠΡΟΕΔΡΟΣ", "")];
        expect((await resolveLabels(turns, roster, "Δημοτική Επιτροπή")).result.get("αντιπροεδροσ")).toBe("vice-committee");
        expect((await resolveLabels(turns, roster, "Άλλο Σώμα")).result.get("αντιπροεδροσ")).toBeNull();
    });

    it("asks the model matcher for the names the rules do not settle", async () => {
        mockAiChat.mockResolvedValue({ result: { matches: [{ name: "ΣΟΥΡΑΝΗΣ", personId: "secretary" }] }, usage: NO_USAGE });
        const { result } = await resolveLabels([turn(0, "ΣΟΥΡΑΝΗΣ", "")], roster, null);
        expect(mockAiChat).toHaveBeenCalledTimes(1);
        expect(result.get("σουρανησ")).toBe("secretary");
    });

    it("resolves the unmatched labels to nobody when the model matcher fails", async () => {
        mockAiChat.mockRejectedValue(new Error("overloaded"));
        expect((await resolveLabels([turn(0, "ΑΓΝΩΣΤΟΠΟΥΛΟΣ", "")], roster, null)).result.get("αγνωστοπουλοσ")).toBeNull();
    });
});

describe("the actionable floors at their edges", () => {
    /** One tag: `named` aligned words under ΠΡΟΕΔΡΟΣ (the chair), `other` under ΣΥΜΒΟΥΛΟΣ (nobody). */
    const opinionFor = (named: number, other: number) => {
        const turns = [turn(0, "ΠΡΟΕΔΡΟΣ", words(named, 1)), turn(1, "ΣΥΜΒΟΥΛΟΣ", words(other, 2))];
        const utterances: TimedUtterance[] = [
            { utteranceId: "u1", text: words(named, 1), start: 0, end: 10, speakerTagId: "t", speakerId: null },
            { utteranceId: "u2", text: words(other, 2), start: 11, end: 20, speakerTagId: "t", speakerId: null },
        ];
        return tagOpinions(turns, utterances, matchMinutes(turns, utterances), new Map([["προεδροσ", "chair"], ["συμβουλοσ", null]]))[0];
    };

    it("is actionable at exactly PURITY_FLOOR, not one point under, and not on a share that rounds up to it", () => {
        expect(opinionFor(80, 20)).toMatchObject({ purity: 80, actionable: true });
        expect(opinionFor(79, 21)).toMatchObject({ purity: 79, actionable: false });
        expect(opinionFor(159, 41)).toMatchObject({ purity: 80, actionable: false });
    });

    it("is actionable at exactly MIN_ALIGNED_WORDS, not one word under", () => {
        expect(opinionFor(50, 0)).toMatchObject({ alignedWords: 50, purity: 100, actionable: true });
        expect(opinionFor(49, 0)).toMatchObject({ alignedWords: 49, purity: 100, actionable: false });
    });
});

describe("tagOpinions, toMinutesHints and speakersReport", () => {
    const utterances: TimedUtterance[] = [
        { utteranceId: "u1", text: words(60, 1), start: 0, end: 60, speakerTagId: "tag-a", speakerId: "someone-else" },
        { utteranceId: "u2", text: words(40, 2), start: 61, end: 100, speakerTagId: "tag-b", speakerId: null },
        { utteranceId: "u3", text: words(30, 3), start: 101, end: 130, speakerTagId: "tag-b", speakerId: null },
        { utteranceId: "u4", text: words(10, 4), start: 131, end: 140, speakerTagId: "tag-c", speakerId: null },
    ];
    const turns = [turn(0, "ΠΡΟΕΔΡΟΣ", words(60, 1)), turn(1, "ΧΑΜΗΛΟΘΩΡΗ", words(40, 2)), turn(2, "ΣΥΜΒΟΥΛΟΣ", words(30, 3)), turn(3, "ΔΗΜΑΡΧΟΣ", words(10, 4))];
    const resolution = new Map<string, string | null>([["προεδροσ", "chair"], ["χαμηλοθωρη", "chamilothori"], ["συμβουλοσ", null], ["δημαρχοσ", "mayor"]]);
    const matching = matchMinutes(turns, utterances);
    const opinions = tagOpinions(turns, utterances, matching, resolution);

    it("names the person with the largest share, with the share as purity, actionable above the floors", () => {
        const a = opinions.find(o => o.speakerTagId === "tag-a")!;
        expect(a).toMatchObject({ personId: "chair", purity: 100, actionable: true, alignedWords: 60 });
        expect(a.alignedWords).toBeGreaterThanOrEqual(MIN_ALIGNED_WORDS);
    });

    it("marks a tag the minutes give to two labels as contested when the share is under the floor", () => {
        const b = opinions.find(o => o.speakerTagId === "tag-b")!;
        expect(b.personId).toBe("chamilothori");
        expect(b.purity).toBe(57);
        expect(b.purity).toBeLessThan(PURITY_FLOOR);
        expect(b.actionable).toBe(false);
    });

    it("does not act on a tag with too few aligned words", () => {
        const c = opinions.find(o => o.speakerTagId === "tag-c")!;
        expect(c).toMatchObject({ personId: "mayor", purity: 100, actionable: false });
    });

    it("returns hints with the purity as confidence and the labels, shares and time ranges as evidence", () => {
        const hints = toMinutesHints(opinions);
        const b = hints.find(h => h.speakerTagId === "tag-b")!;
        expect(b).toMatchObject({ personId: "chamilothori", actionable: false, confidence: 57, evidenceKind: null });
        expect(b.evidence).toMatch(/ΧΑΜΗΛΟΘΩΡΗ 57% \(00:01:01–00:01:40\); ΣΥΜΒΟΥΛΟΣ \(nobody\) 43%/);
    });

    it("reports the actionable count, the contested tags, the disagreements with the request and the unresolved labels", () => {
        const report = speakersReport(opinions, utterances, turns, resolution);
        expect(report.actionable).toBe(1);
        expect(report.contested).toEqual([{ speakerTagId: "tag-b", people: [{ personId: "chamilothori", share: 57, from: 61, to: 100 }] }]);
        expect(report.disagreements).toEqual([{ speakerTagId: "tag-a", opinions: [{ method: "voiceprint", personId: "someone-else" }, { method: "minutes", personId: "chair" }] }]);
        expect(report.unresolvedLabels).toEqual(["ΣΥΜΒΟΥΛΟΣ"]);
    });
});
