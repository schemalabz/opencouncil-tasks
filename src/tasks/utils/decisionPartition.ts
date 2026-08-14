import type { Decision } from '@schemalabs/diavgeia-cli';
import type { DecisionReading } from './readDecisionDocument.js';

/**
 * Partitioning of window candidates by the session their document declares
 * (issue #617 phase 3). A decision that names this meeting's date is a fact,
 * not a guess; one that names another meeting cannot contend here; one that
 * could not be read falls back to the legacy similarity pool.
 */

export interface ReadDecision {
    decision: Decision;
    reading: DecisionReading | null;
    /** ok | no_meeting_date | unreadable | unread */
    readStatus: string;
    /** true when the reading came from knownDecisions rather than a fresh read */
    fromKnown: boolean;
}

/**
 * THE session-date comparison. Exact equality for now. The off-by-one-day
 * adjudication findings (scheduled vs actual session dates in meeting records)
 * may turn this into a ±1-day policy — change it HERE and nowhere else.
 */
export function sameSessionDate(declaredIsoDate: string, meetingIsoDate: string): boolean {
    return declaredIsoDate === meetingIsoDate;
}

export function partitionReadDecisions(
    reads: ReadDecision[],
    meetingDate: string,
): { inMeeting: ReadDecision[]; elsewhere: ReadDecision[]; fallback: ReadDecision[] } {
    const inMeeting: ReadDecision[] = [];
    const elsewhere: ReadDecision[] = [];
    const fallback: ReadDecision[] = [];
    for (const r of reads) {
        const declared = r.reading?.meetingDate ?? null;
        if (declared) {
            (sameSessionDate(declared, meetingDate) ? inMeeting : elsewhere).push(r);
        } else {
            fallback.push(r);
        }
    }
    return { inMeeting, elsewhere, fallback };
}
