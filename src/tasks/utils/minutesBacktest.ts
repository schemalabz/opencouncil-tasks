import type { FixFromMinutesRequest, FixFromMinutesResult } from "../../types.js";
import { foldText, levenshtein } from "../../lib/municipalMinutes/text.js";
import { meetingRoster, type MeetingApiData } from "./speakerBacktest.js";

/**
 * Backtest of fixFromMinutes on a meeting a reviewer has corrected: the
 * reviewed transcript is the answer key for the text and for the speakers.
 *
 * The public meeting endpoint holds the reviewed text only. With `--input`,
 * a JSON file of utterance id to text as fixTranscript left it, the backtest
 * measures the word error rate before and after the task. Without it the
 * task runs on the reviewed text itself, and every substitution it applies
 * is a disagreement with the reviewer to read one by one.
 */

export type MinutesMeetingApiData = Omit<MeetingApiData, "meeting" | "transcript"> & {
    meeting: MeetingApiData["meeting"] & { sessionNumber?: number | null };
    transcript: (Omit<MeetingApiData["transcript"][number], "utterances"> & {
        id: string;
        utterances: { id: string; text: string; startTimestamp: number; endTimestamp: number }[];
    })[];
};

/** YYYY-MM-DD of an instant in the city's time zone. */
export function cityDate(dateTime: string, timeZone = "Europe/Athens"): string {
    return new Date(dateTime).toLocaleDateString("sv-SE", { timeZone });
}

export function buildMinutesRequest(data: MinutesMeetingApiData, municipalMinutesUrl: string, inputTexts: Record<string, string> = {}): FixFromMinutesRequest {
    const segments = [...data.transcript].sort((a, b) => a.startTimestamp - b.startTimestamp);
    return {
        callbackUrl: "",
        municipalMinutesUrl,
        meetingDate: cityDate(data.meeting.dateTime),
        sessionNumber: data.meeting.sessionNumber ?? null,
        transcript: segments.map(segment => ({
            speakerName: null,
            speakerParty: null,
            speakerRole: null,
            speakerId: segment.speakerTag.personId,
            speakerSegmentId: segment.id,
            speakerTagId: segment.speakerTag.id,
            text: segment.utterances.map(u => inputTexts[u.id] ?? u.text).join(" "),
            utterances: segment.utterances.map(u => ({ utteranceId: u.id, text: inputTexts[u.id] ?? u.text, startTimestamp: u.startTimestamp, endTimestamp: u.endTimestamp })),
        })),
        topicLabels: [],
        cityName: data.city.name,
        cityLanguage: data.city.language ?? "el",
        administrativeBodyName: data.meeting.administrativeBody?.name ?? "",
        people: meetingRoster(data),
        date: data.meeting.dateTime,
    };
}

/**
 * The words of a text for scoring: case, accents and punctuation folded, and
 * nothing else. The task's own comparison form also equates spelling variants
 * and number words with digits; scored with it, a wrong variant could never
 * show as an error.
 */
export const scoringWords = (text: string): string[] =>
    text.split(/\s+/).map(w => foldText(w).replace(/[^\p{L}\p{N}]+/gu, "")).filter(Boolean);

export type WordErrorRate = { errors: number; words: number; rate: number };

/** Word error rate of hypothesis texts against reference texts, utterance by utterance. */
export function wordErrorRate(pairs: { hypothesis: string; reference: string }[]): WordErrorRate {
    let errors = 0, total = 0;
    for (const { hypothesis, reference } of pairs) {
        const ref = scoringWords(reference);
        errors += levenshtein(scoringWords(hypothesis), ref);
        total += ref.length;
    }
    return { errors, words: total, rate: total === 0 ? 0 : errors / total };
}

export type ChangedUtterance = {
    utteranceId: string;
    before: string;
    after: string;
    reviewed: string;
    /** fixed: after equals the reviewed text; broke: before equaled it; closer/further: the distance to it moved; same: no change in distance. */
    outcome: "fixed" | "broke" | "closer" | "further" | "same";
};

export type CorrectionScore = {
    before: WordErrorRate;
    after: WordErrorRate;
    changed: ChangedUtterance[];
    outcomes: Record<ChangedUtterance["outcome"], number>;
};

/** Scores the task's text changes against the reviewed text. */
export function scoreCorrections(request: FixFromMinutesRequest, result: FixFromMinutesResult, reviewed: Map<string, string>): CorrectionScore {
    const before = new Map<string, string>();
    for (const segment of request.transcript) for (const u of segment.utterances) before.set(u.utteranceId, u.text);
    const after = new Map(before);
    for (const update of result.updateUtterances) after.set(update.utteranceId, update.text);

    const pairs = (texts: Map<string, string>) => [...reviewed].map(([id, reference]) => ({ hypothesis: texts.get(id) ?? "", reference }));
    const outcomes: CorrectionScore["outcomes"] = { fixed: 0, broke: 0, closer: 0, further: 0, same: 0 };
    const changed: ChangedUtterance[] = result.updateUtterances.map(update => {
        const ref = scoringWords(reviewed.get(update.utteranceId) ?? "");
        const dBefore = levenshtein(scoringWords(before.get(update.utteranceId) ?? ""), ref);
        const dAfter = levenshtein(scoringWords(update.text), ref);
        const outcome: ChangedUtterance["outcome"] = dAfter === 0 ? "fixed" : dBefore === 0 ? "broke" : dAfter < dBefore ? "closer" : dAfter > dBefore ? "further" : "same";
        outcomes[outcome]++;
        return { utteranceId: update.utteranceId, before: before.get(update.utteranceId) ?? "", after: update.text, reviewed: reviewed.get(update.utteranceId) ?? "", outcome };
    });
    return { before: wordErrorRate(pairs(before)), after: wordErrorRate(pairs(after)), changed, outcomes };
}

export type SpeakerRow = {
    speakerTagId: string;
    tagLabel: string | null;
    /** The person of the reviewed record, or null. */
    truthId: string | null;
    opinionId: string | null;
    purity: number;
    actionable: boolean;
    outcome: "right" | "wrong" | "unchecked" | "none";
};

/** The minutes' opinion on every speaker tag against the reviewed record. */
export function scoreSpeakers(data: MinutesMeetingApiData, result: FixFromMinutesResult): SpeakerRow[] {
    const hints = new Map((result.speakerHints ?? []).map(h => [h.speakerTagId, h]));
    const tags = new Map<string, { label: string | null; personId: string | null }>();
    for (const segment of data.transcript) if (!tags.has(segment.speakerTag.id)) tags.set(segment.speakerTag.id, { label: segment.speakerTag.label, personId: segment.speakerTag.personId });
    return [...tags].map(([speakerTagId, tag]) => {
        const hint = hints.get(speakerTagId);
        const opinionId = hint?.personId ?? null;
        const outcome: SpeakerRow["outcome"] = !opinionId ? "none" : !tag.personId ? "unchecked" : tag.personId === opinionId ? "right" : "wrong";
        return { speakerTagId, tagLabel: tag.label, truthId: tag.personId, opinionId, purity: hint?.confidence ?? 0, actionable: hint?.actionable ?? false, outcome };
    });
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

export function formatMinutesBacktest(meeting: string, result: FixFromMinutesResult, corrections: CorrectionScore, speakers: SpeakerRow[], names: Map<string, string>, options: { maxChanged?: number } = {}): string {
    const { report } = result;
    const lines: string[] = [];
    const name = (id: string | null) => (id ? names.get(id) ?? id : "—");
    lines.push(`Document: coverage ${pct(report.document.coverage)}, check +${report.document.checkAdded} turn starts, -${report.document.checkRemoved} labels, ${report.document.checkDropped} answers dropped, ${report.document.checkFailedChunks} chunk(s) failed`);
    lines.push(`Alignment: ${report.alignment.alignedTurns}/${report.alignment.turns} turns aligned, ${report.alignment.turnsUnderGate} under the gate, ${report.alignment.utterancesUnmatched} utterances unmatched`);
    lines.push(`Corrections: ${report.corrections.substitutions} substitutions in ${report.corrections.utterancesChanged} utterances; skipped ${report.corrections.insertionsSkipped} insertions, ${report.corrections.deletionsSkipped} deletions`);
    lines.push(`WER against the reviewed text: before ${pct(corrections.before.rate)} (${corrections.before.errors}/${corrections.before.words}), after ${pct(corrections.after.rate)} (${corrections.after.errors}/${corrections.after.words})`);
    const o = corrections.outcomes;
    lines.push(`Changed utterances: ${o.fixed} fixed, ${o.closer} closer, ${o.same} same distance, ${o.further} further, ${o.broke} broke a reviewed utterance`);
    const shown = corrections.changed.slice(0, options.maxChanged ?? 40);
    for (const c of shown) {
        lines.push(`  [${c.outcome}] ${c.utteranceId}`);
        lines.push(`     before:   ${c.before}`);
        lines.push(`     after:    ${c.after}`);
        if (c.outcome !== "fixed") lines.push(`     reviewed: ${c.reviewed}`);
    }
    if (corrections.changed.length > shown.length) lines.push(`  … ${corrections.changed.length - shown.length} more (write them with -O)`);

    const actionable = speakers.filter(s => s.actionable);
    const count = (rows: SpeakerRow[], outcome: SpeakerRow["outcome"]) => rows.filter(r => r.outcome === outcome).length;
    lines.push(`Speakers: ${speakers.length} tags; opinions on ${speakers.filter(s => s.opinionId).length}; actionable ${actionable.length}: ${count(actionable, "right")} right, ${count(actionable, "wrong")} wrong, ${count(actionable, "unchecked")} on a tag the record leaves unnamed`);
    lines.push(`  contested ${report.speakers.contested.length}, disagreements with the request's speaker ${report.speakers.disagreements.length}, unresolved labels: ${report.speakers.unresolvedLabels.join(", ") || "none"}`);
    for (const row of speakers.filter(s => s.opinionId)) {
        lines.push(`  ${row.actionable ? "ACT " : "    "} ${(row.tagLabel ?? row.speakerTagId).padEnd(24)} record ${name(row.truthId).padEnd(32)} minutes ${name(row.opinionId).padEnd(32)} purity ${String(row.purity).padStart(3)}  ${row.outcome}`);
    }
    return `===== ${meeting} =====\n${lines.join("\n")}`;
}
