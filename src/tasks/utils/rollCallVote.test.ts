import { describe, it, expect } from 'vitest';
import { selectRollCall } from './rollCallVote.js';

function pdf(present: string[], absent: string[], mayorPresent: boolean | null = true) {
    return {
        presentMembers: present,
        absentMembers: absent,
        mayorPresent: mayorPresent != null ? { present: mayorPresent, rawText: '' } : null,
    };
}

describe('selectRollCall', () => {
    it('returns null when no PDFs have roll call data', () => {
        const result = selectRollCall([
            { presentMembers: null, absentMembers: null, mayorPresent: null },
            { presentMembers: [], absentMembers: [], mayorPresent: null },
        ]);
        expect(result.selected).toBeNull();
        expect(result.emptyCount).toBe(2);
    });

    it('selects the majority roll call', () => {
        const correct = pdf(['Alice', 'Bob', 'Charlie'], ['Diana'], true);
        const wrong = pdf(['Alice', 'Bob'], ['Charlie', 'Diana'], false);

        const result = selectRollCall([correct, correct, correct, wrong]);
        expect(result.selected!.presentMembers).toEqual(['Alice', 'Bob', 'Charlie']);
        expect(result.selected!.absentMembers).toEqual(['Diana']);
        expect(result.selected!.mayorPresent!.present).toBe(true);
    });

    it('returns null when no majority (split vote)', () => {
        const a = pdf(['Alice', 'Bob'], ['Charlie']);
        const b = pdf(['Alice', 'Charlie'], ['Bob']);
        const c = pdf(['Bob', 'Charlie'], ['Alice']);

        const result = selectRollCall([a, b, c]);
        expect(result.selected).toBeNull();
    });

    it('handles name order differences (normalizes by sorting)', () => {
        const a = pdf(['Charlie', 'Alice', 'Bob'], ['Diana']);
        const b = pdf(['Alice', 'Bob', 'Charlie'], ['Diana']);
        const c = pdf(['Bob', 'Charlie', 'Alice'], ['Diana']);

        const result = selectRollCall([a, b, c]);
        // All three have the same names, just different order — should agree
        expect(result.selected).not.toBeNull();
        expect(result.breakdown).toHaveLength(1);
        expect(result.breakdown[0].count).toBe(3);
    });

    it('distinguishes different mayor status', () => {
        const mayorPresent = pdf(['Alice', 'Bob'], ['Charlie'], true);
        const mayorAbsent = pdf(['Alice', 'Bob'], ['Charlie'], false);

        const result = selectRollCall([mayorPresent, mayorPresent, mayorAbsent]);
        expect(result.selected!.mayorPresent!.present).toBe(true);
    });

    it('one outlier PDF does not poison the result (the bug we fixed)', () => {
        // 11 PDFs from the correct session, 1 from a different session
        const correct = pdf(
            ['ΚΑΦΑΤΣΑΚΗ', 'ΓΡΙΒΑΣ', 'ΓΚΡΕΚΑΣ', 'ΓΙΟΥΡΓΑΣ', 'ΚΙΚΗ', 'ΣΤΑΜΑΤΑΚΗΣ', 'ΜΕΤΙΚΑΡΙΔΗΣ'],
            ['ΧΑΛΚΙΑΔΑΚΗ', 'ΚΑΡΑΒΙΔΑΣ'],
            true, // mayor present
        );
        const outlier = pdf(
            ['ΜΕΤΙΚΑΡΙΔΗΣ', 'ΓΡΙΒΑΣ', 'ΓΚΡΕΚΑΣ', 'ΚΙΚΗ', 'ΣΤΑΜΑΤΑΚΗΣ', 'ΜΑΚΡΟΖΑΧΟΠΟΥΛΟΥ', 'ΚΑΡΑΒΙΔΑΣ'],
            ['ΚΑΦΑΤΣΑΚΗ', 'ΓΙΟΥΡΓΑΣ', 'ΧΑΛΚΙΑΔΑΚΗ'],
            false, // mayor absent — different session!
        );

        const pdfs = [...Array(11).fill(correct), outlier];
        const result = selectRollCall(pdfs);

        // Majority wins — mayor present, correct member list
        expect(result.selected!.mayorPresent!.present).toBe(true);
        expect(result.selected!.presentMembers).toContain('ΚΑΦΑΤΣΑΚΗ');
        expect(result.selected!.presentMembers).toContain('ΓΙΟΥΡΓΑΣ');
        expect(result.selected!.absentMembers).toContain('ΚΑΡΑΒΙΔΑΣ');
        expect(result.breakdown).toHaveLength(2);
        expect(result.breakdown[0].count).toBe(11);
        expect(result.breakdown[1].count).toBe(1);
    });

    it('provides breakdown with counts', () => {
        const a = pdf(['Alice'], ['Bob']);
        const b = pdf(['Bob'], ['Alice']);

        const result = selectRollCall([a, a, a, b, { presentMembers: null, absentMembers: null, mayorPresent: null }]);
        expect(result.breakdown).toHaveLength(2);
        expect(result.breakdown[0].count).toBe(3);
        expect(result.breakdown[1].count).toBe(1);
        expect(result.emptyCount).toBe(1);
        expect(result.totalPdfs).toBe(5);
    });
});
