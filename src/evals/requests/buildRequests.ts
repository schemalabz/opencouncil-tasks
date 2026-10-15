import type { CityLanguage, CountryCode, FixTranscriptRequest, Location, PollDecisionsRequest, ProcessAgendaRequest, RequestOnTranscript, SummarizeRequest, TopicLabelInfo } from '../../types.js';
import { describePerson, maySpeakAtMeeting, type MeetingApiRole } from '../suites/speakerBacktest.js';

/**
 * Task requests built from opencouncil's public data the way the app builds
 * them, so an eval runs on what production would send. Each builder names the
 * app function it follows; change the two together.
 *
 * Inputs: GET /api/cities/:cityId/meetings/:meetingId (the meeting page's data:
 * meeting, unjoined transcript, city, every person of the city, subjects) and
 * GET /api/topics (the realm's topics, by host).
 *
 * What the public data cannot give, and what is sent instead:
 * - pollDecisions `window`: the app widens it from the city's publication-lag
 *   history; the app's default of 30 days is used.
 * - pollDecisions `knownDecisions` (stored candidates): omitted, so every
 *   candidate in the window is read afresh.
 * - pollDecisions `existingDecision.needsExtraction`: the app reads the stored
 *   extraction; it is sent as true, as a forced run sends it.
 * - The transcript's people are looked up among the city's people; the app
 *   looks them up anywhere in its database.
 * - `partiesWithPeople` (deprecated, read only without `people`) is not sent.
 */

export type PublicRole = MeetingApiRole & { administrativeBody?: { name: string; name_en?: string | null; type?: string } | null };
export type PublicPerson = { id: string; name: string; roles: PublicRole[] };

export type PublicSubject = {
    id: string;
    name: string;
    description: string;
    agendaItemIndex: number | null;
    agendaItemTitle?: string | null;
    agendaSectionIndex?: number | null;
    nonAgendaReason: 'beforeAgenda' | 'outOfAgenda' | null;
    withdrawn: boolean;
    discussedInId?: string | null;
    context: string | null;
    contextCitationUrls: string[];
    topicImportance: string | null;
    proximityImportance: string | null;
    introducedBy: { id: string } | null;
    topic: { name: string } | null;
    location: { type: string; text: string; coordinates?: { x: number; y: number } | null } | null;
    contributions: { speakerId: string | null; speakerName: string | null; text: string; speaker?: { name: string } | null }[];
    decision: { ada: string | null; title: string | null; pdfUrl: string } | null;
};

export type PublicSegment = {
    id: string;
    startTimestamp: number;
    endTimestamp: number;
    speakerTagId: string;
    speakerTag: { id: string; label: string | null; personId: string | null };
    utterances: { id: string; text: string; startTimestamp: number; endTimestamp: number; discussionSubjectId?: string | null }[];
};

export type PublicMeetingPayload = {
    meeting: {
        id: string;
        cityId: string;
        dateTime: string;
        agendaUrl: string | null;
        administrativeBodyId: string | null;
        administrativeBody: { id: string; name: string; type: string; diavgeiaUnitIds: string[]; decisionConventions?: unknown } | null;
    };
    city: { name: string; language: CityLanguage; realm: string; timezone: string; diavgeiaUid: string | null };
    people: PublicPerson[];
    subjects: PublicSubject[];
    transcript: PublicSegment[];
    transcriptHiddenForReview?: boolean;
};

export type PublicTopic = { name: string; description: string };

/** opencouncil's English admin messages; only their `conventions` namespace is read. */
export type ConventionsGlossary = { conventions: Record<string, unknown> };

// The app sends `country` on every transcript request, and a null body name for a meeting with no body.
type OnTranscriptWire = { country: CountryCode; administrativeBodyName: string | null };
type TranscriptRequestBody = Omit<RequestOnTranscript, 'callbackUrl' | 'administrativeBodyName'> & OnTranscriptWire;
export type FixTranscriptRequestBody = Omit<FixTranscriptRequest, 'callbackUrl' | 'administrativeBodyName'> & OnTranscriptWire;
// The app sends no `discussedIn` on an existing subject.
type ExistingSubject = Omit<SummarizeRequest['existingSubjects'][number], 'discussedIn'>;
export type SummarizeRequestBody = Omit<SummarizeRequest, 'callbackUrl' | 'existingSubjects' | 'administrativeBodyName'> & OnTranscriptWire & { existingSubjects: ExistingSubject[] };
export type ProcessAgendaRequestBody = Omit<ProcessAgendaRequest, 'callbackUrl'>;
export type PollDecisionsRequestBody = Omit<PollDecisionsRequest, 'callbackUrl'>;

// opencouncil's REALMS
const REALM_COUNTRY: Record<string, CountryCode> = { greece: 'GR', france: 'FR', cyprus: 'CY', serbia: 'RS' };
// opencouncil's DEFAULT_WINDOW_DAYS
const DEFAULT_WINDOW_DAYS = 30;

function realmCountry(realm: string): CountryCode {
    const country = REALM_COUNTRY[realm];
    if (!country) throw new Error(`Unknown realm "${realm}"`);
    return country;
}

// The app's isRoleActiveAt: the end date is exclusive. The backtest's copy differs on that day only.
function activeAt(role: { startDate: string | null; endDate: string | null }, at: Date): boolean {
    if (role.startDate && new Date(role.startDate) > at) return false;
    if (role.endDate && new Date(role.endDate) <= at) return false;
    return true;
}

const isMayorRole = (r: PublicRole) => !!r.cityId && !r.partyId && !r.administrativeBodyId && r.isHead;

/** getPartyFromRoles: the party of the first role active on the date (today when none is given). */
function partyAt(roles: PublicRole[], at: Date = new Date()): { name: string } | null {
    return roles.find(r => activeAt(r, at) && r.party)?.party ?? null;
}

/** getRoleNameForPerson, including its reading of a body id as "a role in this body" first. */
function roleNameFor(roles: PublicRole[], at: Date, bodyId: string | null): string {
    const nonParty = roles.filter(r => !r.partyId && activeAt(r, at));
    const first = bodyId
        ? nonParty.find(r => r.administrativeBodyId === bodyId)
        : nonParty.find(r => !r.administrativeBodyId);
    if (first?.name || first?.name_en) return first.name || first.name_en || '';
    const fallback = nonParty.find(r => !bodyId || r.administrativeBodyId === bodyId);
    if (!fallback) return '';
    return fallback.name || fallback.name_en || fallback.administrativeBody?.name || fallback.administrativeBody?.name_en || '';
}

/** getRoleTypePriority: lower first. */
function rolePriority(r: PublicRole): number {
    if (isMayorRole(r)) return 0;
    if (r.cityId && !r.partyId && !r.administrativeBodyId) return 1;
    if (r.administrativeBodyId && r.isHead) return 2;
    if (r.partyId && r.isHead) return 3;
    if (r.partyId) return 4;
    if (r.administrativeBodyId) return 5;
    return 6;
}

const byName = (a: PublicPerson, b: PublicPerson) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/** getPeopleWhoMaySpeak: who the transcript tasks are told about. */
function peopleWhoMaySpeak(data: PublicMeetingPayload, meetingDate: Date): PublicPerson[] {
    const bodyId = data.meeting.administrativeBodyId;
    return bodyId ? data.people.filter(p => maySpeakAtMeeting(p, bodyId, meetingDate)) : data.people;
}

/**
 * getPeopleForMeeting: who the document tasks (agenda, decisions) are told about.
 * The app reads city-level roles on today's date here, not the meeting's. It
 * returns people in random order; they are sorted by name for stable requests.
 */
function peopleForMeeting(data: PublicMeetingPayload): PublicPerson[] {
    const body = data.meeting.administrativeBody;
    const people = [...data.people].sort(byName);
    if (!body) return people;
    if (body.type === 'council') {
        const best = (p: PublicPerson) => Math.min(...p.roles.map(rolePriority));
        return people.filter(p => maySpeakAtMeeting(p, body.id, new Date())).sort((a, b) => best(a) - best(b));
    }
    if (body.type === 'committee' || body.type === 'community') {
        return people.filter(p => p.roles.some(r => r.administrativeBodyId === body.id));
    }
    return people;
}

/**
 * getTranscript with joinAdjacentSameSpeakerSegments (joinTranscriptSegments):
 * adjacent segments of one person become one; with sameSpeakerTagOnly they must
 * also share the tag.
 */
function joinSegments(segments: PublicSegment[], sameSpeakerTagOnly: boolean): PublicSegment[] {
    const ordered = [...segments].sort((a, b) => a.startTimestamp - b.startTimestamp || a.id.localeCompare(b.id));
    const joined: PublicSegment[] = [];
    for (const next of ordered) {
        const current = joined[joined.length - 1];
        const personId = next.speakerTag.personId;
        if (current && personId && current.speakerTag.personId === personId
            && (!sameSpeakerTagOnly || current.speakerTagId === next.speakerTagId)
            && next.startTimestamp >= current.startTimestamp) {
            joined[joined.length - 1] = {
                ...current,
                endTimestamp: Math.max(current.endTimestamp, next.endTimestamp),
                utterances: [...current.utterances, ...next.utterances],
            };
        } else {
            joined.push(next);
        }
    }
    return joined;
}

/** getRequestOnTranscriptRequestBody */
function requestOnTranscript(data: PublicMeetingPayload, topics: PublicTopic[], keepSpeakerTagsApart: boolean): TranscriptRequestBody {
    if (data.transcriptHiddenForReview) throw new Error('The transcript is hidden for review; the public endpoint returns it empty');
    if (data.transcript.length === 0) throw new Error('The meeting has no transcript');
    const meetingDate = new Date(data.meeting.dateTime);
    const bodyId = data.meeting.administrativeBodyId;
    const peopleById = new Map(data.people.map(p => [p.id, p]));
    const byStart = (a: { startTimestamp: number; id: string }, b: { startTimestamp: number; id: string }) => a.startTimestamp - b.startTimestamp || a.id.localeCompare(b.id);

    return {
        transcript: joinSegments(data.transcript, keepSpeakerTagsApart).map(segment => {
            const person = segment.speakerTag.personId ? peopleById.get(segment.speakerTag.personId) : undefined;
            const utterances = [...segment.utterances].sort(byStart);
            return {
                speakerName: person?.name || segment.speakerTag.label,
                // The app reads the speaker's party on today's date, not the meeting's.
                speakerParty: person ? partyAt(person.roles)?.name || null : null,
                speakerRole: person ? roleNameFor(person.roles, meetingDate, bodyId) || null : null,
                speakerSegmentId: segment.id,
                speakerTagId: segment.speakerTagId,
                speakerId: person?.id || null,
                text: utterances.map(u => u.text).join(' '),
                utterances: utterances.map(u => ({ text: u.text, utteranceId: u.id, startTimestamp: u.startTimestamp, endTimestamp: u.endTimestamp })),
            };
        }),
        topicLabels: topics.map((t): TopicLabelInfo => ({ name: t.name, description: t.description })),
        cityName: data.city.name,
        cityLanguage: data.city.language,
        country: realmCountry(data.city.realm),
        administrativeBodyName: data.meeting.administrativeBody?.name || null,
        people: peopleWhoMaySpeak(data, meetingDate).map(p => describePerson(p, meetingDate, bodyId)).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
        date: meetingDate.toISOString().split('T')[0],
    };
}

/** getFixTranscriptRequestBody: one segment per diarization speaker run, never two tags joined. The app sends no agendaItems. */
export function buildFixTranscriptRequest(data: PublicMeetingPayload, topics: PublicTopic[]): FixTranscriptRequestBody {
    return requestOnTranscript(data, topics, true);
}

function agendaItemIndexOf(s: PublicSubject): ExistingSubject['agendaItemIndex'] | null {
    if (s.agendaItemIndex) return s.agendaItemIndex;
    if (!s.nonAgendaReason) return null;
    return s.nonAgendaReason === 'beforeAgenda' ? 'BEFORE_AGENDA' : 'OUT_OF_AGENDA';
}

/** getSummarizeRequestBody, as requestSummarize sends it by default: no requested subjects, no instructions, not forced. */
export function buildSummarizeRequest(data: PublicMeetingPayload, topics: PublicTopic[]): SummarizeRequestBody {
    return {
        ...requestOnTranscript(data, topics, false),
        requestedSubjects: [],
        existingSubjects: data.subjects
            .filter(s => s.agendaItemIndex || s.nonAgendaReason)
            .map(s => ({
                id: s.id,
                name: s.name,
                description: s.description,
                introducedByPersonId: s.introducedBy?.id || null,
                topicLabel: s.topic?.name || null,
                location: s.location && s.location.coordinates ? {
                    type: s.location.type as Location['type'],
                    text: s.location.text,
                    coordinates: [[s.location.coordinates.x, s.location.coordinates.y]],
                } : null,
                agendaItemIndex: agendaItemIndexOf(s)!,
                context: s.context ? { text: s.context, citationUrls: s.contextCitationUrls } : null,
                speakerContributions: s.contributions.map(c => ({
                    speakerId: c.speakerId,
                    speakerName: c.speakerName ?? c.speaker?.name ?? null,
                    text: c.text,
                })),
                topicImportance: (s.topicImportance || 'normal') as ExistingSubject['topicImportance'],
                proximityImportance: (s.proximityImportance || 'none') as ExistingSubject['proximityImportance'],
            })),
    };
}

/** requestProcessAgendaInternal */
export function buildProcessAgendaRequest(data: PublicMeetingPayload, topics: PublicTopic[]): ProcessAgendaRequestBody {
    if (!data.meeting.agendaUrl) throw new Error('The meeting has no agendaUrl');
    const meetingDate = new Date(data.meeting.dateTime);
    const bodyId = data.meeting.administrativeBodyId;
    // Deduplicated by id, the last entry kept, as the app's map does.
    const people = new Map(peopleForMeeting(data).map(p => [p.id, {
        id: p.id,
        name: p.name,
        role: roleNameFor(p.roles, meetingDate, bodyId),
        party: partyAt(p.roles, meetingDate)?.name || '',
    }]));
    return {
        agendaUrl: data.meeting.agendaUrl,
        date: meetingDate.toISOString(),
        people: [...people.values()],
        topicLabels: topics.map(t => ({ name: t.name, description: t.description })),
        cityName: data.city.name,
        cityLanguage: data.city.language,
        country: realmCountry(data.city.realm),
    };
}

type AgendaPositioned = { agendaItemIndex: number | null; agendaSectionIndex?: number | null };

/** compareAgendaPosition */
function compareAgendaPosition(a: AgendaPositioned, b: AgendaPositioned): number {
    const numbered = (s: AgendaPositioned) => (s.agendaItemIndex != null ? 0 : 1);
    if (numbered(a) !== numbered(b)) return numbered(a) - numbered(b);
    const section = (s: AgendaPositioned) => s.agendaSectionIndex ?? 0;
    if (section(a) !== section(b)) return section(a) - section(b);
    const index = (s: AgendaPositioned) => s.agendaItemIndex ?? Infinity;
    return index(a) === index(b) ? 0 : index(a) - index(b);
}

/**
 * sortSubjectsByDiscussionOrder: by first linked utterance, a jointly discussed
 * subject at its parent's time and after it; the rest interleaved by agenda position.
 */
function sortByDiscussionOrder(subjects: PublicSubject[], firstUtterance: Map<string, number>): PublicSubject[] {
    const timeOf = (s: PublicSubject) => firstUtterance.get(s.discussedInId ?? s.id);
    const isOOA = (s: PublicSubject) => s.nonAgendaReason === 'outOfAgenda';
    const result = subjects.filter(s => timeOf(s) !== undefined).sort((a, b) => {
        const delta = timeOf(a)! - timeOf(b)!;
        if (delta !== 0) return delta;
        if (!!a.discussedInId !== !!b.discussedInId) return a.discussedInId ? 1 : -1;
        return compareAgendaPosition(a, b);
    });
    const untimed = subjects.filter(s => timeOf(s) === undefined)
        .sort((a, b) => (isOOA(a) !== isOOA(b) ? (isOOA(a) ? 1 : -1) : compareAgendaPosition(a, b)));
    for (const s of untimed) {
        let insertAt = 0;
        for (let i = result.length - 1; i >= 0; i--) {
            const existing = result[i];
            if (isOOA(s) === isOOA(existing) && compareAgendaPosition(existing, s) <= 0) {
                insertAt = Math.max(insertAt, i + 1);
                break;
            }
            if (!isOOA(s) && isOOA(existing)) {
                insertAt = Math.max(insertAt, i + 1);
                continue;
            }
            if (isOOA(s) && !isOOA(existing)) {
                insertAt = i + 1;
                break;
            }
        }
        result.splice(insertAt, 0, s);
    }
    return result;
}

// opencouncil's decision-convention vocabularies
const ROLL_CALL_LAYOUTS = ['composition_and_absent', 'present_and_absent', 'present_only', 'mixed'];
const PRESENT_LIST_MEANINGS = ['opening', 'cumulative', 'per_decision', 'unknown'];
const ANCHORS = ['agenda_item', 'decision_number', 'phase', 'subject'];
const NAMED_VOTERS = ['none', 'dissenters_only', 'all', 'all_when_split'];
const CONVENTION_FLAGS = ['statesPerDecisionAttendance', 'statesPerVoteAbsence', 'usesSubstitutes', 'mayorStatedSeparately', 'listOmitsSecretary'] as const;
const LEGACY_ANCHOR: Record<string, string | null> = { session_phase: 'phase', this_document: 'subject', clock_time: null };

type Conventions = {
    rollCallLayout: string;
    presentListMeaning: string;
    attendanceChangeAnchors: string[];
    namedVoters: string;
    notes?: string;
} & Partial<Record<typeof CONVENTION_FLAGS[number], boolean>>;

function normalizeAnchors(anchors: string[]): string[] {
    const out = new Set<string>();
    for (const a of anchors) {
        const v = a in LEGACY_ANCHOR ? LEGACY_ANCHOR[a] : a;
        if (v && ANCHORS.includes(v)) out.add(v);
    }
    return [...out];
}

/** The fields isDecisionConventions requires; a record missing one is no record, as in the app. */
function asConventions(v: unknown): Conventions | null {
    if (!v || typeof v !== 'object') return null;
    const c = v as Record<string, unknown>;
    const requiredFlags = CONVENTION_FLAGS.filter(f => f !== 'listOmitsSecretary');
    const ok = c.version === 1
        && ROLL_CALL_LAYOUTS.includes(c.rollCallLayout as string)
        && PRESENT_LIST_MEANINGS.includes(c.presentListMeaning as string)
        && Array.isArray(c.attendanceChangeAnchors) && c.attendanceChangeAnchors.every(a => typeof a === 'string')
        && NAMED_VOTERS.includes(c.namedVoters as string)
        && requiredFlags.every(f => typeof c[f] === 'boolean')
        && typeof c.provenance === 'object' && c.provenance !== null;
    return ok ? (c as unknown as Conventions) : null;
}

/** renderConventionsText with the app's English glossary; a key with no entry drops its line. */
export function renderConventionsText(conventions: unknown, glossary: ConventionsGlossary): string | null {
    const c = asConventions(conventions);
    if (!c) return null;
    const t = (key: string): string => {
        const value = key.split('.').reduce<unknown>((node, step) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[step] : undefined), glossary.conventions);
        return typeof value === 'string' ? value : '';
    };
    const anchors = normalizeAnchors(c.attendanceChangeAnchors);
    return [
        t(`rollCallLayout.${c.rollCallLayout}.hint`),
        c.presentListMeaning === 'unknown' ? '' : t(`presentListMeaning.${c.presentListMeaning}.hint`),
        anchors.length
            ? `${t('anchors.some')} ${anchors.map(a => t(`attendanceChangeAnchors.${a}.label`)).join(', ')}.`
            : t('anchors.none'),
        ...CONVENTION_FLAGS.filter(f => c[f]).map(f => t(`${f}.hint`)),
        c.namedVoters === 'none' ? '' : t(`namedVoters.${c.namedVoters}.hint`),
        c.notes ? `Notes from the survey: ${c.notes}` : '',
    ].filter(Boolean).join('\n');
}

/** As opencouncil's requestPollDecisions builds it; see the gaps at the top. */
export function buildPollDecisionsRequest(data: PublicMeetingPayload, glossary: ConventionsGlossary): PollDecisionsRequestBody {
    if (!data.city.diavgeiaUid) throw new Error('The city has no Diavgeia UID');
    const body = data.meeting.administrativeBody;
    const meetingDate = new Date(data.meeting.dateTime);
    // DECISION_ELIGIBLE_SUBJECT_WHERE
    const eligible = data.subjects.filter(s => !s.withdrawn
        && ((s.agendaItemIndex != null && s.nonAgendaReason === null) || s.nonAgendaReason === 'outOfAgenda'));
    if (eligible.length === 0) throw new Error('No decision-eligible subjects (agenda or out-of-agenda, not withdrawn)');

    const people = peopleForMeeting(data);
    const mayor = people.find(p => p.roles.some(r => isMayorRole(r) && activeAt(r, meetingDate)));

    const firstUtterance = new Map<string, number>();
    for (const segment of data.transcript) {
        for (const u of segment.utterances) {
            if (!u.discussionSubjectId) continue;
            const seen = firstUtterance.get(u.discussionSubjectId);
            if (seen === undefined || u.startTimestamp < seen) firstUtterance.set(u.discussionSubjectId, u.startTimestamp);
        }
    }

    const localDate = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: data.city.timezone });
    const conventionsText = renderConventionsText(body?.decisionConventions, glossary);

    return {
        meetingDate: localDate(meetingDate),
        diavgeiaUid: data.city.diavgeiaUid,
        diavgeiaUnitIds: body?.diavgeiaUnitIds.length ? body.diavgeiaUnitIds : undefined,
        administrativeBodyName: body?.name ?? null,
        conventionsText: conventionsText ?? undefined,
        extract: conventionsText !== null,
        mayorId: mayor?.id,
        people: people.map(p => ({ id: p.id, name: p.name })),
        window: { fromDate: localDate(meetingDate), toDate: localDate(new Date(meetingDate.getTime() + DEFAULT_WINDOW_DAYS * 86_400_000)) },
        subjects: sortByDiscussionOrder(eligible, firstUtterance).map(s => ({
            subjectId: s.id,
            name: s.agendaItemTitle?.trim() ? s.agendaItemTitle : s.name,
            agendaItemIndex: s.agendaItemIndex,
            nonAgendaReason: s.nonAgendaReason,
            ...(s.decision ? {
                existingDecision: {
                    ...(s.decision.ada ? { ada: s.decision.ada } : {}),
                    decisionTitle: s.decision.title ?? '',
                    pdfUrl: s.decision.pdfUrl,
                    needsExtraction: true,
                },
            } : {}),
        })),
    };
}
