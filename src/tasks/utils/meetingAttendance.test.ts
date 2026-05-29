import { describe, it, expect } from 'vitest';
import {
    resolveAndDeduplicateAttendanceChanges,
    computeAllSubjectAttendance,
    buildCompleteDiscussionOrder,
    SubjectForAttendance,
    MeetingAttendanceData,
} from './meetingAttendance.js';
import { AgendaItemRef, AttendanceChange } from './decisionPdfExtraction.js';

function ref(index: number, nonAgendaReason: 'outOfAgenda' | null = null): AgendaItemRef {
    return { agendaItemIndex: index, nonAgendaReason };
}

function makeMeetingData(overrides: Partial<MeetingAttendanceData> = {}): MeetingAttendanceData {
    return {
        initialPresent: ['Alice', 'Bob', 'Charlie'],
        initialAbsent: ['Diana'],
        attendanceChanges: [],
        discussionOrder: null,
        nameToPersonId: new Map([
            ['Alice', 'p1'],
            ['Bob', 'p2'],
            ['Charlie', 'p3'],
            ['Diana', 'p4'],
        ]),
        ...overrides,
    };
}

function makeChange(overrides: Partial<AttendanceChange> & Pick<AttendanceChange, 'name' | 'type'>): AttendanceChange {
    return { agendaItem: null, timing: null, rawText: '', ...overrides };
}

describe('resolveAndDeduplicateAttendanceChanges', () => {
    const nameToPersonId = new Map([
        ['ΚΩΝΣΤΑΝΤΙΝΟΣ ΑΓΓΕΛΗΣ', 'p1'],
        ['Κ. Αγγελής', 'p1'],
        ['ΕΛΕΝΗ ΧΡΙΣΤΟΥΛΗ', 'p2'],
    ]);
    const initialNames = ['ΚΩΝΣΤΑΝΤΙΝΟΣ ΑΓΓΕΛΗΣ', 'ΕΛΕΝΗ ΧΡΙΣΤΟΥΛΗ'];

    it('resolves abbreviated names to canonical initial-list form', () => {
        const extractions = [{
            raw: { attendanceChanges: [
                makeChange({ name: 'Κ. Αγγελής', type: 'departure', agendaItem: ref(1), timing: 'during' }),
            ] },
        }];

        const result = resolveAndDeduplicateAttendanceChanges(extractions, nameToPersonId, initialNames);
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('ΚΩΝΣΤΑΝΤΙΝΟΣ ΑΓΓΕΛΗΣ');
        expect(result[0].timing).toBe('during');
    });

    it('deduplicates same change from multiple PDFs with different name variants', () => {
        const extractions = [
            { raw: { attendanceChanges: [
                makeChange({ name: 'Κ. Αγγελής', type: 'departure', agendaItem: ref(1), timing: 'during' }),
            ] } },
            { raw: { attendanceChanges: [
                makeChange({ name: 'ΚΩΝΣΤΑΝΤΙΝΟΣ ΑΓΓΕΛΗΣ', type: 'departure', agendaItem: ref(1), timing: 'during' }),
            ] } },
        ];

        const result = resolveAndDeduplicateAttendanceChanges(extractions, nameToPersonId, initialNames);
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('ΚΩΝΣΤΑΝΤΙΝΟΣ ΑΓΓΕΛΗΣ');
    });

    it('picks timing by majority vote', () => {
        // 3 PDFs say "during", 1 says "after" → "during" wins
        const extractions = [
            { raw: { attendanceChanges: [makeChange({ name: 'ΚΩΝΣΤΑΝΤΙΝΟΣ ΑΓΓΕΛΗΣ', type: 'departure', agendaItem: ref(1), timing: 'after' })] } },
            { raw: { attendanceChanges: [makeChange({ name: 'ΚΩΝΣΤΑΝΤΙΝΟΣ ΑΓΓΕΛΗΣ', type: 'departure', agendaItem: ref(1), timing: 'during' })] } },
            { raw: { attendanceChanges: [makeChange({ name: 'ΚΩΝΣΤΑΝΤΙΝΟΣ ΑΓΓΕΛΗΣ', type: 'departure', agendaItem: ref(1), timing: 'during' })] } },
            { raw: { attendanceChanges: [makeChange({ name: 'ΚΩΝΣΤΑΝΤΙΝΟΣ ΑΓΓΕΛΗΣ', type: 'departure', agendaItem: ref(1), timing: 'during' })] } },
        ];

        const result = resolveAndDeduplicateAttendanceChanges(extractions, nameToPersonId, initialNames);
        expect(result).toHaveLength(1);
        expect(result[0].timing).toBe('during');
    });

    it('prefers specified timing over null on tie', () => {
        const extractions = [
            { raw: { attendanceChanges: [makeChange({ name: 'ΚΩΝΣΤΑΝΤΙΝΟΣ ΑΓΓΕΛΗΣ', type: 'departure', agendaItem: ref(1), timing: null })] } },
            { raw: { attendanceChanges: [makeChange({ name: 'ΚΩΝΣΤΑΝΤΙΝΟΣ ΑΓΓΕΛΗΣ', type: 'departure', agendaItem: ref(1), timing: 'during' })] } },
        ];

        const result = resolveAndDeduplicateAttendanceChanges(extractions, nameToPersonId, initialNames);
        expect(result).toHaveLength(1);
        expect(result[0].timing).toBe('during');
    });

    it('prefers during over after on tie', () => {
        const extractions = [
            { raw: { attendanceChanges: [makeChange({ name: 'ΚΩΝΣΤΑΝΤΙΝΟΣ ΑΓΓΕΛΗΣ', type: 'departure', agendaItem: ref(1), timing: 'after' as const })] } },
            { raw: { attendanceChanges: [makeChange({ name: 'ΚΩΝΣΤΑΝΤΙΝΟΣ ΑΓΓΕΛΗΣ', type: 'departure', agendaItem: ref(1), timing: 'during' as const })] } },
        ];

        const result = resolveAndDeduplicateAttendanceChanges(extractions, nameToPersonId, initialNames);
        expect(result).toHaveLength(1);
        expect(result[0].timing).toBe('during');
    });

    it('filters out changes reported by only 1 PDF when multiple are extracted', () => {
        // 5 PDFs, only 1 reports a change → hallucination, should be filtered
        const extractions = [
            { raw: { attendanceChanges: [makeChange({ name: 'ΚΩΝΣΤΑΝΤΙΝΟΣ ΑΓΓΕΛΗΣ', type: 'departure' as const, agendaItem: ref(1), timing: 'during' as const })] } },
            { raw: { attendanceChanges: [] } },
            { raw: { attendanceChanges: [] } },
            { raw: { attendanceChanges: [] } },
            { raw: { attendanceChanges: [] } },
        ];

        const result = resolveAndDeduplicateAttendanceChanges(extractions, nameToPersonId, initialNames);
        expect(result).toHaveLength(0);
    });

    it('includes changes reported by majority of PDFs', () => {
        // 4 PDFs, 3 report a change → above 50% threshold
        const extractions = [
            { raw: { attendanceChanges: [makeChange({ name: 'ΚΩΝΣΤΑΝΤΙΝΟΣ ΑΓΓΕΛΗΣ', type: 'departure' as const, agendaItem: ref(1), timing: 'during' as const })] } },
            { raw: { attendanceChanges: [makeChange({ name: 'ΚΩΝΣΤΑΝΤΙΝΟΣ ΑΓΓΕΛΗΣ', type: 'departure' as const, agendaItem: ref(1), timing: 'during' as const })] } },
            { raw: { attendanceChanges: [makeChange({ name: 'ΚΩΝΣΤΑΝΤΙΝΟΣ ΑΓΓΕΛΗΣ', type: 'departure' as const, agendaItem: ref(1), timing: 'during' as const })] } },
            { raw: { attendanceChanges: [] } },
        ];

        const result = resolveAndDeduplicateAttendanceChanges(extractions, nameToPersonId, initialNames);
        expect(result).toHaveLength(1);
        expect(result[0].reportingPdfCount).toBe(3);
        expect(result[0].totalPdfCount).toBe(4);
    });

    it('filters out changes at exactly 50% (requires strict majority)', () => {
        // 4 PDFs, 2 report → exactly 50%, NOT strict majority
        const extractions = [
            { raw: { attendanceChanges: [makeChange({ name: 'ΚΩΝΣΤΑΝΤΙΝΟΣ ΑΓΓΕΛΗΣ', type: 'departure' as const, agendaItem: ref(1), timing: 'during' as const })] } },
            { raw: { attendanceChanges: [makeChange({ name: 'ΚΩΝΣΤΑΝΤΙΝΟΣ ΑΓΓΕΛΗΣ', type: 'departure' as const, agendaItem: ref(1), timing: 'during' as const })] } },
            { raw: { attendanceChanges: [] } },
            { raw: { attendanceChanges: [] } },
        ];

        const result = resolveAndDeduplicateAttendanceChanges(extractions, nameToPersonId, initialNames);
        expect(result).toHaveLength(0);
    });

    it('accepts single-PDF change when only 1 PDF is extracted', () => {
        // 1 PDF, 1 reports → 1 > 0.5 → accepted
        const extractions = [
            { raw: { attendanceChanges: [makeChange({ name: 'ΚΩΝΣΤΑΝΤΙΝΟΣ ΑΓΓΕΛΗΣ', type: 'departure' as const, agendaItem: ref(1), timing: 'during' as const })] } },
        ];

        const result = resolveAndDeduplicateAttendanceChanges(extractions, nameToPersonId, initialNames);
        expect(result).toHaveLength(1);
    });

    it('keeps unmatched names as-is', () => {
        const extractions = [{
            raw: { attendanceChanges: [
                makeChange({ name: 'Ε. Χριστούλη', type: 'arrival', agendaItem: ref(2, 'outOfAgenda'), timing: 'during' }),
            ] },
        }];
        // "Ε. Χριστούλη" not in nameToPersonId
        const result = resolveAndDeduplicateAttendanceChanges(extractions, new Map([['ΕΛΕΝΗ ΧΡΙΣΤΟΥΛΗ', 'p2']]), initialNames);
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('Ε. Χριστούλη'); // unchanged
    });
});

describe('buildCompleteDiscussionOrder', () => {
    it('returns OA first then regular when no explicit discussion order', () => {
        const subjects: SubjectForAttendance[] = [
            { subjectId: 's3', agendaItemIndex: 3 },
            { subjectId: 's1', agendaItemIndex: 1 },
            { subjectId: 'soa1', agendaItemIndex: null, outOfAgendaIndex: 1 },
            { subjectId: 's2', agendaItemIndex: 2 },
            { subjectId: 'soa2', agendaItemIndex: null, outOfAgendaIndex: 2 },
        ];
        const result = buildCompleteDiscussionOrder(null, subjects);
        expect(result).toEqual([ref(1, 'outOfAgenda'), ref(2, 'outOfAgenda'), ref(1), ref(2), ref(3)]);
    });

    it('returns only regular subjects when no OA subjects and no explicit order', () => {
        const subjects: SubjectForAttendance[] = [
            { subjectId: 's3', agendaItemIndex: 3 },
            { subjectId: 's1', agendaItemIndex: 1 },
        ];
        const result = buildCompleteDiscussionOrder(null, subjects);
        expect(result).toEqual([ref(1), ref(3)]);
    });

    it('appends remaining subjects after explicit order', () => {
        const explicitOrder = [ref(1), ref(1, 'outOfAgenda'), ref(9), ref(2, 'outOfAgenda'), ref(3, 'outOfAgenda')];
        const subjects: SubjectForAttendance[] = Array.from({ length: 12 }, (_, i) => ({
            subjectId: `s${i + 1}`,
            agendaItemIndex: i + 1,
        }));

        const result = buildCompleteDiscussionOrder(explicitOrder, subjects);

        expect(result).toEqual([
            ref(1), ref(1, 'outOfAgenda'), ref(9), ref(2, 'outOfAgenda'), ref(3, 'outOfAgenda'),
            ref(2), ref(3), ref(4), ref(5), ref(6), ref(7), ref(8), ref(10), ref(11), ref(12),
        ]);
    });

    it('does not duplicate items already in explicit order', () => {
        const explicitOrder = [ref(3), ref(1), ref(2)];
        const subjects: SubjectForAttendance[] = [
            { subjectId: 's1', agendaItemIndex: 1 },
            { subjectId: 's2', agendaItemIndex: 2 },
            { subjectId: 's3', agendaItemIndex: 3 },
        ];

        const result = buildCompleteDiscussionOrder(explicitOrder, subjects);
        expect(result).toEqual([ref(3), ref(1), ref(2)]);
    });

    it('skips subjects with null agendaItemIndex', () => {
        const subjects: SubjectForAttendance[] = [
            { subjectId: 's1', agendaItemIndex: 1 },
            { subjectId: 'soa', agendaItemIndex: null },
            { subjectId: 's2', agendaItemIndex: 2 },
        ];
        const result = buildCompleteDiscussionOrder(null, subjects);
        expect(result).toEqual([ref(1), ref(2)]);
    });
});

describe('computeAllSubjectAttendance', () => {
    it('returns initial attendance for all subjects when no changes', () => {
        const subjects: SubjectForAttendance[] = [
            { subjectId: 'sub-1', agendaItemIndex: 1 },
            { subjectId: 'sub-2', agendaItemIndex: 2 },
        ];

        const result = computeAllSubjectAttendance(subjects, makeMeetingData());
        expect(result).toHaveLength(2);
        for (const entry of result) {
            expect(entry.presentMemberIds.sort()).toEqual(['p1', 'p2', 'p3']);
            expect(entry.absentMemberIds).toEqual(['p4']);
        }
    });

    it('applies mid-meeting departure correctly across subjects', () => {
        const subjects: SubjectForAttendance[] = [
            { subjectId: 'sub-1', agendaItemIndex: 1 },
            { subjectId: 'sub-9', agendaItemIndex: 9 },
            { subjectId: 'sub-10', agendaItemIndex: 10 },
        ];

        const result = computeAllSubjectAttendance(subjects, makeMeetingData({
            attendanceChanges: [{
                name: 'Bob',
                type: 'departure',
                agendaItem: ref(9),
                timing: 'after',
                rawText: 'Bob left after item 9',
            }],
            discussionOrder: [ref(1), ref(9), ref(10)],
        }));

        const sub1 = result.find(r => r.subjectId === 'sub-1')!;
        expect(sub1.presentMemberIds).toContain('p2');

        const sub9 = result.find(r => r.subjectId === 'sub-9')!;
        expect(sub9.presentMemberIds).toContain('p2');

        const sub10 = result.find(r => r.subjectId === 'sub-10')!;
        expect(sub10.presentMemberIds).not.toContain('p2');
        expect(sub10.absentMemberIds).toContain('p2');
    });

    it('Zografou case: departure after #9 applies to subjects after #9 in complete order', () => {
        const subjects: SubjectForAttendance[] = Array.from({ length: 12 }, (_, i) => ({
            subjectId: `sub-${i + 1}`,
            agendaItemIndex: i + 1,
        }));

        const result = computeAllSubjectAttendance(subjects, makeMeetingData({
            attendanceChanges: [{
                name: 'Bob',
                type: 'departure',
                agendaItem: ref(9),
                timing: 'after',
                rawText: 'Bob left after item 9',
            }],
            discussionOrder: [
                ref(1), ref(1, 'outOfAgenda'), ref(9),
                ref(2, 'outOfAgenda'), ref(3, 'outOfAgenda'),
            ],
        }));

        expect(result.find(r => r.subjectId === 'sub-1')!.presentMemberIds).toContain('p2');
        expect(result.find(r => r.subjectId === 'sub-9')!.presentMemberIds).toContain('p2');
        expect(result.find(r => r.subjectId === 'sub-3')!.presentMemberIds).not.toContain('p2');
        expect(result.find(r => r.subjectId === 'sub-3')!.absentMemberIds).toContain('p2');
        expect(result.find(r => r.subjectId === 'sub-10')!.presentMemberIds).not.toContain('p2');
    });

    it('skips subjects with null agendaItemIndex and no outOfAgendaIndex', () => {
        const subjects: SubjectForAttendance[] = [
            { subjectId: 'sub-1', agendaItemIndex: 1 },
            { subjectId: 'sub-oa', agendaItemIndex: null },
        ];

        const result = computeAllSubjectAttendance(subjects, makeMeetingData());
        expect(result).toHaveLength(1);
        expect(result[0].subjectId).toBe('sub-1');
    });

    it('includes OA subjects when outOfAgendaIndex is provided', () => {
        // Discussion order: OA1, OA2, OA3, then regular items 1-3
        // Bob departs before topic #1 (during #1) → present for OA items, absent for regular
        const subjects: SubjectForAttendance[] = [
            { subjectId: 'sub-oa1', agendaItemIndex: null, outOfAgendaIndex: 1 },
            { subjectId: 'sub-oa2', agendaItemIndex: null, outOfAgendaIndex: 2 },
            { subjectId: 'sub-1', agendaItemIndex: 1 },
            { subjectId: 'sub-2', agendaItemIndex: 2 },
        ];

        const result = computeAllSubjectAttendance(subjects, makeMeetingData({
            attendanceChanges: [{
                name: 'Bob',
                type: 'departure',
                agendaItem: ref(1),
                timing: 'during',
                rawText: 'Bob left before item 1',
            }],
            discussionOrder: [
                ref(1, 'outOfAgenda'), ref(2, 'outOfAgenda'),
                ref(1), ref(2),
            ],
        }));

        expect(result).toHaveLength(4);

        // OA subjects: Bob present
        expect(result.find(r => r.subjectId === 'sub-oa1')!.presentMemberIds).toContain('p2');
        expect(result.find(r => r.subjectId === 'sub-oa2')!.presentMemberIds).toContain('p2');

        // Regular subjects: Bob absent (departed during #1)
        expect(result.find(r => r.subjectId === 'sub-1')!.presentMemberIds).not.toContain('p2');
        expect(result.find(r => r.subjectId === 'sub-2')!.presentMemberIds).not.toContain('p2');
    });

    it('filters out names with no personId mapping', () => {
        const data = makeMeetingData({
            initialPresent: ['Alice', 'UnknownPerson'],
            nameToPersonId: new Map([['Alice', 'p1']]),
        });

        const subjects: SubjectForAttendance[] = [
            { subjectId: 'sub-1', agendaItemIndex: 1 },
        ];

        const result = computeAllSubjectAttendance(subjects, data);
        expect(result[0].presentMemberIds).toEqual(['p1']);
        expect(result[0].absentMemberIds).toEqual([]);
    });
});
