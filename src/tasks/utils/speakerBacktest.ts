import crypto from "crypto";
import { CityLanguage } from "../../types.js";
import { ACTIONABLE_EVIDENCE_KINDS, isActionable, KnownSpeaker, MIN_ACTIONABLE_CONFIDENCE, RosterPerson, SpeakerEvidenceKind, SpeakerIdentification, SpeakerSegmentInput, SPEAKER_EVIDENCE_KINDS } from "../../lib/speakerIdentification.js";

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
    /** Set on a city-level role (mayor, deputy mayor, general secretary), which has no party and no body. */
    cityId?: string | null;
    partyId: string | null;
    administrativeBodyId: string | null;
    isHead: boolean;
    name: string | null;
    name_en: string | null;
    startDate: string | null;
    endDate: string | null;
    party?: { name: string } | null;
    /** type: "council", "committee" or "community". */
    administrativeBody?: { name: string; type?: string } | null;
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

/**
 * opencouncil's SpeakerTag.personSetBy: who decided the tag's person. Absent on
 * payloads that predate speaker hints. Null on a tag nothing has recorded
 * itself on: a speaker nobody named, and every tag from before speaker hints
 * that no reviewer edited, an import's voiceprint match included.
 */
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

    // A method that set the person recorded itself, whatever the timestamps say:
    // an automatic pass moves updatedAt too.
    if (tag.personSetBy === "voiceprint" || tag.personSetBy === "both") return "voiceprint";
    // The transcript method's own earlier answer is not an answer key.
    if (tag.personSetBy === "transcript") return "none";

    if (VOICEPRINT_TAG_LABEL.test(label)) {
        // A reviewer's edit is recorded as such. On a tag with no recorded source,
        // which is every untouched tag from before sources were recorded, a moved
        // updatedAt says the same.
        const edited = tag.personSetBy === "user" || Boolean(tag.createdAt && tag.updatedAt
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
    /** How many people the city has, of whom the roster may be a part. */
    cityPeople: number;
    segments: SpeakerSegmentInput[];
    speakers: BacktestSpeaker[];
    knownSpeakers: KnownSpeaker[];
};

export type AnchorMode = "none" | "voiceprint";

/**
 * Who the model may answer with.
 * - meeting: the people who may speak at the meeting, which is what opencouncil sends fixTranscript
 * - city:    everyone the city has a person record for
 */
export type RosterMode = "meeting" | "city";

/**
 * A short hash of everything the model is shown for a meeting. The verdict
 * cache is keyed by it: a meeting whose transcript, speaker split, roster or
 * anchors changed at the same URL is identified again, instead of old verdicts
 * being scored against the newly loaded meeting. The answer key (who each
 * speaker is on the record) is left out on purpose — a reviewer changing it
 * does not change what the model was asked.
 */
export function identificationFingerprint(input: BacktestInput): string {
    const { cityName, administrativeBodyName, language, meetingDate, roster, segments, knownSpeakers } = input;
    const shown = { cityName, administrativeBodyName, language, meetingDate, roster, segments, knownSpeakers };
    return crypto.createHash("sha256").update(JSON.stringify(shown)).digest("hex").slice(0, 16);
}

function isRoleActiveAt(role: MeetingApiRole, date: Date): boolean {
    if (role.startDate && new Date(role.startDate) > date) return false;
    if (role.endDate && new Date(role.endDate) < date) return false;
    return true;
}

/**
 * Whether a person may speak at a meeting of the given body: the members of
 * that body, the municipal council, the holders of a city-level role on the
 * meeting date, the heads of the communities, and people with no body.
 *
 * This is opencouncil's rule (maySpeakAtMeeting in src/lib/db/people.ts), kept
 * here so the backtest hands the model the list production does. Change the two
 * together.
 *
 * As there, only city-level roles are read on the meeting date. Membership
 * counts whenever it was held: on 53 reviewed meetings a date check would have
 * dropped about one person from a list and left out two who spoke.
 */
export function maySpeakAtMeeting(person: MeetingApiData["people"][number], meetingBodyId: string, meetingDate: Date): boolean {
    const hasCityLevelRole = person.roles.some(r => isRoleActiveAt(r, meetingDate) && Boolean(r.cityId) && !r.partyId && !r.administrativeBodyId);
    if (hasCityLevelRole) return true;
    const isInMeetingBody = person.roles.some(r => r.administrativeBodyId === meetingBodyId);
    const isInCouncil = person.roles.some(r => r.administrativeBody?.type === "council");
    const isCommunityHead = person.roles.some(r => r.administrativeBody?.type === "community" && r.isHead);
    const hasNoBody = !person.roles.some(r => r.administrativeBody);
    return isInMeetingBody || isInCouncil || isCommunityHead || hasNoBody;
}

/**
 * Roles and party for the roster line, as held on the meeting date. Roles in
 * the body that is meeting come first: the "Πρόεδρος" of a committee and the
 * "Πρόεδρος" of the council are different people. A party head is flagged,
 * since "επικεφαλής της παράταξης" is a common floor cue.
 */
export function describePerson(person: MeetingApiData["people"][number], meetingDate: Date, meetingBodyId: string | null = null): RosterPerson {
    const active = person.roles.filter(r => isRoleActiveAt(r, meetingDate));
    const partyRole = active.find(r => r.partyId && r.party);
    const party = partyRole ? partyRole.party!.name : null;

    const nonParty = active.filter(r => !r.partyId);
    const inBody = meetingBodyId ? nonParty.filter(r => r.administrativeBodyId === meetingBodyId) : [];
    const ordered = [...inBody, ...nonParty.filter(r => !inBody.includes(r))];
    const describeRole = (r: MeetingApiRole): string | null => {
        if (!r.administrativeBodyId) return r.name || r.name_en || null;
        const title = r.name || r.name_en || (r.isHead ? "head" : null);
        return [title, r.administrativeBody?.name ?? null].filter(Boolean).join(", ") || null;
    };
    const roles = [...new Set(ordered.map(describeRole).filter((r): r is string => Boolean(r)))];

    return {
        id: person.id, name: person.name, role: roles.length > 0 ? roles.join("; ") : null, party,
        ...(partyRole?.isHead ? { partyHead: true } : {}),
        memberOfMeetingBody: inBody.length > 0,
    };
}

/**
 * Turns the meeting payload into identification input plus the stored truth.
 * Diarization labels are re-derived as S1, S2, ... in order of first speech,
 * so the model sees nothing of the stored tag labels or assignments.
 */
export function buildBacktestInput(data: MeetingApiData, opts: { anchor: AnchorMode; roster?: RosterMode }): BacktestInput {
    const meetingDate = new Date(data.meeting.dateTime);
    const meetingBodyId = data.meeting.administrativeBodyId ?? null;
    // A meeting with no body gets the whole city, as in opencouncil.
    const rosterPeople = (opts.roster ?? "meeting") === "meeting" && meetingBodyId
        ? data.people.filter(p => maySpeakAtMeeting(p, meetingBodyId, meetingDate))
        : data.people;
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
        roster: rosterPeople.map(p => describePerson(p, meetingDate, meetingBodyId)),
        cityPeople: data.people.length,
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
    evidenceKind: SpeakerEvidenceKind | null;
    contested: boolean;
    /** The model named someone, but the name is not one this scoring accepts; counted as abstained. */
    heldBack: boolean;
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
            /** Named someone the scoring held back, and the name was right. */
            heldBackRight: Tally;
            /** Named someone the scoring held back, and the name was wrong. */
            heldBackWrong: Tally;
        };
    };
    /**
     * What production would show in a city with voiceprints: the two methods
     * reconciled the way opencouncil reconciles them. Where both name the same
     * person or only one names anyone, that name; where they name different
     * people, nobody, and the speaker is withheld for a reviewer.
     */
    combined: MethodStats & {
        unverifiedNames: number;
        unverifiedSeconds: number;
        /** Speakers left unnamed because the methods disagreed. */
        withheldNames: number;
        withheldSeconds: number;
    };
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
        model: { ...emptyMethod(), wrongOnOffRoster: 0, unverifiedNames: 0, unverifiedSeconds: 0, missed: { silent: emptyTally(), heldBackRight: emptyTally(), heldBackWrong: emptyTally() } },
        combined: { ...emptyMethod(), unverifiedNames: 0, unverifiedSeconds: 0, withheldNames: 0, withheldSeconds: 0 },
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
            const reason = !s.predictedPersonId ? "silent" : s.predictedPersonId === s.personId ? "heldBackRight" : "heldBackWrong";
            summary.model.missed[reason].tags++;
            summary.model.missed[reason].seconds += t;
        }

        if (voiceprintMatched) {
            // opencouncil's reconcile: a name the model would act on that differs
            // from the voiceprint's leaves the speaker unnamed. The record holds
            // the voiceprint's own person only while the match stands, so:
            // - a standing match is withheld when the model names someone else;
            // - a corrected match is withheld when the model names the reviewer's
            //   person, which the voiceprint by definition did not;
            // - any other wrong match counts as published. The model may have
            //   named a third person there, which would withhold it too, so this
            //   is the upper bound on wrong names.
            const modelName = s.known || s.heldBack ? null : s.predictedPersonId;
            const disagree = voiceprintRight
                ? modelName !== null && modelName !== s.personId
                : s.source === "voiceprintCorrected" && modelName === s.personId;
            if (disagree) {
                summary.combined.withheldNames++;
                summary.combined.withheldSeconds += t;
            } else {
                count(summary.combined, combinedPeople, s, voiceprintRight, !voiceprintRight);
            }
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

/** Which of the model's names count as answers. Every other name is scored as an abstention. */
export type AcceptAnswer = (identification: SpeakerIdentification) => boolean;

/** The pass's own decision: what production acts on. Decided again from each answer, so cached answers are scored by the rule as it stands. */
export const acceptActionable: AcceptAnswer = identification => identification.known || isActionable(identification);

/** A bare confidence threshold, for comparing the pass's decision with what a threshold would do. */
export const acceptAtConfidence = (minConfidence: number): AcceptAnswer =>
    identification => identification.known || identification.confidence >= minConfidence;

export function scoreBacktest(
    speakers: BacktestSpeaker[],
    identifications: SpeakerIdentification[],
    accept: AcceptAnswer = acceptActionable
): { scored: ScoredSpeaker[]; summary: BacktestSummary } {
    const byLabel = new Map(identifications.map(i => [i.speakerLabel, i]));

    const scored = speakers.map((speaker): ScoredSpeaker => {
        const verdict = byLabel.get(speaker.label);
        const proposed = verdict?.personId ?? null;
        const confidence = verdict?.confidence ?? 0;
        const heldBack = verdict !== undefined && proposed !== null && !accept(verdict);
        const predicted = heldBack ? null : proposed;

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
            evidenceKind: verdict?.evidenceKind ?? null,
            contested: verdict?.contested ?? false,
            heldBack,
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
        summary: aggregateSummaries(meetings.map(m => scoreBacktest(m.speakers, m.identifications, acceptAtConfidence(threshold)).summary)),
    }));
}

export type EvidenceRow = { label: string; summary: BacktestSummary };

const LOW_CONFIDENCE_ROW = `under ${MIN_ACTIONABLE_CONFIDENCE}`;

/** A name on evidence the pass acts on, at a confidence under its floor: the floor alone holds it back. */
const isUnderFloor = (i: SpeakerIdentification) =>
    i.evidenceKind !== null && ACTIONABLE_EVIDENCE_KINDS.has(i.evidenceKind) && i.confidence < MIN_ACTIONABLE_CONFIDENCE;

/**
 * Scores the same cached answers one kind of evidence at a time, then the
 * names the confidence floor holds back, then contested labels, then what the
 * pass acts on. This is the table that says which kinds the pass can act on:
 * each row shows how often names resting on that evidence alone are wrong. A
 * label counts under its strongest kind. A name under the floor counts under
 * the floor's row only, and a contested label under "contested" only, so the
 * rows the pass acts on add up to the last one.
 */
export function evidenceBreakdown(meetings: { speakers: BacktestSpeaker[]; identifications: SpeakerIdentification[] }[]): EvidenceRow[] {
    const score = (accept: AcceptAnswer) => aggregateSummaries(meetings.map(m => scoreBacktest(m.speakers, m.identifications, accept).summary));
    return [
        ...SPEAKER_EVIDENCE_KINDS.map(kind => ({ label: kind, summary: score(i => !i.known && !i.contested && i.evidenceKind === kind && !isUnderFloor(i)) })),
        { label: "no kind given", summary: score(i => !i.known && !i.contested && i.evidenceKind === null) },
        { label: LOW_CONFIDENCE_ROW, summary: score(i => !i.known && !i.contested && isUnderFloor(i)) },
        { label: "contested", summary: score(i => !i.known && i.contested) },
        { label: "acted on", summary: score(acceptActionable) },
    ];
}

// List prices in USD per million tokens, for estimating what a backtest run cost.
// Cache writes are billed at 1.25× input and cache reads at 0.1× input.
const PRICES_PER_MILLION: Record<string, { input: number; output: number }> = {
    "claude-sonnet-4-6": { input: 3, output: 15 },
    "claude-sonnet-5": { input: 2, output: 10 },
    "claude-sonnet-5-5": { input: 2, output: 10 },
    "claude-opus-5": { input: 5, output: 25 },
    "claude-opus-5-5": { input: 4, output: 20 },
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
    /** How the model's names were accepted, for the column header: "acted on", or "≥ 80". */
    accepted: string,
    opts: { includeSpeakers?: boolean } = {}
): string {
    const basis = (s: ScoredSpeaker) => `${s.contested ? "contested, " : ""}${s.evidenceKind ?? "no kind"}, ${s.confidence}`;
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
                const model = s.outcome === "wrongOffRoster" ? `wrong: ${nameOf(s.predictedPersonId)} (${basis(s)})` : "not named";
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
            lines.push(`  model      ${duration(s.speakingSeconds).padStart(6)}  ${s.label}: record says ${record}, model said ${nameOf(s.predictedPersonId)} (${basis(s)}). ${s.evidence.replace(/\s+/g, " ").slice(0, 160)}`);
        }
        for (const s of unverified) {
            lines.push(`  unchecked  ${duration(s.speakingSeconds).padStart(6)}  ${s.label}: nobody identified this speaker; model said ${nameOf(s.predictedPersonId)} (${basis(s)})`);
        }
        lines.push("");
    }

    const R = summary.rosterPeople, T = summary.rosterSeconds;
    const methods = [summary.voiceprint, summary.model, summary.combined];
    const row = (label: string, cells: string[]) => `  ${pad(label, 32)}${pad(cells[0], 22)}${pad(cells[1], 22)}${cells[2]}`;
    lines.push(row("", ["voiceprints", `model (${accepted})`, "both, reconciled"]));
    lines.push(row("roster people named", methods.map(m => `${m.peopleNamed} of ${R} (${share(m.peopleNamed, R)})`)));
    lines.push(row("their speaking time named", methods.map(m => `${share(m.secondsNamed, T)} of ${duration(T)}`)));
    lines.push(row("wrong names", methods.map(m => `${m.wrongNames} of ${m.correctNames + m.wrongNames} (${share(m.wrongNames, m.correctNames + m.wrongNames)})`)));
    lines.push(row("  share of named time wrong", methods.map(m => `${share(m.wrongSeconds, m.secondsNamed + m.wrongSeconds)} (${duration(m.wrongSeconds)})`)));
    lines.push(row("roster speech left to review", methods.map(m => duration(Math.max(0, T - m.secondsNamed)))));
    lines.push(row("names nobody can check", ["—", `${summary.model.unverifiedNames} (${duration(summary.model.unverifiedSeconds)})`, `${summary.combined.unverifiedNames} (${duration(summary.combined.unverifiedSeconds)})`]));
    lines.push(row("withheld, the methods disagree", ["—", "—", `${summary.combined.withheldNames} (${duration(summary.combined.withheldSeconds)})`]));
    lines.push("");

    const p = summary.people, v = summary.onVoiceprintTags, miss = summary.model.missed;
    const disagreed = v.voiceprintRight + v.modelRight;
    lines.push(`  roster people found: ${p.both} by both, ${p.voiceprintOnly} by voiceprints only, ${p.modelOnly} by the model only, ${p.neither} by neither`);
    lines.push(`  model on voiceprint matches: agreed ${v.agree}, disagreed ${disagreed} (voiceprint right ${v.voiceprintRight}, model right ${v.modelRight}), both wrong ${v.bothWrong}, no answer ${v.modelSilent}`);
    lines.push(`  roster speech the model missed, ${duration(miss.silent.seconds + miss.heldBackRight.seconds + miss.heldBackWrong.seconds)}: no answer ${duration(miss.silent.seconds)}, held back but right ${duration(miss.heldBackRight.seconds)}, held back and wrong ${duration(miss.heldBackWrong.seconds)}`);
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
        "matches a reviewer later changed or removed). unchk: model names on speakers nobody identified. combined: the two methods",
        "reconciled as opencouncil does it, with nobody named where they disagree. cost: list-price estimate of the run that produced",
        "the model's answers.",
    ].join("\n");
}

/** The columns the evidence table and the threshold table share. */
const policyCells = (s: BacktestSummary) => {
    const m = s.model;
    return `${pad(share(m.peopleNamed, s.rosterPeople), 8)}${pad(share(m.secondsNamed, s.rosterSeconds), 7)}` +
        `${pad(String(m.correctNames + m.wrongNames), 7)}${pad(String(m.wrongNames), 8)}${pad(share(m.wrongSeconds, m.secondsNamed + m.wrongSeconds), 12)}` +
        `${pad(String(m.unverifiedNames), 11)}`;
};
const POLICY_HEADER = `${pad("people", 8)}${pad("time", 7)}${pad("names", 7)}${pad("wrong", 8)}${pad("wrong time", 12)}${pad("unchecked", 11)}`;

export function formatEvidenceTable(rows: EvidenceRow[], actedOn: ReadonlySet<string>): string {
    const lines = [`${pad("evidence", 18)}${pad("acted on", 10)}${POLICY_HEADER}`];
    for (const { label, summary } of rows) {
        const acted = label === "acted on" ? "" : actedOn.has(label) ? "yes" : "no";
        if (label === "acted on") lines.push("-".repeat(81));
        lines.push(`${pad(label, 18)}${pad(acted, 10)}${policyCells(summary)}`);
    }
    lines.push("");
    lines.push("One row per kind of evidence: the model's names that rest on that kind and are not contested, scored alone. For a kind");
    lines.push(`the pass acts on, the names at a confidence of ${MIN_ACTIONABLE_CONFIDENCE} or more; ${LOW_CONFIDENCE_ROW}: the names on those kinds that the floor holds back.`);
    lines.push("names: speaker tags named, right or wrong; wrong, wrong time: how many the record contradicts, and their share of");
    lines.push("the speaking time named. A kind the pass acts on must keep that share low. acted on: the kinds together, as shipped.");
    return lines.join("\n");
}

export function formatThresholdSweep(rows: { threshold: number; summary: BacktestSummary }[], chosen: number | null = null): string {
    const header = `${pad("threshold", 12)}${pad("people", 8)}${pad("time", 7)}${pad("wrong", 8)}${pad("wrong time", 12)}${pad("unchecked", 11)}${pad("missed, right", 15)}${pad("combined time", 15)}combined wrong`;
    const lines = [header];
    for (const { threshold, summary: s } of rows) {
        const m = s.model;
        lines.push(
            `${pad(`${threshold}${threshold === chosen ? " ←" : ""}`, 12)}` +
            `${pad(share(m.peopleNamed, s.rosterPeople), 8)}${pad(share(m.secondsNamed, s.rosterSeconds), 7)}` +
            `${pad(String(m.wrongNames), 8)}${pad(share(m.wrongSeconds, m.secondsNamed + m.wrongSeconds), 12)}` +
            `${pad(String(m.unverifiedNames), 11)}${pad(duration(m.missed.heldBackRight.seconds), 15)}` +
            `${pad(share(s.combined.secondsNamed, s.rosterSeconds), 15)}${s.combined.wrongNames}`
        );
    }
    lines.push("");
    lines.push("What a bare confidence threshold would do with the same answers, whatever their evidence. The pass acts on the kind of");
    lines.push(`evidence, with a floor of ${MIN_ACTIONABLE_CONFIDENCE} on the confidence; this is for comparing. people, time: share of roster people and speaking time the model named`);
    lines.push("correctly. wrong: wrong model names; wrong time: their share of the speaking time the model named. missed, right: roster");
    lines.push("speech the model answered correctly but below the threshold. combined: the two methods reconciled as opencouncil does it,");
    lines.push("with nobody named where they disagree.");
    return lines.join("\n");
}
