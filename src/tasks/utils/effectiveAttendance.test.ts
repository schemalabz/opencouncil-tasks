import { describe, it, expect } from 'vitest';
import { computeEffectiveAttendance, processRawExtraction } from './effectiveAttendance.js';
import { AttendanceChange, AgendaItemRef, RawExtractedDecision } from './decisionPdfExtraction.js';

function ref(index: number, nonAgendaReason: 'outOfAgenda' | null = null): AgendaItemRef {
    return { agendaItemIndex: index, nonAgendaReason };
}

function makeChange(overrides: Partial<AttendanceChange> & Pick<AttendanceChange, 'name' | 'type'>): AttendanceChange {
    return {
        agendaItem: null,
        timing: null,
        rawText: '',
        ...overrides,
    };
}

describe('computeEffectiveAttendance', () => {
    const baseInput = {
        initialPresent: ['Alice', 'Bob', 'Charlie'],
        initialAbsent: ['Diana', 'Eve'],
        allAgendaItemNumbers: [ref(1), ref(2), ref(3), ref(4), ref(5)],
        discussionOrder: null,
    };

    it('returns initial attendance when no changes', () => {
        const result = computeEffectiveAttendance({
            ...baseInput,
            attendanceChanges: [],
            targetAgendaItemNumber: ref(3),
        });
        expect(result.presentNames).toEqual(['Alice', 'Bob', 'Charlie']);
        expect(result.absentNames).toEqual(['Diana', 'Eve']);
    });

    it('applies session-start arrival: initially absent member becomes present for all', () => {
        const result = computeEffectiveAttendance({
            ...baseInput,
            attendanceChanges: [
                makeChange({ name: 'Diana', type: 'arrival' }), // agendaItem: null = session start
            ],
            targetAgendaItemNumber: ref(1),
        });
        expect(result.presentNames).toContain('Diana');
        expect(result.absentNames).not.toContain('Diana');
    });

    it('mid-meeting arrival (during): member arrives during subject #3 → absent for #1-2, present from #3', () => {
        const changes = [
            makeChange({ name: 'Diana', type: 'arrival', agendaItem: ref(3), timing: 'during' }),
        ];

        // Target subject #2 → Diana still absent
        const before = computeEffectiveAttendance({
            ...baseInput,
            attendanceChanges: changes,
            targetAgendaItemNumber: ref(2),
        });
        expect(before.presentNames).not.toContain('Diana');
        expect(before.absentNames).toContain('Diana');

        // Target subject #3 → Diana now present
        const at = computeEffectiveAttendance({
            ...baseInput,
            attendanceChanges: changes,
            targetAgendaItemNumber: ref(3),
        });
        expect(at.presentNames).toContain('Diana');
        expect(at.absentNames).not.toContain('Diana');

        // Target subject #5 → Diana still present
        const after = computeEffectiveAttendance({
            ...baseInput,
            attendanceChanges: changes,
            targetAgendaItemNumber: ref(5),
        });
        expect(after.presentNames).toContain('Diana');
    });

    it('mid-meeting departure (during): member leaves during subject #3 → present for #1-2, absent from #3', () => {
        const changes = [
            makeChange({ name: 'Bob', type: 'departure', agendaItem: ref(3), timing: 'during' }),
        ];

        // Target subject #2 → Bob still present
        const before = computeEffectiveAttendance({
            ...baseInput,
            attendanceChanges: changes,
            targetAgendaItemNumber: ref(2),
        });
        expect(before.presentNames).toContain('Bob');

        // Target subject #3 → Bob absent (leaves DURING #3, absent FROM #3)
        const during = computeEffectiveAttendance({
            ...baseInput,
            attendanceChanges: changes,
            targetAgendaItemNumber: ref(3),
        });
        expect(during.presentNames).not.toContain('Bob');
        expect(during.absentNames).toContain('Bob');

        // Target subject #4 → Bob still absent
        const after = computeEffectiveAttendance({
            ...baseInput,
            attendanceChanges: changes,
            targetAgendaItemNumber: ref(4),
        });
        expect(after.presentNames).not.toContain('Bob');
        expect(after.absentNames).toContain('Bob');
    });

    it('multiple changes for same person: leave during #3, return during #5', () => {
        const changes = [
            makeChange({ name: 'Bob', type: 'departure', agendaItem: ref(3), timing: 'during' }),
            makeChange({ name: 'Bob', type: 'arrival', agendaItem: ref(5), timing: 'during' }),
        ];

        // Absent at #3 (departure takes effect at #3)
        expect(computeEffectiveAttendance({
            ...baseInput,
            attendanceChanges: changes,
            targetAgendaItemNumber: ref(3),
        }).presentNames).not.toContain('Bob');

        // Absent at #4
        expect(computeEffectiveAttendance({
            ...baseInput,
            attendanceChanges: changes,
            targetAgendaItemNumber: ref(4),
        }).presentNames).not.toContain('Bob');

        // Present again at #5
        expect(computeEffectiveAttendance({
            ...baseInput,
            attendanceChanges: changes,
            targetAgendaItemNumber: ref(5),
        }).presentNames).toContain('Bob');
    });

    it('discussion order reordering: agenda discussed as 3,4,5,1,2', () => {
        const changes = [
            makeChange({ name: 'Diana', type: 'arrival', agendaItem: ref(1), timing: 'during' }),
        ];

        // With reordered discussion: 3,4,5,1,2
        // Diana arrives during #1, which is discussed 4th
        // → absent for subjects 3,4,5 (discussed 1st-3rd), present for 1,2 (4th-5th)
        const input = {
            ...baseInput,
            attendanceChanges: changes,
            discussionOrder: [ref(3), ref(4), ref(5), ref(1), ref(2)],
        };

        // Subject #3 (discussed 1st) → Diana absent
        expect(computeEffectiveAttendance({
            ...input,
            targetAgendaItemNumber: ref(3),
        }).presentNames).not.toContain('Diana');

        // Subject #5 (discussed 3rd) → Diana still absent
        expect(computeEffectiveAttendance({
            ...input,
            targetAgendaItemNumber: ref(5),
        }).presentNames).not.toContain('Diana');

        // Subject #1 (discussed 4th) → Diana present
        expect(computeEffectiveAttendance({
            ...input,
            targetAgendaItemNumber: ref(1),
        }).presentNames).toContain('Diana');

        // Subject #2 (discussed 5th) → Diana still present
        expect(computeEffectiveAttendance({
            ...input,
            targetAgendaItemNumber: ref(2),
        }).presentNames).toContain('Diana');
    });

    it('departure during reordered subject', () => {
        // Discussion order: 3,4,5,6,7,8,1,2
        // Bob departs during #6 (discussed 4th) → present for 3,4,5, absent from 6,7,8,1,2
        const changes = [
            makeChange({ name: 'Bob', type: 'departure', agendaItem: ref(6), timing: 'during' }),
        ];

        const input = {
            ...baseInput,
            allAgendaItemNumbers: [ref(1), ref(2), ref(3), ref(4), ref(5), ref(6), ref(7), ref(8)],
            attendanceChanges: changes,
            discussionOrder: [ref(3), ref(4), ref(5), ref(6), ref(7), ref(8), ref(1), ref(2)],
        };

        // Subject #5 (discussed 3rd) → Bob present
        expect(computeEffectiveAttendance({
            ...input,
            targetAgendaItemNumber: ref(5),
        }).presentNames).toContain('Bob');

        // Subject #6 (discussed 4th) → Bob absent (departure takes effect here)
        expect(computeEffectiveAttendance({
            ...input,
            targetAgendaItemNumber: ref(6),
        }).presentNames).not.toContain('Bob');

        // Subject #7 (discussed 5th) → Bob absent
        expect(computeEffectiveAttendance({
            ...input,
            targetAgendaItemNumber: ref(7),
        }).presentNames).not.toContain('Bob');

        // Subject #1 (discussed 7th) → Bob absent
        expect(computeEffectiveAttendance({
            ...input,
            targetAgendaItemNumber: ref(1),
        }).presentNames).not.toContain('Bob');
    });

    it('no attendance changes section → effective equals initial (passthrough)', () => {
        const result = computeEffectiveAttendance({
            ...baseInput,
            attendanceChanges: [],
            targetAgendaItemNumber: ref(3),
        });
        expect(result.presentNames.sort()).toEqual(['Alice', 'Bob', 'Charlie']);
        expect(result.absentNames.sort()).toEqual(['Diana', 'Eve']);
    });

    it('empty initial lists → only changed members appear', () => {
        const result = computeEffectiveAttendance({
            initialPresent: [],
            initialAbsent: ['Diana'],
            allAgendaItemNumbers: [ref(1), ref(2), ref(3)],
            discussionOrder: null,
            attendanceChanges: [
                makeChange({ name: 'Diana', type: 'arrival', agendaItem: ref(2), timing: 'during' }),
            ],
            targetAgendaItemNumber: ref(3),
        });
        expect(result.presentNames).toContain('Diana');
        expect(result.absentNames).not.toContain('Diana');
    });

    it('target subject not in discussion order → returns state after session-start changes', () => {
        const result = computeEffectiveAttendance({
            ...baseInput,
            attendanceChanges: [
                makeChange({ name: 'Diana', type: 'arrival' }), // session start
                makeChange({ name: 'Bob', type: 'departure', agendaItem: ref(2), timing: 'during' }),
            ],
            targetAgendaItemNumber: ref(99), // not in agenda
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
                makeChange({ name: 'Charlie', type: 'departure' }), // agendaItem: null = session end
            ],
            targetAgendaItemNumber: ref(5),
        });
        // Session-end departure doesn't affect any specific subject
        expect(result.presentNames).toContain('Charlie');
    });

    // --- New tests for timing: 'after' ---

    it('departure after item: present for that item, absent from next', () => {
        const changes = [
            makeChange({ name: 'Bob', type: 'departure', agendaItem: ref(3), timing: 'after' }),
        ];

        // Target #2 → Bob present
        expect(computeEffectiveAttendance({
            ...baseInput,
            attendanceChanges: changes,
            targetAgendaItemNumber: ref(2),
        }).presentNames).toContain('Bob');

        // Target #3 → Bob still present (left AFTER #3)
        expect(computeEffectiveAttendance({
            ...baseInput,
            attendanceChanges: changes,
            targetAgendaItemNumber: ref(3),
        }).presentNames).toContain('Bob');

        // Target #4 → Bob absent (departure takes effect after #3)
        const at4 = computeEffectiveAttendance({
            ...baseInput,
            attendanceChanges: changes,
            targetAgendaItemNumber: ref(4),
        });
        expect(at4.presentNames).not.toContain('Bob');
        expect(at4.absentNames).toContain('Bob');
    });

    it('arrival after item: present from next item', () => {
        const changes = [
            makeChange({ name: 'Diana', type: 'arrival', agendaItem: ref(3), timing: 'after' }),
        ];

        // Target #3 → Diana still absent
        expect(computeEffectiveAttendance({
            ...baseInput,
            attendanceChanges: changes,
            targetAgendaItemNumber: ref(3),
        }).presentNames).not.toContain('Diana');

        // Target #4 → Diana present (arrived after #3, i.e., at start of #4)
        expect(computeEffectiveAttendance({
            ...baseInput,
            attendanceChanges: changes,
            targetAgendaItemNumber: ref(4),
        }).presentNames).toContain('Diana');
    });

    // --- New tests for out-of-agenda items in discussion sequence ---

    it('handles out-of-agenda items in discussion sequence', () => {
        const changes = [
            makeChange({ name: 'Bob', type: 'departure', agendaItem: ref(2, 'outOfAgenda'), timing: 'during' }),
        ];

        const input = {
            initialPresent: ['Alice', 'Bob', 'Charlie'],
            initialAbsent: ['Diana'],
            allAgendaItemNumbers: [ref(1), ref(2), ref(3), ref(1, 'outOfAgenda'), ref(2, 'outOfAgenda')],
            discussionOrder: [ref(1), ref(2), ref(1, 'outOfAgenda'), ref(2, 'outOfAgenda'), ref(3)],
            attendanceChanges: changes,
        };

        // Regular item #2 → Bob still present (departure is during out-of-agenda #2, not regular #2)
        expect(computeEffectiveAttendance({
            ...input,
            targetAgendaItemNumber: ref(2),
        }).presentNames).toContain('Bob');

        // Out-of-agenda item #2 → Bob absent
        expect(computeEffectiveAttendance({
            ...input,
            targetAgendaItemNumber: ref(2, 'outOfAgenda'),
        }).presentNames).not.toContain('Bob');

        // Item #3 (after the out-of-agenda items) → Bob still absent
        expect(computeEffectiveAttendance({
            ...input,
            targetAgendaItemNumber: ref(3),
        }).presentNames).not.toContain('Bob');
    });

    it('handles after-departure with out-of-agenda items in mixed sequence', () => {
        const changes = [
            makeChange({ name: 'Bob', type: 'departure', agendaItem: ref(1, 'outOfAgenda'), timing: 'after' }),
        ];

        const input = {
            initialPresent: ['Alice', 'Bob'],
            initialAbsent: [],
            allAgendaItemNumbers: [ref(1), ref(2), ref(1, 'outOfAgenda')],
            discussionOrder: [ref(1), ref(1, 'outOfAgenda'), ref(2)],
            attendanceChanges: changes,
        };

        // Regular #1 (discussed 1st) → Bob present
        expect(computeEffectiveAttendance({
            ...input,
            targetAgendaItemNumber: ref(1),
        }).presentNames).toContain('Bob');

        // Out-of-agenda #1 (discussed 2nd) → Bob present (left AFTER this item)
        expect(computeEffectiveAttendance({
            ...input,
            targetAgendaItemNumber: ref(1, 'outOfAgenda'),
        }).presentNames).toContain('Bob');

        // Regular #2 (discussed 3rd) → Bob absent (departure effective from next item)
        expect(computeEffectiveAttendance({
            ...input,
            targetAgendaItemNumber: ref(2),
        }).presentNames).not.toContain('Bob');
    });
});

// --- processRawExtraction tests ---

describe('processRawExtraction', () => {
    function makeRaw(overrides: Partial<RawExtractedDecision> = {}): RawExtractedDecision {
        return {
            presentMembers: ['Alice', 'Bob', 'Charlie'],
            absentMembers: ['Diana'],
            mayorPresent: null,
            decisionExcerpt: 'Test excerpt',
            decisionNumber: '1/2025',
            references: '',
            voteResult: null,
            voteDetails: [],
            attendanceChanges: [],
            discussionOrder: null,
            subjectInfo: null,
            ...overrides,
        };
    }

    it('uses subjectInfo as targetRef when present', () => {
        const raw = makeRaw({
            subjectInfo: ref(3),
            attendanceChanges: [
                makeChange({ name: 'Diana', type: 'arrival', agendaItem: ref(3), timing: 'during' }),
            ],
        });

        const result = processRawExtraction(raw);
        expect(result.effectivePresent).toContain('Diana');
        expect(result.effectiveAbsent).not.toContain('Diana');
    });

    it('uses fallbackAgendaItemIndex when subjectInfo is null', () => {
        const raw = makeRaw({
            subjectInfo: null,
            attendanceChanges: [
                makeChange({ name: 'Diana', type: 'arrival', agendaItem: ref(3), timing: 'during' }),
            ],
        });

        const result = processRawExtraction(raw, 3);
        expect(result.effectivePresent).toContain('Diana');
        expect(result.effectiveAbsent).not.toContain('Diana');
    });

    it('subjectInfo takes precedence over fallbackAgendaItemIndex', () => {
        const raw = makeRaw({
            subjectInfo: ref(5),
            attendanceChanges: [
                makeChange({ name: 'Diana', type: 'arrival', agendaItem: ref(3), timing: 'during' }),
            ],
            discussionOrder: [ref(3), ref(5)],
        });

        // subjectInfo says target is #5, fallback says #3
        // At #5, Diana should be present (arrived during #3, which is before #5)
        const result = processRawExtraction(raw, 3);
        expect(result.effectivePresent).toContain('Diana');
    });

    it('skips attendance computation when no targetRef (no subjectInfo, no fallback)', () => {
        const raw = makeRaw({
            subjectInfo: null,
            attendanceChanges: [
                makeChange({ name: 'Diana', type: 'arrival', agendaItem: ref(3), timing: 'during' }),
            ],
        });

        // No subjectInfo, no fallback → passthrough raw lists
        const result = processRawExtraction(raw);
        expect(result.effectivePresent).toEqual(['Alice', 'Bob', 'Charlie']);
        expect(result.effectiveAbsent).toEqual(['Diana']);
    });

    it('collects agenda item refs from attendanceChanges and discussionOrder', () => {
        const raw = makeRaw({
            subjectInfo: ref(5),
            attendanceChanges: [
                makeChange({ name: 'Bob', type: 'departure', agendaItem: ref(3), timing: 'during' }),
            ],
            discussionOrder: [ref(1), ref(2), ref(3), ref(4), ref(5)],
        });

        // Bob departs during #3, target is #5 → Bob absent
        const result = processRawExtraction(raw);
        expect(result.effectivePresent).not.toContain('Bob');
        expect(result.effectiveAbsent).toContain('Bob');
    });

    it('deduplicates agenda item refs', () => {
        const raw = makeRaw({
            subjectInfo: ref(3),
            attendanceChanges: [
                makeChange({ name: 'Bob', type: 'departure', agendaItem: ref(3), timing: 'during' }),
            ],
            // ref(3) appears in subjectInfo, attendanceChanges, and discussionOrder
            discussionOrder: [ref(1), ref(2), ref(3)],
        });

        // Should not crash or produce duplicates — Bob departs during target #3
        const result = processRawExtraction(raw);
        expect(result.effectivePresent).not.toContain('Bob');
        expect(result.effectiveAbsent).toContain('Bob');
    });

    it('infers unanimous votes using effective present (not raw present)', () => {
        const raw = makeRaw({
            subjectInfo: ref(5),
            voteResult: 'Ομόφωνα',
            voteDetails: [],
            attendanceChanges: [
                makeChange({ name: 'Bob', type: 'departure', agendaItem: ref(3), timing: 'during' }),
            ],
            discussionOrder: [ref(1), ref(2), ref(3), ref(4), ref(5)],
        });

        const result = processRawExtraction(raw);
        // Bob is absent at #5 → should NOT get a vote
        expect(result.effectivePresent).not.toContain('Bob');
        expect(result.voteDetails.find(v => v.name === 'Bob')).toBeUndefined();
        // Alice and Charlie are present → should get FOR votes
        expect(result.voteDetails).toContainEqual({ name: 'Alice', vote: 'FOR' });
        expect(result.voteDetails).toContainEqual({ name: 'Charlie', vote: 'FOR' });
        expect(result.inferredVoteCount).toBe(2);
    });

    it('infers majority votes using effective present (not raw present)', () => {
        const raw = makeRaw({
            subjectInfo: ref(5),
            voteResult: 'Κατά πλειοψηφία',
            voteDetails: [{ name: 'Charlie', vote: 'AGAINST' }],
            attendanceChanges: [
                makeChange({ name: 'Bob', type: 'departure', agendaItem: ref(3), timing: 'during' }),
            ],
            discussionOrder: [ref(1), ref(2), ref(3), ref(4), ref(5)],
        });

        const result = processRawExtraction(raw);
        // Bob absent → no vote. Charlie explicit AGAINST. Alice gets inferred FOR.
        expect(result.voteDetails.find(v => v.name === 'Bob')).toBeUndefined();
        expect(result.voteDetails).toContainEqual({ name: 'Charlie', vote: 'AGAINST' });
        expect(result.voteDetails).toContainEqual({ name: 'Alice', vote: 'FOR' });
        expect(result.inferredVoteCount).toBe(1);
    });

    it('handles null/undefined optional fields in raw extraction', () => {
        const raw: RawExtractedDecision = {
            presentMembers: ['Alice'],
            absentMembers: [],
            mayorPresent: null,
            decisionExcerpt: '',
            decisionNumber: null,
            references: '',
            voteResult: null,
            voteDetails: [],
            attendanceChanges: [],
            discussionOrder: null,
            subjectInfo: null,
        };

        const result = processRawExtraction(raw);
        expect(result.effectivePresent).toEqual(['Alice']);
        expect(result.effectiveAbsent).toEqual([]);
        expect(result.voteDetails).toEqual([]);
        expect(result.inferredVoteCount).toBe(0);
    });

    it('handles out-of-agenda subjectInfo correctly', () => {
        const raw = makeRaw({
            subjectInfo: ref(1, 'outOfAgenda'),
            attendanceChanges: [
                makeChange({ name: 'Bob', type: 'departure', agendaItem: ref(2), timing: 'during' }),
            ],
            discussionOrder: [ref(1), ref(2), ref(1, 'outOfAgenda')],
        });

        // Target is out-of-agenda #1 (discussed 3rd). Bob departs during #2 (discussed 2nd) → absent.
        const result = processRawExtraction(raw);
        expect(result.effectivePresent).not.toContain('Bob');
        expect(result.effectiveAbsent).toContain('Bob');
    });
});
