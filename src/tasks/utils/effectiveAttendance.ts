import { AttendanceChange, AgendaItemRef, RawExtractedDecision, VoteValue, inferForVotes } from './decisionPdfExtraction.js';

function agendaItemRefEquals(a: AgendaItemRef, b: AgendaItemRef): boolean {
    return a.agendaItemIndex === b.agendaItemIndex && a.nonAgendaReason === b.nonAgendaReason;
}

export interface EffectiveAttendanceInput {
    initialPresent: string[];
    initialAbsent: string[];
    attendanceChanges: AttendanceChange[];
    discussionOrder: AgendaItemRef[] | null;
    allAgendaItemNumbers: AgendaItemRef[];
    targetAgendaItemNumber: AgendaItemRef;
}

/**
 * Compute effective attendance at a specific agenda item, accounting for
 * late arrivals, early departures, and non-standard discussion order.
 *
 * Semantics:
 * - Arrival "during subject X" → present FROM subject X onward (in discussion order)
 * - Departure "during subject X" → absent FROM subject X onward
 * - Departure "after subject X" → present for X, absent from the next item onward
 * - Arrival "after subject X" → absent for X, present from the next item onward
 * - Session-level (agendaItem: null, type: arrival) → present for all subjects
 * - Session-level (agendaItem: null, type: departure) → present for all subjects (left at end)
 */
export function computeEffectiveAttendance(input: EffectiveAttendanceInput): {
    presentNames: string[];
    absentNames: string[];
} {
    const {
        initialPresent,
        initialAbsent,
        attendanceChanges,
        discussionOrder,
        allAgendaItemNumbers,
        targetAgendaItemNumber,
    } = input;

    if (attendanceChanges.length === 0) {
        return {
            presentNames: [...initialPresent],
            absentNames: [...initialAbsent],
        };
    }

    // Build discussion sequence: use explicit order or sorted agenda item numbers
    const discussionSequence = discussionOrder
        ? [...discussionOrder]
        : [...allAgendaItemNumbers].sort((a, b) => a.agendaItemIndex - b.agendaItemIndex);

    const targetIndex = discussionSequence.findIndex(item => agendaItemRefEquals(item, targetAgendaItemNumber));

    // Start with initial attendance
    const present = new Set(initialPresent);
    const absent = new Set(initialAbsent);

    // Apply session-start arrivals immediately (agendaItem: null, type: arrival)
    for (const change of attendanceChanges) {
        if (change.agendaItem === null && change.type === 'arrival') {
            absent.delete(change.name);
            present.add(change.name);
        }
    }

    // If target not found in sequence, return current state
    if (targetIndex === -1) {
        return {
            presentNames: [...present],
            absentNames: [...absent],
        };
    }

    // Walk discussion sequence up to and including the target
    for (let i = 0; i <= targetIndex; i++) {
        const currentItem = discussionSequence[i];
        const previousItem = i > 0 ? discussionSequence[i - 1] : null;

        // Apply "after" changes from the PREVIOUS item
        // (a change "after item X" takes effect at the next item in sequence)
        if (previousItem !== null) {
            for (const change of attendanceChanges) {
                if (
                    change.agendaItem !== null &&
                    change.timing === 'after' &&
                    agendaItemRefEquals(change.agendaItem, previousItem)
                ) {
                    if (change.type === 'arrival') {
                        absent.delete(change.name);
                        present.add(change.name);
                    } else {
                        present.delete(change.name);
                        absent.add(change.name);
                    }
                }
            }
        }

        // Apply "during" changes for the CURRENT item
        for (const change of attendanceChanges) {
            if (
                change.agendaItem !== null &&
                change.timing === 'during' &&
                agendaItemRefEquals(change.agendaItem, currentItem)
            ) {
                if (change.type === 'arrival') {
                    absent.delete(change.name);
                    present.add(change.name);
                } else {
                    present.delete(change.name);
                    absent.add(change.name);
                }
            }
        }
    }

    return {
        presentNames: [...present],
        absentNames: [...absent],
    };
}

// --- Higher-level processing ---

export interface ProcessedExtraction {
    effectivePresent: string[];
    effectiveAbsent: string[];
    voteDetails: { name: string; vote: VoteValue }[];
    inferredVoteCount: number;
}

/**
 * Process a raw PDF extraction: compute effective attendance at the target
 * subject, then infer votes using the effective present list.
 *
 * Used by both the extraction pipeline (batch processing) and the CLI
 * (single-PDF testing) to ensure consistent logic.
 *
 * @param fallbackAgendaItemIndex - Used when the PDF doesn't contain subjectInfo
 *   but the caller knows the agenda item index (e.g. from the database).
 */
export function processRawExtraction(
    raw: RawExtractedDecision,
    fallbackAgendaItemIndex?: number | null,
): ProcessedExtraction {
    const targetRef: AgendaItemRef | null = raw.subjectInfo
        ?? (fallbackAgendaItemIndex != null
            ? { agendaItemIndex: fallbackAgendaItemIndex, nonAgendaReason: null }
            : null);

    // Collect all agenda item refs mentioned in this PDF
    const refs: AgendaItemRef[] = [];
    const seen = new Set<string>();
    const addRef = (ref: AgendaItemRef) => {
        const key = `${ref.agendaItemIndex}:${ref.nonAgendaReason ?? ''}`;
        if (!seen.has(key)) {
            seen.add(key);
            refs.push(ref);
        }
    };
    if (targetRef) addRef(targetRef);
    for (const change of raw.attendanceChanges || []) {
        if (change.agendaItem) addRef(change.agendaItem);
    }
    if (raw.discussionOrder) {
        for (const ref of raw.discussionOrder) addRef(ref);
    }

    // Compute effective attendance
    const effective = targetRef
        ? computeEffectiveAttendance({
            initialPresent: raw.presentMembers || [],
            initialAbsent: raw.absentMembers || [],
            attendanceChanges: raw.attendanceChanges || [],
            discussionOrder: raw.discussionOrder ?? null,
            allAgendaItemNumbers: refs,
            targetAgendaItemNumber: targetRef,
        })
        : { presentNames: raw.presentMembers || [], absentNames: raw.absentMembers || [] };

    // Infer votes using effective present members
    const { voteDetails, inferredCount } = inferForVotes(
        effective.presentNames,
        raw.voteResult,
        raw.voteDetails || [],
    );

    return {
        effectivePresent: effective.presentNames,
        effectiveAbsent: effective.absentNames,
        voteDetails,
        inferredVoteCount: inferredCount,
    };
}
