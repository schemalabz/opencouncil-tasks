import { AttendanceChange, AgendaItemRef, RawExtractedDecision } from './decisionPdfExtraction.js';
import { computeEffectiveAttendance } from './effectiveAttendance.js';

/**
 * Resolve and deduplicate attendance changes from multiple PDF extractions.
 *
 * Every decision PDF from a meeting contains the same attendance preamble,
 * but the LLM may extract it with slight differences:
 * - Name variants: abbreviated ("Κ. Αγγελής") vs full ("ΚΩΝΣΤΑΝΤΙΝΟΣ ΑΓΓΕΛΗΣ")
 * - Timing disagreements: "during" vs "after" vs null for the same event
 * - Different rawText formatting
 *
 * This function:
 * 1. Resolves names to canonical initial-list forms using nameToPersonId
 * 2. Groups identical changes (same person + type + agendaItem)
 * 3. Picks timing by majority vote — the most common timing across PDFs wins
 *
 * @param extractions - Raw extractions from all PDFs
 * @param nameToPersonId - Name → personId mapping from the matching phase
 * @param initialNames - All names from the initial roll call (present + absent)
 */
export interface AttendanceChangeWithAgreement extends AttendanceChange {
    /** How many PDFs reported this change */
    reportingPdfCount: number;
    /** Total PDFs that were extracted */
    totalPdfCount: number;
}

export function resolveAndDeduplicateAttendanceChanges(
    extractions: Array<{ raw: Pick<RawExtractedDecision, 'attendanceChanges'> }>,
    nameToPersonId: Map<string, string>,
    initialNames: string[],
): AttendanceChangeWithAgreement[] {
    const totalPdfCount = extractions.length;

    // Build personId → canonical initial-list name mapping
    const personIdToInitialName = new Map<string, string>();
    for (const name of initialNames) {
        const id = nameToPersonId.get(name);
        if (id && !personIdToInitialName.has(id)) {
            personIdToInitialName.set(id, name);
        }
    }

    // Group changes by resolved identity (person + type + agendaItem),
    // collecting timing votes from each PDF
    const groups = new Map<string, {
        change: AttendanceChange;
        timingVotes: Map<string, number>; // timing value → count
        reportingPdfCount: number; // how many PDFs reported this change at all
    }>();

    for (const { raw } of extractions) {
        for (const change of raw.attendanceChanges || []) {
            // Resolve name to canonical initial-list form
            const personId = nameToPersonId.get(change.name);
            const canonicalName = personId ? personIdToInitialName.get(personId) : null;
            const resolvedName = canonicalName ?? change.name;

            // Group key: resolved name + type + agendaItem (ignoring timing)
            const agendaKey = change.agendaItem
                ? `${change.agendaItem.agendaItemIndex}:${change.agendaItem.nonAgendaReason ?? ''}`
                : 'session';
            const key = `${resolvedName}|${change.type}|${agendaKey}`;

            const group = groups.get(key);
            const timingKey = change.timing ?? 'null';

            if (!group) {
                groups.set(key, {
                    change: { ...change, name: resolvedName },
                    timingVotes: new Map([[timingKey, 1]]),
                    reportingPdfCount: 1,
                });
            } else {
                group.timingVotes.set(timingKey, (group.timingVotes.get(timingKey) ?? 0) + 1);
                group.reportingPdfCount++;
            }
        }
    }

    // Build final list — only include changes with sufficient agreement.
    // A change reported by a single PDF when multiple were extracted is likely
    // a hallucination. Require >50% of PDFs to report the change.
    // Exception: when only 1-2 PDFs were extracted, require all to agree.
    const result: AttendanceChangeWithAgreement[] = [];
    for (const { change, timingVotes, reportingPdfCount } of groups.values()) {
        // Consensus check: change must be reported by majority of PDFs
        if (reportingPdfCount <= totalPdfCount / 2) {
            continue; // Not enough agreement — skip this change
        }

        // Pick timing with most votes; on tie, prefer specified over null
        let bestTiming: 'during' | 'after' | null = null;
        let bestCount = 0;
        for (const [timing, count] of timingVotes) {
            // Prefer 'during' over 'after' on a tie (conservative: person was absent).
            // Prefer any non-null timing over null on a tie.
            const betterThanCurrent =
                count > bestCount ||
                (count === bestCount && timing !== 'null' && (bestTiming == null || timing === 'during'));
            if (betterThanCurrent) {
                bestTiming = timing === 'null' ? null : timing as 'during' | 'after';
                bestCount = count;
            }
        }
        result.push({ ...change, timing: bestTiming, reportingPdfCount, totalPdfCount });
    }

    return result;
}

export interface MeetingAttendanceData {
    initialPresent: string[];
    initialAbsent: string[];
    attendanceChanges: AttendanceChange[];
    discussionOrder: AgendaItemRef[] | null;
    nameToPersonId: Map<string, string>;
}

export interface SubjectForAttendance {
    subjectId: string;
    agendaItemIndex: number | null;
    /** For out-of-agenda subjects: their sequential OA index (from PDF extraction subjectInfo) */
    outOfAgendaIndex?: number | null;
}

export interface SubjectAttendanceResult {
    subjectId: string;
    presentMemberIds: string[];
    absentMemberIds: string[];
}

/**
 * Build a complete discussion order by merging the partial explicit order
 * (from PDFs) with the full subject list (from the request).
 *
 * The PDF's discussionOrder only mentions items discussed out of their
 * natural sequence (e.g., [1, OA1, 9, OA2, OA3] when #9 was pulled ahead).
 * Remaining subjects follow in standard order: OA items first (sorted by
 * outOfAgendaIndex), then regular items (sorted by agendaItemIndex).
 *
 * Examples:
 * - No explicit order: [OA1, OA2, OA3, #1, #2, ..., #11]
 * - Explicit [1, OA1, 9, OA2, OA3]: [1, OA1, 9, OA2, OA3, #2, #3, ..., #8, #10, #11, #12]
 */
export function buildCompleteDiscussionOrder(
    explicitOrder: AgendaItemRef[] | null,
    subjects: SubjectForAttendance[],
): AgendaItemRef[] {
    // Collect all regular agenda items from subjects, sorted numerically
    const regularRefs: AgendaItemRef[] = subjects
        .filter(s => s.agendaItemIndex != null)
        .map(s => ({ agendaItemIndex: s.agendaItemIndex!, nonAgendaReason: null }))
        .sort((a, b) => a.agendaItemIndex - b.agendaItemIndex);

    // Collect all OA items from subjects, sorted by OA index
    const oaRefs: AgendaItemRef[] = subjects
        .filter(s => s.outOfAgendaIndex != null)
        .map(s => ({ agendaItemIndex: s.outOfAgendaIndex!, nonAgendaReason: 'outOfAgenda' as const }))
        .sort((a, b) => a.agendaItemIndex - b.agendaItemIndex);

    if (!explicitOrder || explicitOrder.length === 0) {
        // Standard order: OA items first, then regular items
        return [...oaRefs, ...regularRefs];
    }

    // Track which items are already in the explicit order
    const inExplicit = new Set(
        explicitOrder.map(r => `${r.agendaItemIndex}:${r.nonAgendaReason ?? ''}`)
    );

    // Append remaining items not in explicit order: OA first, then regular
    const remainingOA = oaRefs.filter(r => !inExplicit.has(`${r.agendaItemIndex}:outOfAgenda`));
    const remainingRegular = regularRefs.filter(r => !inExplicit.has(`${r.agendaItemIndex}:`));

    return [...explicitOrder, ...remainingOA, ...remainingRegular];
}

/**
 * Compute effective attendance for every subject in the meeting using
 * aggregated meeting-level data from all extracted PDFs.
 *
 * Builds a complete discussion order by merging the PDF's partial explicit
 * order with all regular subjects from the request, then computes effective
 * attendance for each subject using that unified sequence.
 *
 * Handles both regular subjects (agendaItemIndex set) and out-of-agenda
 * subjects (agendaItemIndex null, outOfAgendaIndex set from PDF extraction).
 * Subjects with neither are skipped.
 */
export function computeAllSubjectAttendance(
    subjects: SubjectForAttendance[],
    data: MeetingAttendanceData,
): SubjectAttendanceResult[] {
    const results: SubjectAttendanceResult[] = [];

    // Build complete discussion order: explicit order + remaining subjects in numerical order
    const completeOrder = buildCompleteDiscussionOrder(data.discussionOrder, subjects);

    const formatRef = (r: AgendaItemRef) => r.nonAgendaReason === 'outOfAgenda' ? `OA${r.agendaItemIndex}` : `#${r.agendaItemIndex}`;
    console.log(`  Complete discussion order: [${completeOrder.map(formatRef).join(', ')}]`);
    console.log(`  Explicit order from PDFs: ${data.discussionOrder ? `[${data.discussionOrder.map(formatRef).join(', ')}]` : 'null'}`);

    // Build the complete set of agenda item refs (for allAgendaItemNumbers)
    const refsSeen = new Set<string>();
    const allRefs: AgendaItemRef[] = [];
    const addRef = (ref: AgendaItemRef) => {
        const key = `${ref.agendaItemIndex}:${ref.nonAgendaReason ?? ''}`;
        if (!refsSeen.has(key)) {
            refsSeen.add(key);
            allRefs.push(ref);
        }
    };
    for (const ref of completeOrder) addRef(ref);
    for (const change of data.attendanceChanges) {
        if (change.agendaItem) addRef(change.agendaItem);
    }

    for (const subject of subjects) {
        // Determine the target ref for this subject
        let targetRef: AgendaItemRef;
        if (subject.agendaItemIndex != null) {
            targetRef = { agendaItemIndex: subject.agendaItemIndex, nonAgendaReason: null };
        } else if (subject.outOfAgendaIndex != null) {
            targetRef = { agendaItemIndex: subject.outOfAgendaIndex, nonAgendaReason: 'outOfAgenda' };
        } else {
            continue; // no position info — can't compute attendance
        }

        const effective = computeEffectiveAttendance({
            initialPresent: data.initialPresent,
            initialAbsent: data.initialAbsent,
            attendanceChanges: data.attendanceChanges,
            discussionOrder: completeOrder,
            allAgendaItemNumbers: allRefs,
            targetAgendaItemNumber: targetRef,
        });

        // Convert raw names to personIds
        const presentMemberIds: string[] = [];
        const absentMemberIds: string[] = [];
        for (const name of effective.presentNames) {
            const id = data.nameToPersonId.get(name);
            if (id) presentMemberIds.push(id);
        }
        for (const name of effective.absentNames) {
            const id = data.nameToPersonId.get(name);
            if (id) absentMemberIds.push(id);
        }

        results.push({ subjectId: subject.subjectId, presentMemberIds, absentMemberIds });
    }

    return results;
}
