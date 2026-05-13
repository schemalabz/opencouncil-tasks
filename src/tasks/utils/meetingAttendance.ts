import { AttendanceChange, AgendaItemRef } from './decisionPdfExtraction.js';
import { computeEffectiveAttendance } from './effectiveAttendance.js';

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
 * Remaining regular subjects follow in numerical order after the last
 * explicitly ordered item.
 *
 * Result: [1, OA1, 9, OA2, OA3, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12]
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

    if (!explicitOrder || explicitOrder.length === 0) {
        return regularRefs;
    }

    // Track which regular items are already in the explicit order
    const inExplicit = new Set(
        explicitOrder
            .filter(r => r.nonAgendaReason === null)
            .map(r => r.agendaItemIndex)
    );

    // Append remaining regular items in numerical order
    const remaining = regularRefs.filter(r => !inExplicit.has(r.agendaItemIndex));

    return [...explicitOrder, ...remaining];
}

/**
 * Compute effective attendance for every subject in the meeting using
 * aggregated meeting-level data from all extracted PDFs.
 *
 * Builds a complete discussion order by merging the PDF's partial explicit
 * order with all regular subjects from the request, then computes effective
 * attendance for each subject using that unified sequence.
 *
 * Skips subjects with agendaItemIndex === null (out-of-agenda items
 * without a known position — their attendance comes from per-PDF
 * extraction if a decision exists).
 */
export function computeAllSubjectAttendance(
    subjects: SubjectForAttendance[],
    data: MeetingAttendanceData,
): SubjectAttendanceResult[] {
    const results: SubjectAttendanceResult[] = [];

    // Build complete discussion order: explicit order + remaining subjects in numerical order
    const completeOrder = buildCompleteDiscussionOrder(data.discussionOrder, subjects);

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
        if (subject.agendaItemIndex == null) continue;

        const targetRef: AgendaItemRef = {
            agendaItemIndex: subject.agendaItemIndex,
            nonAgendaReason: null,
        };

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
