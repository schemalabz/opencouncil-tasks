import { describe, it, expect } from 'vitest';
import { validateRawExtraction, validateProcessedDecision, DecisionWarning } from './decisionValidation.js';
import { RawExtractedDecision } from './decisionPdfExtraction.js';

function makeRaw(overrides: Partial<RawExtractedDecision> = {}): RawExtractedDecision {
    return {
        presentMembers: ['Alice', 'Bob'],
        absentMembers: ['Charlie'],
        mayorPresent: null,
        decisionExcerpt: 'Το Δ.Σ. αφού έλαβε υπόψη... ΑΠΟΦΑΣΙΖΕΙ...',
        decisionNumber: '42/2025',
        references: 'Ν. 3852/2010',
        voteResult: 'Ομόφωνα',
        voteDetails: [],
        attendanceChanges: [],
        discussionOrder: null,
        subjectInfo: { agendaItemIndex: 1, nonAgendaReason: null },
        incomplete: false,
        ...overrides,
    };
}

function codes(warnings: DecisionWarning[]): string[] {
    return warnings.map(w => w.code);
}

describe('validateRawExtraction', () => {
    it('returns no warnings for a complete, valid extraction', () => {
        const warnings = validateRawExtraction(makeRaw());
        expect(warnings).toEqual([]);
    });

    it('flags EXTRACTION_INCOMPLETE when incomplete is true', () => {
        const warnings = validateRawExtraction(makeRaw({ incomplete: true }));
        expect(codes(warnings)).toContain('EXTRACTION_INCOMPLETE');
        expect(warnings.find(w => w.code === 'EXTRACTION_INCOMPLETE')!.severity).toBe('error');
    });

    it('flags EMPTY_EXCERPT when excerpt is empty', () => {
        const warnings = validateRawExtraction(makeRaw({ decisionExcerpt: '' }));
        expect(codes(warnings)).toContain('EMPTY_EXCERPT');
    });

    it('flags EMPTY_EXCERPT when excerpt is whitespace-only', () => {
        const warnings = validateRawExtraction(makeRaw({ decisionExcerpt: '   \n  ' }));
        expect(codes(warnings)).toContain('EMPTY_EXCERPT');
    });

    it('flags MISSING_DECISION_NUMBER when decisionNumber is null', () => {
        const warnings = validateRawExtraction(makeRaw({ decisionNumber: null }));
        expect(codes(warnings)).toContain('MISSING_DECISION_NUMBER');
        expect(warnings.find(w => w.code === 'MISSING_DECISION_NUMBER')!.severity).toBe('info');
    });

    it('flags MISSING_DECISION_NUMBER when decisionNumber is empty string', () => {
        const warnings = validateRawExtraction(makeRaw({ decisionNumber: '' }));
        expect(codes(warnings)).toContain('MISSING_DECISION_NUMBER');
    });

    it('flags NO_ATTENDANCE when both present and absent are empty', () => {
        const warnings = validateRawExtraction(makeRaw({
            presentMembers: [],
            absentMembers: [],
        }));
        expect(codes(warnings)).toContain('NO_ATTENDANCE');
    });

    it('does not flag NO_ATTENDANCE when only present members exist', () => {
        const warnings = validateRawExtraction(makeRaw({
            presentMembers: ['Alice'],
            absentMembers: [],
        }));
        expect(codes(warnings)).not.toContain('NO_ATTENDANCE');
    });

    it('flags MISSING_VOTE_RESULT when excerpt has ΑΠΟΦΑΣΙΖΕΙ but voteResult is null', () => {
        const warnings = validateRawExtraction(makeRaw({
            voteResult: null,
            decisionExcerpt: '...ΑΠΟΦΑΣΙΖΕΙ κατά πλειοψηφία...',
        }));
        expect(codes(warnings)).toContain('MISSING_VOTE_RESULT');
    });

    it('does not flag MISSING_VOTE_RESULT when voteResult is present', () => {
        const warnings = validateRawExtraction(makeRaw({
            voteResult: 'Ομόφωνα',
            decisionExcerpt: '...ΑΠΟΦΑΣΙΖΕΙ...',
        }));
        expect(codes(warnings)).not.toContain('MISSING_VOTE_RESULT');
    });

    it('does not flag MISSING_VOTE_RESULT when excerpt lacks ΑΠΟΦΑΣΙΖΕΙ', () => {
        const warnings = validateRawExtraction(makeRaw({
            voteResult: null,
            decisionExcerpt: 'Some other content without the keyword',
        }));
        expect(codes(warnings)).not.toContain('MISSING_VOTE_RESULT');
    });

    it('can produce multiple warnings at once', () => {
        const warnings = validateRawExtraction(makeRaw({
            incomplete: true,
            decisionExcerpt: '',
            decisionNumber: null,
            presentMembers: [],
            absentMembers: [],
        }));
        expect(codes(warnings)).toEqual(
            expect.arrayContaining([
                'EXTRACTION_INCOMPLETE',
                'EMPTY_EXCERPT',
                'MISSING_DECISION_NUMBER',
                'NO_ATTENDANCE',
            ])
        );
    });
});

describe('validateProcessedDecision', () => {
    it('returns no warnings for a clean processed decision', () => {
        const warnings = validateProcessedDecision({
            voteResult: 'Ομόφωνα',
            voteDetails: [{ vote: 'FOR' }],
        });
        expect(warnings).toEqual([]);
    });

    it('flags NO_VOTE_DETAILS for majority vote without opposition', () => {
        const warnings = validateProcessedDecision({
            voteResult: 'Κατά πλειοψηφία',
            voteDetails: [{ vote: 'FOR' }],
        });
        expect(codes(warnings)).toContain('NO_VOTE_DETAILS');
        expect(warnings.find(w => w.code === 'NO_VOTE_DETAILS')!.severity).toBe('warning');
    });

    it('does not flag NO_VOTE_DETAILS for majority vote with AGAINST voters', () => {
        const warnings = validateProcessedDecision({
            voteResult: 'Κατά πλειοψηφία με ψήφους 21 υπέρ και 2 κατά',
            voteDetails: [{ vote: 'FOR' }, { vote: 'AGAINST' }],
        });
        expect(codes(warnings)).not.toContain('NO_VOTE_DETAILS');
    });

    it('does not flag NO_VOTE_DETAILS for majority vote with ABSTAIN voters', () => {
        const warnings = validateProcessedDecision({
            voteResult: 'κατά πλειοψηφία',
            voteDetails: [{ vote: 'FOR' }, { vote: 'ABSTAIN' }],
        });
        expect(codes(warnings)).not.toContain('NO_VOTE_DETAILS');
    });

    it('does not flag NO_VOTE_DETAILS for unanimous vote', () => {
        const warnings = validateProcessedDecision({
            voteResult: 'Ομόφωνα',
            voteDetails: [],
        });
        expect(codes(warnings)).not.toContain('NO_VOTE_DETAILS');
    });

    it('handles accented majority vote variants', () => {
        const warnings = validateProcessedDecision({
            voteResult: 'κατα πλειοψηφια',
            voteDetails: [{ vote: 'FOR' }],
        });
        expect(codes(warnings)).toContain('NO_VOTE_DETAILS');
    });
});
