import { AttendanceChange } from './decisionPdfExtraction.js';

export interface EffectiveAttendanceInput {
    initialPresent: string[];
    initialAbsent: string[];
    attendanceChanges: AttendanceChange[];
    discussionOrder: number[] | null;
    allAgendaItemNumbers: number[];
    targetAgendaItemNumber: number;
}

/**
 * Compute effective attendance at a specific agenda item, accounting for
 * late arrivals, early departures, and non-standard discussion order.
 *
 * Semantics:
 * - Arrival "during subject X" → present FROM subject X onward (in discussion order)
 * - Departure "during subject X" → absent FROM subject X onward
 * - Arrival at session boundary "start" → present for all subjects
 * - Departure at session boundary "end" → present for all subjects
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
        : [...allAgendaItemNumbers].sort((a, b) => a - b);

    const targetIndex = discussionSequence.indexOf(targetAgendaItemNumber);

    // Start with initial attendance
    const present = new Set(initialPresent);
    const absent = new Set(initialAbsent);

    // Apply session-start arrivals immediately
    for (const change of attendanceChanges) {
        if (change.atSessionBoundary === 'start' && change.type === 'arrival') {
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

        // Apply arrivals for this item (person becomes present from this item onward)
        for (const change of attendanceChanges) {
            if (
                change.type === 'arrival' &&
                change.atSessionBoundary === null &&
                change.duringAgendaItem === currentItem
            ) {
                absent.delete(change.name);
                present.add(change.name);
            }
        }

        // Apply departures for this item (person leaves during discussion, absent
        // from this item onward)
        for (const change of attendanceChanges) {
            if (
                change.type === 'departure' &&
                change.atSessionBoundary === null &&
                change.duringAgendaItem === currentItem
            ) {
                present.delete(change.name);
                absent.add(change.name);
            }
        }
    }

    return {
        presentNames: [...present],
        absentNames: [...absent],
    };
}
