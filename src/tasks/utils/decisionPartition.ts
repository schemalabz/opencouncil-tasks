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

// A municipal-community reference: «ΔΗΜΟΤΙΚΗ ΚΟΙΝΟΤΗΤΑ» in any inflection, or
// the «Δ.Κ.» abbreviation Athens uses in agendas.
const COMMUNITY = /ΚΟΙΝΟΤΗΤ|(?:^|\s)Δ\.\s?Κ\.?(?=[\s,.;·]|$)/;

// The community's ordinal, bound to the community word so a session number
// («10η ΣΥΝΕΔΡΙΑΣΗ») two lines up can never be mistaken for it. Athens writes
// «1ης ΔΗΜΟΤΙΚΗΣ ΚΟΙΝΟΤΗΤΑΣ», «4ΗΣ ΔΗΜΟΤΙΚΗΣ ΚΟΙΝΟΤΗΤΑΣ», «5ης ΚΟΙΝΟΤΗΤΑΣ»
// (ΔΗΜΟΤΙΚΗΣ dropped) and «1ΗΣ Δ.Κ.»; our body names write «1η Δημοτική
// Κοινότητα» with the ordinal in front.
const COMMUNITY_ORDINAL = /(\d+)\s*(?:ΗΣ|Η)?\s+(?:ΔΗΜΟΤΙΚΗΣ?\s+)?(?:ΚΟΙΝΟΤΗΤ|Δ\.\s?Κ)/;

function communityOrdinal(normalized: string): number | null {
    const m = normalized.match(COMMUNITY_ORDINAL);
    return m ? Number(m[1]) : null;
}

// Greek nominal endings, so «ΔΗΜΟΤΙΚΗΣ ΚΟΙΝΟΤΗΤΑΣ» (genitive) and «Δημοτική
// Κοινότητα» (nominative) compare equal token by token. Digits and short
// tokens are left alone.
function stemToken(t: string): string {
    if (t.length <= 3 || /\d/.test(t)) return t;
    return t.replace(/(ΟΥΣ|ΕΙΣ|ΕΣ|ΗΣ|ΑΣ|ΩΝ|ΟΥ|ΟΣ|ΟΝ|Ο|Α|Η|Υ|Σ)$/, '');
}

function stemmedBodyLabel(s: string): string {
    return normalizeBodyLabel(s).split(' ').map(stemToken).join(' ');
}

/**
 * THE body comparison: does the body a document names match the meeting's
 * administrative body? Accent- and case-insensitive, inflection-insensitive,
 * and tolerant of the document carrying the municipality name («ΔΗΜΟΤΙΚΟ
 * ΣΥΜΒΟΥΛΙΟ ΔΗΜΟΥ ΧΑΝΙΩΝ» matches «Δημοτικό Συμβούλιο»). Bodies sharing a
 * Diavgeia unit (sparta, the athens communities) or having none (samothraki)
 * make the document the only source of body identity — adjudication measured
 * 3 cross-body swaps in 24 samothraki links.
 *
 * Municipal communities are compared structurally: a community never matches
 * a non-community (a community's council document says «ΣΥΜΒΟΥΛΙΟ 1ης
 * ΔΗΜΟΤΙΚΗΣ ΚΟΙΝΟΤΗΤΑΣ», which must not be read as the city council), and two
 * numbered communities match only on the same ordinal. Unnumbered communities
 * (sparta's «ΔΗΜΟΤΙΚΗ ΚΟΙΝΟΤΗΤΑ ΣΠΑΡΤΙΑΤΩΝ») fall through to the
 * inflection-insensitive name comparison.
 */
export function sameBody(documentBody: string, meetingBody: string): boolean {
    const a = normalizeBodyLabel(documentBody);
    const b = normalizeBodyLabel(meetingBody);

    const aCommunity = COMMUNITY.test(a);
    const bCommunity = COMMUNITY.test(b);
    if (aCommunity !== bCommunity) return false;
    if (aCommunity && bCommunity) {
        const aOrd = communityOrdinal(a);
        const bOrd = communityOrdinal(b);
        if (aOrd !== null || bOrd !== null) return aOrd === bOrd;
        // both unnumbered -> the name decides, below
    }

    const sa = stemmedBodyLabel(documentBody);
    const sb = stemmedBodyLabel(meetingBody);
    // A blank side matches nothing: '' is a substring of everything, and the
    // callers' truthiness guards do not catch whitespace-only strings.
    if (!sa || !sb) return false;
    return sa.includes(sb) || sb.includes(sa);
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
