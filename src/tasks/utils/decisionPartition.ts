import type { Decision } from '@schemalabs/diavgeia-cli';
import type { DecisionReading } from './readDecisionDocument.js';

/**
 * Partitioning of window candidates by the session their document declares
 * (issue #617 phase 3). A decision that names this meeting's session — same
 * body, same date — is a fact, not a guess; one that names another session
 * cannot contend here; one that could not be read falls back to the legacy
 * similarity pool; one that is not a session decision at all is excluded from
 * every pool.
 */

export interface ReadDecision {
    decision: Decision;
    reading: DecisionReading | null;
    /** ok | no_meeting_date | unreadable | unread | not_a_decision */
    readStatus: string;
    /** true when the reading came from knownDecisions rather than a fresh read */
    fromKnown: boolean;
}

/**
 * THE session-date comparison. Exact equality for now. Adjudication (2026-08-14)
 * found every off-by-one was label-side (UTC-vs-local derivation), so exact
 * equality stands — change it HERE and nowhere else if that ever shifts.
 */
export function sameSessionDate(declaredIsoDate: string, meetingIsoDate: string): boolean {
    return declaredIsoDate === meetingIsoDate;
}

function normalizeBodyLabel(s: string): string {
    return s
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toUpperCase()
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * THE body comparison: does the body a document names match the meeting's
 * administrative body? Accent- and case-insensitive, tolerant of the document
 * carrying the municipality name ("ΔΗΜΟΤΙΚΟ ΣΥΜΒΟΥΛΙΟ ΔΗΜΟΥ ΧΑΝΙΩΝ" matches
 * "Δημοτικό Συμβούλιο"). Bodies sharing a Diavgeia unit (sparta) or having
 * none (samothraki) make the document the only source of body identity —
 * adjudication measured 3 cross-body swaps in 24 samothraki links.
 */
export function sameBody(documentBody: string, meetingBody: string): boolean {
    const a = normalizeBodyLabel(documentBody);
    const b = normalizeBodyLabel(meetingBody);
    return a.includes(b) || b.includes(a);
}

export function partitionReadDecisions(
    reads: ReadDecision[],
    meetingDate: string,
    meetingBodyName?: string | null,
): { inMeeting: ReadDecision[]; elsewhere: ReadDecision[]; fallback: ReadDecision[]; nonDecisions: ReadDecision[] } {
    const inMeeting: ReadDecision[] = [];
    const elsewhere: ReadDecision[] = [];
    const fallback: ReadDecision[] = [];
    const nonDecisions: ReadDecision[] = [];
    for (const r of reads) {
        if (r.readStatus === 'not_a_decision') {
            nonDecisions.push(r);
            continue;
        }
        const declared = r.reading?.meetingDate ?? null;
        if (!declared) {
            fallback.push(r);
            continue;
        }
        const dateMatches = sameSessionDate(declared, meetingDate);
        const documentBody = r.reading?.body ?? null;
        // Body mismatch overrides a date match: two bodies of one municipality
        // can meet on the same day (and share Diavgeia units).
        const bodyMatches = documentBody && meetingBodyName
            ? sameBody(documentBody, meetingBodyName)
            : true; // unknown on either side -> date decides, as before
        (dateMatches && bodyMatches ? inMeeting : elsewhere).push(r);
    }
    return { inMeeting, elsewhere, fallback, nonDecisions };
}
