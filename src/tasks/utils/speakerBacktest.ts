import { CityLanguage } from "../../types.js";
import { KnownSpeaker, RosterPerson, SpeakerIdentification, SpeakerSegmentInput } from "../../lib/speakerIdentification.js";

/**
 * Backtest of text-only speaker identification against meetings a human has
 * reviewed, side by side with the voiceprint matching the meeting already had.
 *
 * The reviewed record is the answer key for both methods. A meeting comes from
 * opencouncil's public meeting endpoint
 * (GET /api/cities/:cityId/meetings/:meetingId); only the fields listed here
 * are read.
 *
 * Stats count distinct people and speaking time, never speaker tags:
 * reviewers split tags freely during review, so a person can end up as twenty
 * tags that did not exist when the voiceprints ran.
 */

export type MeetingApiRole = {
    partyId: string | null;
    administrativeBodyId: string | null;
    isHead: boolean;
    name: string | null;
    name_en: string | null;
    startDate: string | null;
    endDate: string | null;
    party?: { name: string } | null;
    administrativeBody?: { name: string } | null;
};

export type MeetingApiData = {
    meeting: { id: string; cityId: string; dateTime: string; administrativeBodyId?: string | null; administrativeBody?: { name: string } | null };
    city: { name: string; language?: CityLanguage };
    transcript: {
        startTimestamp: number;
        endTimestamp: number;
        speakerTag: { id: string; label: string | null; personId: string | null; personSetBy?: AssignmentSource | null; createdAt?: string; updatedAt?: string };
        utterances: { text: string }[];
    }[];
    people: { id: string; name: string; roles: MeetingApiRole[] }[];
};

/**
 * What the reviewed record says about a speaker tag, and how it got there.
 * - voiceprint:          a voiceprint matched a roster person at import, and no reviewer changed it
 * - voiceprintCorrected: a voiceprint matched a person at import, then a reviewer changed the person
 * - voiceprintRemoved:   a voiceprint matched a person at import, then a reviewer removed the person
 * - review:              a reviewer linked the tag to a roster person
 * - offRoster:           no person, but a reviewer typed a name or role into the label — someone
 *                        not on the roster, such as a resident or an employee
 * - none:                no person and a placeholder label; nobody said who it is
 */
export type TruthSource = "voiceprint" | "voiceprintCorrected" | "voiceprintRemoved" | "review" | "offRoster" | "none";

/** opencouncil's SpeakerTag.personSetBy: who decided the tag's person. Absent on payloads that predate speaker hints. */
type AssignmentSource = "voiceprint" | "transcript" | "both" | "user";

// The import labels a voiceprint-matched speaker with the pipeline's raw
// "SPEAKER_N" and an unmatched one "Άγνωστος Ομιλητής N", whatever the city's
// language — but only since opencouncil 63812b2c. Before it, every speaker got
// SPEAKER_N, matched or not, so for those meetings the label proves nothing.
const VOICEPRINT_TAG_LABEL = /^SPEAKER_\d+$/;
const LABELS_TELL_MATCHES_SINCE = Date.parse("2025-12-16T00:00:00Z");
// Labels no human wrote. The editor names new tags "New speaker segment", or
// "New " + the old tag's label when a segment moves to a fresh tag — which
// describes the old tag, not this speaker.
// A bare role such as "Γραμματέας" names no one: the council's secretary can be a roster person or an employee.
const PLACEHOLDER_TAG_LABEL = /^(Άγνωστος Ομιλητής( \d+)?|New .*|Γραμματέας)$/iu;
// The import creates a tag and connects its person in one write, so an
// untouched tag has updatedAt equal to createdAt. Only a later edit — the
// reviewer changing the person — moves updatedAt. A few seconds of slack.
const EDIT_GRACE_MS = 5_000;

type TruthTag = MeetingApiData["transcript"][number]["speakerTag"] | { label: string | null; personId: string | null; personSetBy?: AssignmentSource | null; createdAt?: string; updatedAt?: string };

export function truthSource(tag: TruthTag): TruthSource {
    const label = tag.label?.trim() ?? "";
    const unlinked: TruthSource = label === "" || PLACEHOLDER_TAG_LABEL.test(label) ? "none" : "offRoster";

    // Meetings processed since speaker hints shipped say who decided each person.
    // Timestamps mean nothing there: storing a hint moves updatedAt by itself.
    if (tag.personSetBy !== undefined) {
        switch (tag.personSetBy) {
            case "voiceprint":
            case "both":
                return "voiceprint";
            case "transcript":
                // The transcript method's own earlier answer is not an answer key.
                return "none";
            case "user":
                if (VOICEPRINT_TAG_LABEL.test(label)) return tag.personId ? "voiceprintCorrected" : "voiceprintRemoved";
                return tag.personId ? "review" : unlinked;
            default:
                return tag.personId ? "review" : unlinked;
        }
    }

    if (VOICEPRINT_TAG_LABEL.test(label)) {
        const edited = Boolean(tag.createdAt && tag.updatedAt
            && new Date(tag.updatedAt).getTime() - new Date(tag.createdAt).getTime() > EDIT_GRACE_MS);
        const labelMeansMatched = tag.createdAt !== undefined && new Date(tag.createdAt).getTime() >= LABELS_TELL_MATCHES_SINCE;
        if (!labelMeansMatched) {
            // An untouched tag with a person was matched at import: nothing else
            // linked people then. Anything else may be an unmatched speaker a
            // reviewer later linked, or never identified — not a voiceprint error.
            if (!tag.personId) return "none";
            return edited ? "review" : "voiceprint";
        }
        if (!tag.personId) return "voiceprintRemoved";
        return edited ? "voiceprintCorrected" : "voiceprint";
    }
    return tag.personId ? "review" : unlinked;
}

/** The record links the tag to a roster person. */
export const isRosterSource = (source: TruthSource) => source === "voiceprint" || source === "voiceprintCorrected" || source === "review";

export type BacktestSpeaker = {
    label: string;
    speakerTagId: string;
    tagLabel: string | null;
    personId: string | null;
    source: TruthSource;
    speakingSeconds: number;
    segmentCount: number;
};

export type BacktestInput = {
    cityName: string;
    administrativeBodyName: string | null;
    language: CityLanguage;
    meetingDate: string;
    roster: RosterPerson[];
    segments: SpeakerSegmentInput[];
    speakers: BacktestSpeaker[];
    knownSpeakers: KnownSpeaker[];
};

export type AnchorMode = "none" | "voiceprint";

function isRoleActiveAt(role: MeetingApiRole, date: Date): boolean {
    if (role.startDate && new Date(role.startDate) > date) return false;
    if (role.endDate && new Date(role.endDate) < date) return false;
    return true;
}

/**
 * Roles and party for the roster line, as held on the meeting date. Roles in
 * the body that is meeting come first: the "Πρόεδρος" of a committee and the
 * "Πρόεδρος" of the council are different people. A party head is marked,
 * since "επικεφαλής της παράταξης" is a common floor cue.
 */
export function describePerson(person: MeetingApiData["people"][number], meetingDate: Date, meetingBodyId: string | null = null): RosterPerson {
    const active = person.roles.filter(r => isRoleActiveAt(r, meetingDate));
    const partyRole = active.find(r => r.partyId && r.party);
    const party = partyRole ? `${partyRole.party!.name}${partyRole.isHead ? " (head)" : ""}` : null;

    const nonParty = active.filter(r => !r.partyId);
    const inBody = meetingBodyId ? nonParty.filter(r => r.administrativeBodyId === meetingBodyId) : [];
    const ordered = [...inBody, ...nonParty.filter(r => !inBody.includes(r))];
    const describeRole = (r: MeetingApiRole): string | null => {
        if (!r.administrativeBodyId) return r.name || r.name_en || null;
        const title = r.name || r.name_en || (r.isHead ? "head" : null);
        return [title, r.administrativeBody?.name ?? null].filter(Boolean).join(", ") || null;
    };
    const roles = [...new Set(ordered.map(describeRole).filter((r): r is string => Boolean(r)))];

    return { id: person.id, name: person.name, role: roles.length > 0 ? roles.join("; ") : null, party, memberOfMeetingBody: inBody.length > 0 };
}

/**
 * Turns the meeting payload into identification input plus the stored truth.
 * Diarization labels are re-derived as S1, S2, ... in order of first speech,
 * so the model sees nothing of the stored tag labels or assignments.
 */
export function buildBacktestInput(data: MeetingApiData, opts: { anchor: AnchorMode }): BacktestInput {
    const meetingDate = new Date(data.meeting.dateTime);
    const ordered = [...data.transcript].sort((a, b) => a.startTimestamp - b.startTimestamp);

    const speakersByTag = new Map<string, BacktestSpeaker>();
    const segments: SpeakerSegmentInput[] = [];
    for (const segment of ordered) {
        const tag = segment.speakerTag;
        let speaker = speakersByTag.get(tag.id);
        if (!speaker) {
            speaker = {
                label: `S${speakersByTag.size + 1}`,
                speakerTagId: tag.id,
                tagLabel: tag.label,
                personId: tag.personId,
                source: truthSource(tag),
                speakingSeconds: 0,
                segmentCount: 0,
            };
            speakersByTag.set(tag.id, speaker);
        }
        speaker.speakingSeconds += Math.max(0, segment.endTimestamp - segment.startTimestamp);
        speaker.segmentCount++;

        const text = segment.utterances.map(u => u.text.trim()).filter(Boolean).join(" ");
        if (!text) continue;
        segments.push({ speakerLabel: speaker.label, start: segment.startTimestamp, end: segment.endTimestamp, text });
    }

    const speakers = [...speakersByTag.values()];
    // Only untouched voiceprint matches can be anchors: for a corrected one the
    // record holds the reviewer's person, not what the voiceprint said.
    const knownSpeakers: KnownSpeaker[] = opts.anchor === "voiceprint"
        ? speakers.filter(s => s.source === "voiceprint").map(s => ({ speakerLabel: s.label, personId: s.personId! }))
        : [];

    return {
        cityName: data.city.name,
        administrativeBodyName: data.meeting.administrativeBody?.name ?? null,
        language: data.city.language ?? "el",
        meetingDate: meetingDate.toISOString().slice(0, 10),
        roster: data.people.map(p => describePerson(p, meetingDate, data.meeting.administrativeBodyId ?? null)),
        segments,
        speakers,
        knownSpeakers,
    };
}

/** What the model's answer on one tag amounts to, against the record. */
export type Outcome =
    | "match"           // roster person, model named them
    | "mismatch"        // roster person, model named someone else
    | "missed"          // roster person, model abstained
    | "wrongOffRoster"  // off-roster speaker, model gave a roster name
    | "offRoster"       // off-roster speaker, model abstained
    | "unverified"      // nobody says who the speaker is, model gave a roster name
    | "unknown";        // nobody says who the speaker is, model abstained

export type ScoredSpeaker = BacktestSpeaker & {
    outcome: Outcome;
    predictedPersonId: string | null;
    confidence: number;
    /** The model named someone but under the threshold; counted as abstained. */
    belowThreshold: boolean;
    /** Handed to the model as known (--anchor voiceprint): not the model's own answer, so not scored as one. */
    known: boolean;
    evidence: string;
    alternatives: SpeakerIdentification["alternatives"];
};

export type Tally = { tags: number; seconds: number };

export type MethodStats = {
    /** Distinct roster people with at least one tag named correctly. */
    peopleNamed: number;
    /** Speaking time of the tags named correctly. */
    secondsNamed: number;
    /** Tags named correctly. */
    correctNames: number;
    /** Tags given a name the record contradicts. */
    wrongNames: number;
    wrongSeconds: number;
};

export type BacktestSummary = {
    /** Distinct roster people the record says spoke, and their speaking time. */
    rosterPeople: number;
    rosterSeconds: number;
    offRosterSpeakers: number;
    offRosterSeconds: number;
    /** Tags nobody identified, including voiceprint matches a reviewer removed. */
    unlabelledSpeakers: number;
    unlabelledSeconds: number;
    voiceprint: MethodStats;
    model: MethodStats & {
        /** Wrong names given to speakers a reviewer labelled as off the roster. */
        wrongOnOffRoster: number;
        /** Names given to speakers nobody identified: the record cannot say whether they are right. */
        unverifiedNames: number;
        unverifiedSeconds: number;
        /** Roster tags the model did not name, by reason. */
        missed: {
            /** No answer at all. */
            silent: Tally;
            /** Answered below the threshold, and the answer was right. */
            lowConfidenceRight: Tally;
            /** Answered below the threshold, and the answer was wrong. */
            lowConfidenceWrong: Tally;
        };
    };
    /** Voiceprints where they matched at import, the model everywhere else: what production would show in a city with voiceprints. */
    combined: MethodStats & { unverifiedNames: number; unverifiedSeconds: number };
    /** Distinct roster people, by which method named them. */
    people: { both: number; voiceprintOnly: number; modelOnly: number; neither: number };
    /** The model's answer on tags a voiceprint matched at import (removed matches excluded: their true person is unknown). */
    onVoiceprintTags: {
        agree: number;
        /** The model named someone else, and the voiceprint was right. */
        voiceprintRight: number;
        /** The model named the reviewer's person, and the voiceprint was wrong. */
        modelRight: number;
        /** A reviewer corrected the voiceprint, and the model named someone else again. */
        bothWrong: number;
        modelSilent: number;
    };
};

const emptyMethod = (): MethodStats => ({ peopleNamed: 0, secondsNamed: 0, correctNames: 0, wrongNames: 0, wrongSeconds: 0 });
const emptyTally = (): Tally => ({ tags: 0, seconds: 0 });

export function summarizeScored(scored: ScoredSpeaker[]): BacktestSummary {
    const summary: BacktestSummary = {
        rosterPeople: 0, rosterSeconds: 0, offRosterSpeakers: 0, offRosterSeconds: 0, unlabelledSpeakers: 0, unlabelledSeconds: 0,
        voiceprint: emptyMethod(),
        model: { ...emptyMethod(), wrongOnOffRoster: 0, unverifiedNames: 0, unverifiedSeconds: 0, missed: { silent: emptyTally(), lowConfidenceRight: emptyTally(), lowConfidenceWrong: emptyTally() } },
        combined: { ...emptyMethod(), unverifiedNames: 0, unverifiedSeconds: 0 },
        people: { both: 0, voiceprintOnly: 0, modelOnly: 0, neither: 0 },
        onVoiceprintTags: { agree: 0, voiceprintRight: 0, modelRight: 0, bothWrong: 0, modelSilent: 0 },
    };
    const rosterPeople = new Set<string>();
    const voiceprintPeople = new Set<string>();
    const modelPeople = new Set<string>();
    const combinedPeople = new Set<string>();

    // Applies one method's verdict on a tag to its stats.
    const count = (stats: MethodStats, people: Set<string>, s: ScoredSpeaker, right: boolean, wrong: boolean) => {
        if (right) {
            people.add(s.personId!);
            stats.correctNames++;
            stats.secondsNamed += s.speakingSeconds;
        } else if (wrong) {
            stats.wrongNames++;
            stats.wrongSeconds += s.speakingSeconds;
        }
    };

    for (const s of scored) {
        const t = s.speakingSeconds;
        if (isRosterSource(s.source)) {
            rosterPeople.add(s.personId!);
            summary.rosterSeconds += t;
        } else if (s.source === "offRoster") {
            summary.offRosterSpeakers++;
            summary.offRosterSeconds += t;
        } else {
            summary.unlabelledSpeakers++;
            summary.unlabelledSeconds += t;
        }

        const voiceprintMatched = s.source === "voiceprint" || s.source === "voiceprintCorrected" || s.source === "voiceprintRemoved";
        const voiceprintRight = s.source === "voiceprint";
        const modelRight = s.outcome === "match";
        const modelWrong = s.outcome === "mismatch" || s.outcome === "wrongOffRoster";

        count(summary.voiceprint, voiceprintPeople, s, voiceprintRight, voiceprintMatched && !voiceprintRight);

        // An anchor was given to the model, not found by it.
        if (!s.known) count(summary.model, modelPeople, s, modelRight, modelWrong);
        if (s.outcome === "wrongOffRoster") summary.model.wrongOnOffRoster++;
        if (s.outcome === "unverified") {
            summary.model.unverifiedNames++;
            summary.model.unverifiedSeconds += t;
        }
        if (s.outcome === "missed") {
            const reason = !s.predictedPersonId ? "silent" : s.predictedPersonId === s.personId ? "lowConfidenceRight" : "lowConfidenceWrong";
            summary.model.missed[reason].tags++;
            summary.model.missed[reason].seconds += t;
        }

        if (voiceprintMatched) {
            count(summary.combined, combinedPeople, s, voiceprintRight, !voiceprintRight);
        } else {
            count(summary.combined, combinedPeople, s, modelRight, modelWrong);
            if (s.outcome === "unverified") {
                summary.combined.unverifiedNames++;
                summary.combined.unverifiedSeconds += t;
            }
        }

        const answered = s.outcome === "match" || s.outcome === "mismatch";
        if (s.known) continue;
        if (s.source === "voiceprint") {
            const k = !answered ? "modelSilent" : modelRight ? "agree" : "voiceprintRight";
            summary.onVoiceprintTags[k]++;
        } else if (s.source === "voiceprintCorrected") {
            const k = !answered ? "modelSilent" : modelRight ? "modelRight" : "bothWrong";
            summary.onVoiceprintTags[k]++;
        }
    }

    summary.rosterPeople = rosterPeople.size;
    summary.voiceprint.peopleNamed = voiceprintPeople.size;
    summary.model.peopleNamed = modelPeople.size;
    summary.combined.peopleNamed = combinedPeople.size;
    for (const id of rosterPeople) {
        const v = voiceprintPeople.has(id), m = modelPeople.has(id);
        summary.people[v && m ? "both" : v ? "voiceprintOnly" : m ? "modelOnly" : "neither"]++;
    }
    return summary;
}

/** Sums every count of two same-shaped objects. */
function addCounts<T>(a: T, b: T): T {
    if (typeof a === "number") return ((a as number) + (b as unknown as number)) as unknown as T;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(a as object)) {
        out[key] = addCounts((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]);
    }
    return out as T;
}

/** Adds meetings up. A person who spoke in two meetings counts once per meeting. */
export function aggregateSummaries(summaries: BacktestSummary[]): BacktestSummary {
    return summaries.reduce((a, b) => addCounts(a, b), summarizeScored([]));
}

export function scoreBacktest(
    speakers: BacktestSpeaker[],
    identifications: SpeakerIdentification[],
    minConfidence: number
): { scored: ScoredSpeaker[]; summary: BacktestSummary } {
    const byLabel = new Map(identifications.map(i => [i.speakerLabel, i]));

    const scored = speakers.map((speaker): ScoredSpeaker => {
        const verdict = byLabel.get(speaker.label);
        const proposed = verdict?.personId ?? null;
        const confidence = verdict?.confidence ?? 0;
        const belowThreshold = proposed !== null && confidence < minConfidence;
        const predicted = belowThreshold ? null : proposed;

        let outcome: Outcome;
        if (isRosterSource(speaker.source)) {
            outcome = predicted === speaker.personId ? "match" : predicted ? "mismatch" : "missed";
        } else if (speaker.source === "offRoster") {
            outcome = predicted ? "wrongOffRoster" : "offRoster";
        } else {
            outcome = predicted ? "unverified" : "unknown";
        }
        return {
            ...speaker,
            outcome,
            predictedPersonId: proposed,
            confidence,
            belowThreshold,
            known: verdict?.known ?? false,
            evidence: verdict?.evidence ?? "",
            alternatives: verdict?.alternatives ?? [],
        };
    });

    return { scored, summary: summarizeScored(scored) };
}

export const SWEEP_THRESHOLDS = [50, 60, 70, 80, 90];

/** Scores the same cached answers at several confidence thresholds, adding the meetings up at each. */
export function thresholdSweep(
    meetings: { speakers: BacktestSpeaker[]; identifications: SpeakerIdentification[] }[],
    thresholds: number[] = SWEEP_THRESHOLDS
): { threshold: number; summary: BacktestSummary }[] {
    return thresholds.map(threshold => ({
        threshold,
        summary: aggregateSummaries(meetings.map(m => scoreBacktest(m.speakers, m.identifications, threshold).summary)),
    }));
}

// List prices in USD per million tokens, for estimating what a backtest run cost.
// Cache writes are billed at 1.25× input and cache reads at 0.1× input.
const PRICES_PER_MILLION: Record<string, { input: number; output: number }> = {
    "claude-sonnet-4-6": { input: 3, output: 15 },
    "claude-sonnet-5": { input: 2, output: 10 },
    "claude-opus-5": { input: 5, output: 25 },
    "claude-opus-4-8": { input: 5, output: 25 },
    "claude-haiku-4-5": { input: 1, output: 5 },
    "claude-haiku-4-5-20251001": { input: 1, output: 5 },
    "claude-fable-5-1": { input: 10, output: 50 },
};

export function estimateCostUsd(
    model: string,
    usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null }
): number | null {
    const price = PRICES_PER_MILLION[model];
    if (!price) return null;
    const input = usage.input_tokens + 1.25 * (usage.cache_creation_input_tokens ?? 0) + 0.1 * (usage.cache_read_input_tokens ?? 0);
    return (input * price.input + usage.output_tokens * price.output) / 1_000_000;
}

const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
const duration = (seconds: number) => (seconds < 60 ? `${Math.round(seconds)}s` : `${(seconds / 60).toFixed(1)}m`);
// Small shares keep a decimal: "0%" would hide a wrong name among hours of correct ones.
const share = (n: number, d: number) => {
    if (d <= 0) return "n/a";
    const p = (100 * n) / d;
    return `${p > 0 && p < 10 ? p.toFixed(1) : Math.round(p)}%`;
};
const totalSeconds = (tags: ScoredSpeaker[]) => tags.reduce((n, t) => n + t.speakingSeconds, 0);
const usd = (cost: number | null | undefined) => (cost === null || cost === undefined ? "?" : `$${cost.toFixed(2)}`);

export function formatBacktestReport(
    scored: ScoredSpeaker[],
    summary: BacktestSummary,
    roster: RosterPerson[],
    minConfidence: number,
    opts: { includeSpeakers?: boolean } = {}
): string {
    const nameOf = (id: string | null) => (id ? roster.find(p => p.id === id)?.name ?? id : "—");
    const lines: string[] = [];

    if (opts.includeSpeakers ?? true) {
        const byPerson = new Map<string, ScoredSpeaker[]>();
        for (const s of scored) {
            if (isRosterSource(s.source)) byPerson.set(s.personId!, [...(byPerson.get(s.personId!) ?? []), s]);
        }
        const people = [...byPerson.entries()]
            .map(([id, tags]) => ({ id, tags, seconds: totalSeconds(tags) }))
            .sort((a, b) => b.seconds - a.seconds);

        lines.push(`${pad("roster person", 36)}${pad("tags", 6)}${pad("time", 8)}${pad("voiceprints", 24)}model`);
        for (const p of people) {
            const voiceprintRight = p.tags.filter(t => t.source === "voiceprint");
            const voiceprintWrong = p.tags.filter(t => t.source === "voiceprintCorrected");
            const modelRight = p.tags.filter(t => t.outcome === "match");
            const modelWrong = p.tags.filter(t => t.outcome === "mismatch");
            const voiceprint = [
                voiceprintRight.length > 0 ? `named ${duration(totalSeconds(voiceprintRight))}` : "",
                voiceprintWrong.length > 0 ? `${voiceprintWrong.length} wrong` : "",
            ].filter(Boolean).join(", ") || "—";
            const model = [
                modelRight.length > 0 ? `named ${p.tags.length > 1 ? `${modelRight.length} of ${p.tags.length} tags, ` : ""}${duration(totalSeconds(modelRight))}` : "",
                modelWrong.length > 0 ? `${modelWrong.length} wrong` : "",
            ].filter(Boolean).join(", ") || "—";
            lines.push(`${pad(nameOf(p.id), 36)}${pad(String(p.tags.length), 6)}${pad(duration(p.seconds), 8)}${pad(voiceprint, 24)}${model}`);
        }

        const offRoster = scored.filter(s => s.source === "offRoster").sort((a, b) => b.speakingSeconds - a.speakingSeconds);
        if (offRoster.length > 0) {
            lines.push("");
            lines.push(`${pad("off-roster speaker (reviewer's label)", 50)}${pad("time", 8)}model`);
            for (const s of offRoster) {
                const model = s.outcome === "wrongOffRoster" ? `wrong: ${nameOf(s.predictedPersonId)} (${s.confidence})` : "not named";
                lines.push(`${pad(s.tagLabel ?? "", 50)}${pad(duration(s.speakingSeconds), 8)}${model}`);
            }
        }
        lines.push("");
    }

    const voiceprintWrong = scored.filter(s => s.source === "voiceprintCorrected" || s.source === "voiceprintRemoved");
    const modelWrong = scored.filter(s => s.outcome === "mismatch" || s.outcome === "wrongOffRoster");
    const unverified = scored.filter(s => s.outcome === "unverified");
    if (voiceprintWrong.length + modelWrong.length + unverified.length > 0) {
        lines.push("Wrong and unchecked names");
        for (const s of voiceprintWrong) {
            const what = s.source === "voiceprintCorrected" ? `a reviewer changed the match to ${nameOf(s.personId)}` : "a reviewer removed the match";
            lines.push(`  voiceprint ${duration(s.speakingSeconds).padStart(6)}  ${what}`);
        }
        for (const s of modelWrong) {
            const record = s.source === "offRoster" ? `"${s.tagLabel}" (off roster)` : nameOf(s.personId);
            lines.push(`  model      ${duration(s.speakingSeconds).padStart(6)}  ${s.label}: record says ${record}, model said ${nameOf(s.predictedPersonId)} (${s.confidence}). ${s.evidence.replace(/\s+/g, " ").slice(0, 160)}`);
        }
        for (const s of unverified) {
            lines.push(`  unchecked  ${duration(s.speakingSeconds).padStart(6)}  ${s.label}: nobody identified this speaker; model said ${nameOf(s.predictedPersonId)} (${s.confidence})`);
        }
        lines.push("");
    }

    const R = summary.rosterPeople, T = summary.rosterSeconds;
    const methods = [summary.voiceprint, summary.model, summary.combined];
    const row = (label: string, cells: string[]) => `  ${pad(label, 32)}${pad(cells[0], 22)}${pad(cells[1], 22)}${cells[2]}`;
    lines.push(row("", ["voiceprints", `model (≥ ${minConfidence})`, "voiceprints, then model"]));
    lines.push(row("roster people named", methods.map(m => `${m.peopleNamed} of ${R} (${share(m.peopleNamed, R)})`)));
    lines.push(row("their speaking time named", methods.map(m => `${share(m.secondsNamed, T)} of ${duration(T)}`)));
    lines.push(row("wrong names", methods.map(m => `${m.wrongNames} of ${m.correctNames + m.wrongNames} (${share(m.wrongNames, m.correctNames + m.wrongNames)})`)));
    lines.push(row("  share of named time wrong", methods.map(m => `${share(m.wrongSeconds, m.secondsNamed + m.wrongSeconds)} (${duration(m.wrongSeconds)})`)));
    lines.push(row("roster speech left to review", methods.map(m => duration(Math.max(0, T - m.secondsNamed)))));
    lines.push(row("names nobody can check", ["—", `${summary.model.unverifiedNames} (${duration(summary.model.unverifiedSeconds)})`, `${summary.combined.unverifiedNames} (${duration(summary.combined.unverifiedSeconds)})`]));
    lines.push("");

    const p = summary.people, v = summary.onVoiceprintTags, miss = summary.model.missed;
    const disagreed = v.voiceprintRight + v.modelRight;
    lines.push(`  roster people found: ${p.both} by both, ${p.voiceprintOnly} by voiceprints only, ${p.modelOnly} by the model only, ${p.neither} by neither`);
    lines.push(`  model on voiceprint matches: agreed ${v.agree}, disagreed ${disagreed} (voiceprint right ${v.voiceprintRight}, model right ${v.modelRight}), both wrong ${v.bothWrong}, no answer ${v.modelSilent}`);
    lines.push(`  roster speech the model missed, ${duration(miss.silent.seconds + miss.lowConfidenceRight.seconds + miss.lowConfidenceWrong.seconds)}: no answer ${duration(miss.silent.seconds)}, below threshold but right ${duration(miss.lowConfidenceRight.seconds)}, below threshold and wrong ${duration(miss.lowConfidenceWrong.seconds)}`);
    lines.push(`  model wrong names on off-roster speakers: ${summary.model.wrongOnOffRoster} (voiceprints: not measurable)`);
    lines.push(`  also spoke: ${summary.offRosterSpeakers} off-roster speaker tags (${duration(summary.offRosterSeconds)}), ${summary.unlabelledSpeakers} unidentified (${duration(summary.unlabelledSeconds)})`);
    return lines.join("\n");
}

export function formatMeetingTable(
    rows: { meeting: string; body: string | null; summary: BacktestSummary; costUsd?: number | null }[],
    total: BacktestSummary
): string {
    const header1 = `${pad("", 57)}${pad("voiceprints", 19)}${pad("model", 25)}${pad("combined", 13)}`;
    const header2 = `${pad("meeting", 22)}${pad("body", 20)}${pad("people", 7)}${pad("time", 8)}` +
        `${pad("people", 7)}${pad("time", 6)}${pad("wrong", 6)}` +
        `${pad("people", 7)}${pad("time", 6)}${pad("wrong", 6)}${pad("unchk", 6)}` +
        `${pad("time", 6)}${pad("wrong", 7)}cost`;
    const line = (meeting: string, body: string, s: BacktestSummary, cost: string) =>
        `${pad(meeting, 22)}${pad(body, 20)}${pad(String(s.rosterPeople), 7)}${pad(duration(s.rosterSeconds), 8)}` +
        `${pad(share(s.voiceprint.peopleNamed, s.rosterPeople), 7)}${pad(share(s.voiceprint.secondsNamed, s.rosterSeconds), 6)}${pad(String(s.voiceprint.wrongNames), 6)}` +
        `${pad(share(s.model.peopleNamed, s.rosterPeople), 7)}${pad(share(s.model.secondsNamed, s.rosterSeconds), 6)}${pad(String(s.model.wrongNames), 6)}${pad(String(s.model.unverifiedNames), 6)}` +
        `${pad(share(s.combined.secondsNamed, s.rosterSeconds), 6)}${pad(String(s.combined.wrongNames), 7)}${cost}`;
    const costs = rows.map(r => r.costUsd);
    const totalCost = costs.some(c => c === null || c === undefined) ? null : (costs as number[]).reduce((a, b) => a + b, 0);
    return [
        header1,
        header2,
        ...rows.map(r => line(r.meeting, r.body ?? "?", r.summary, usd(r.costUsd))),
        "-".repeat(header2.length + 6),
        line("all meetings", "", total, usd(totalCost)),
        "",
        "people, time: distinct roster people who spoke and their speaking time; across meetings a person counts once per meeting.",
        "Each method's people and time are the share it named correctly. wrong: names the record contradicts (for voiceprints, import",
        "matches a reviewer later changed or removed). unchk: model names on speakers nobody identified. combined: voiceprints where",
        "they matched at import, the model for everyone else. cost: list-price estimate of the run that produced the model's answers.",
    ].join("\n");
}

export function formatThresholdSweep(rows: { threshold: number; summary: BacktestSummary }[], chosen: number): string {
    const header = `${pad("threshold", 12)}${pad("people", 8)}${pad("time", 7)}${pad("wrong", 8)}${pad("wrong time", 12)}${pad("unchecked", 11)}${pad("missed, right", 15)}${pad("combined time", 15)}combined wrong`;
    const lines = [header];
    for (const { threshold, summary: s } of rows) {
        const m = s.model;
        lines.push(
            `${pad(`${threshold}${threshold === chosen ? " ←" : ""}`, 12)}` +
            `${pad(share(m.peopleNamed, s.rosterPeople), 8)}${pad(share(m.secondsNamed, s.rosterSeconds), 7)}` +
            `${pad(String(m.wrongNames), 8)}${pad(share(m.wrongSeconds, m.secondsNamed + m.wrongSeconds), 12)}` +
            `${pad(String(m.unverifiedNames), 11)}${pad(duration(m.missed.lowConfidenceRight.seconds), 15)}` +
            `${pad(share(s.combined.secondsNamed, s.rosterSeconds), 15)}${s.combined.wrongNames}`
        );
    }
    lines.push("");
    lines.push("people, time: share of roster people and speaking time the model named correctly. wrong: wrong model names;");
    lines.push("wrong time: their share of the speaking time the model named. missed, right: roster speech the model answered");
    lines.push("correctly but below the threshold. combined: voiceprints where they matched at import, the model for the rest.");
    return lines.join("\n");
}
