import { describe, it, expect } from 'vitest';
import { computeEffectiveAttendance } from './effectiveAttendance.js';
import { AttendanceChange } from './decisionPdfExtraction.js';

function makeChange(overrides: Partial<AttendanceChange> & Pick<AttendanceChange, 'name' | 'type'>): AttendanceChange {
    return {
        duringAgendaItem: null,
        atSessionBoundary: null,
        rawText: '',
        ...overrides,
    };
}

describe('computeEffectiveAttendance', () => {
    const baseInput = {
        initialPresent: ['Alice', 'Bob', 'Charlie'],
        initialAbsent: ['Diana', 'Eve'],
        allAgendaItemNumbers: [1, 2, 3, 4, 5],
        discussionOrder: null,
    };

    it('returns initial attendance when no changes', () => {
        const result = computeEffectiveAttendance({
            ...baseInput,
            attendanceChanges: [],
            targetAgendaItemNumber: 3,
        });
        expect(result.presentNames).toEqual(['Alice', 'Bob', 'Charlie']);
        expect(result.absentNames).toEqual(['Diana', 'Eve']);
    });

    it('applies session-start arrival: initially absent member becomes present for all', () => {
        const result = computeEffectiveAttendance({
            ...baseInput,
            attendanceChanges: [
                makeChange({ name: 'Diana', type: 'arrival', atSessionBoundary: 'start' }),
            ],
            targetAgendaItemNumber: 1,
        });
        expect(result.presentNames).toContain('Diana');
        expect(result.absentNames).not.toContain('Diana');
    });

    it('mid-meeting arrival: member arrives during subject #3 → absent for #1-2, present from #3', () => {
        const changes = [
            makeChange({ name: 'Diana', type: 'arrival', duringAgendaItem: 3 }),
        ];

        // Target subject #2 → Diana still absent
        const before = computeEffectiveAttendance({
            ...baseInput,
            attendanceChanges: changes,
            targetAgendaItemNumber: 2,
        });
        expect(before.presentNames).not.toContain('Diana');
        expect(before.absentNames).toContain('Diana');

        // Target subject #3 → Diana now present
        const at = computeEffectiveAttendance({
            ...baseInput,
            attendanceChanges: changes,
            targetAgendaItemNumber: 3,
        });
        expect(at.presentNames).toContain('Diana');
        expect(at.absentNames).not.toContain('Diana');

        // Target subject #5 → Diana still present
        const after = computeEffectiveAttendance({
            ...baseInput,
            attendanceChanges: changes,
            targetAgendaItemNumber: 5,
        });
        expect(after.presentNames).toContain('Diana');
    });

    it('mid-meeting departure: member leaves during subject #3 → present for #1-2, absent from #3', () => {
        const changes = [
            makeChange({ name: 'Bob', type: 'departure', duringAgendaItem: 3 }),
        ];

        // Target subject #2 → Bob still present
        const before = computeEffectiveAttendance({
            ...baseInput,
            attendanceChanges: changes,
            targetAgendaItemNumber: 2,
        });
        expect(before.presentNames).toContain('Bob');

        // Target subject #3 → Bob absent (leaves DURING #3, absent FROM #3)
        const during = computeEffectiveAttendance({
            ...baseInput,
            attendanceChanges: changes,
            targetAgendaItemNumber: 3,
        });
        expect(during.presentNames).not.toContain('Bob');
        expect(during.absentNames).toContain('Bob');

        // Target subject #4 → Bob still absent
        const after = computeEffectiveAttendance({
            ...baseInput,
            attendanceChanges: changes,
            targetAgendaItemNumber: 4,
        });
        expect(after.presentNames).not.toContain('Bob');
        expect(after.absentNames).toContain('Bob');
    });

    it('multiple changes for same person: leave #3, return #5', () => {
        const changes = [
            makeChange({ name: 'Bob', type: 'departure', duringAgendaItem: 3 }),
            makeChange({ name: 'Bob', type: 'arrival', duringAgendaItem: 5 }),
        ];

        // Absent at #3 (departure takes effect at #3)
        expect(computeEffectiveAttendance({
            ...baseInput,
            attendanceChanges: changes,
            targetAgendaItemNumber: 3,
        }).presentNames).not.toContain('Bob');

        // Absent at #4
        expect(computeEffectiveAttendance({
            ...baseInput,
            attendanceChanges: changes,
            targetAgendaItemNumber: 4,
        }).presentNames).not.toContain('Bob');

        // Present again at #5
        expect(computeEffectiveAttendance({
            ...baseInput,
            attendanceChanges: changes,
            targetAgendaItemNumber: 5,
        }).presentNames).toContain('Bob');
    });

    it('discussion order reordering: agenda discussed as 3,4,5,1,2', () => {
        const changes = [
            makeChange({ name: 'Diana', type: 'arrival', duringAgendaItem: 1 }),
        ];

        // With reordered discussion: 3,4,5,1,2
        // Diana arrives during #1, which is discussed 4th
        // → absent for subjects 3,4,5 (discussed 1st-3rd), present for 1,2 (4th-5th)
        const input = {
            ...baseInput,
            attendanceChanges: changes,
            discussionOrder: [3, 4, 5, 1, 2],
        };

        // Subject #3 (discussed 1st) → Diana absent
        expect(computeEffectiveAttendance({
            ...input,
            targetAgendaItemNumber: 3,
        }).presentNames).not.toContain('Diana');

        // Subject #5 (discussed 3rd) → Diana still absent
        expect(computeEffectiveAttendance({
            ...input,
            targetAgendaItemNumber: 5,
        }).presentNames).not.toContain('Diana');

        // Subject #1 (discussed 4th) → Diana present
        expect(computeEffectiveAttendance({
            ...input,
            targetAgendaItemNumber: 1,
        }).presentNames).toContain('Diana');

        // Subject #2 (discussed 5th) → Diana still present
        expect(computeEffectiveAttendance({
            ...input,
            targetAgendaItemNumber: 2,
        }).presentNames).toContain('Diana');
    });

    it('departure during reordered subject', () => {
        // Discussion order: 3,4,5,6,7,8,1,2
        // Bob departs during #6 (discussed 4th) → present for 3,4,5, absent from 6,7,8,1,2
        const changes = [
            makeChange({ name: 'Bob', type: 'departure', duringAgendaItem: 6 }),
        ];

        const input = {
            ...baseInput,
            allAgendaItemNumbers: [1, 2, 3, 4, 5, 6, 7, 8],
            attendanceChanges: changes,
            discussionOrder: [3, 4, 5, 6, 7, 8, 1, 2],
        };

        // Subject #5 (discussed 3rd) → Bob present
        expect(computeEffectiveAttendance({
            ...input,
            targetAgendaItemNumber: 5,
        }).presentNames).toContain('Bob');

        // Subject #6 (discussed 4th) → Bob absent (departure takes effect here)
        expect(computeEffectiveAttendance({
            ...input,
            targetAgendaItemNumber: 6,
        }).presentNames).not.toContain('Bob');

        // Subject #7 (discussed 5th) → Bob absent
        expect(computeEffectiveAttendance({
            ...input,
            targetAgendaItemNumber: 7,
        }).presentNames).not.toContain('Bob');

        // Subject #1 (discussed 7th) → Bob absent
        expect(computeEffectiveAttendance({
            ...input,
            targetAgendaItemNumber: 1,
        }).presentNames).not.toContain('Bob');
    });

    it('no attendance changes section → effective equals initial (passthrough)', () => {
        const result = computeEffectiveAttendance({
            ...baseInput,
            attendanceChanges: [],
            targetAgendaItemNumber: 3,
        });
        expect(result.presentNames.sort()).toEqual(['Alice', 'Bob', 'Charlie']);
        expect(result.absentNames.sort()).toEqual(['Diana', 'Eve']);
    });

    it('empty initial lists → only changed members appear', () => {
        const result = computeEffectiveAttendance({
            initialPresent: [],
            initialAbsent: ['Diana'],
            allAgendaItemNumbers: [1, 2, 3],
            discussionOrder: null,
            attendanceChanges: [
                makeChange({ name: 'Diana', type: 'arrival', duringAgendaItem: 2 }),
            ],
            targetAgendaItemNumber: 3,
        });
        expect(result.presentNames).toContain('Diana');
        expect(result.absentNames).not.toContain('Diana');
    });

    it('target subject not in discussion order → returns state after session-start changes', () => {
        const result = computeEffectiveAttendance({
            ...baseInput,
            attendanceChanges: [
                makeChange({ name: 'Diana', type: 'arrival', atSessionBoundary: 'start' }),
                makeChange({ name: 'Bob', type: 'departure', duringAgendaItem: 2 }),
            ],
            targetAgendaItemNumber: 99, // not in agenda
        });
        // Session-start arrival applied, but no walking of discussion order
        expect(result.presentNames).toContain('Diana');
        // Bob's departure during #2 not applied since we never walked to it
        expect(result.presentNames).toContain('Bob');
    });

    it('session-end departure: member present for all subjects', () => {
        const result = computeEffectiveAttendance({
            ...baseInput,
            attendanceChanges: [
                makeChange({ name: 'Charlie', type: 'departure', atSessionBoundary: 'end' }),
            ],
            targetAgendaItemNumber: 5,
        });
        // Session-end departure doesn't affect any specific subject
        expect(result.presentNames).toContain('Charlie');
    });
});
