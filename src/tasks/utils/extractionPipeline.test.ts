import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockExtractDecisionFromPdf, mockMatchPersonByName, mockLlmMatchMembers } = vi.hoisted(() => ({
    mockExtractDecisionFromPdf: vi.fn(),
    mockMatchPersonByName: vi.fn(),
    mockLlmMatchMembers: vi.fn(),
}));

vi.mock('./decisionPdfExtraction.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./decisionPdfExtraction.js')>();
    return {
        ...actual,
        extractDecisionFromPdf: mockExtractDecisionFromPdf,
        matchPersonByName: mockMatchPersonByName,
        llmMatchMembers: mockLlmMatchMembers,
    };
});

vi.mock('../../lib/ai.js', () => ({
    addUsage: (a: Record<string, number>, b: Record<string, number>) => ({
        input_tokens: (a.input_tokens || 0) + (b.input_tokens || 0),
        output_tokens: (a.output_tokens || 0) + (b.output_tokens || 0),
        cache_creation_input_tokens: (a.cache_creation_input_tokens || 0) + (b.cache_creation_input_tokens || 0),
        cache_read_input_tokens: (a.cache_read_input_tokens || 0) + (b.cache_read_input_tokens || 0),
    }),
    NO_USAGE: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
}));

import { extractDecisionsFromPdfs, ExtractionSubject } from './extractionPipeline.js';
import { RawExtractedDecision, PersonForMatching } from './decisionPdfExtraction.js';

const noUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const noopProgress = () => {};

function makeRaw(overrides: Partial<RawExtractedDecision> = {}): RawExtractedDecision {
    return {
        presentMembers: ['Γιάννης Παπαδόπουλος', 'Μαρία Κωνσταντίνου'],
        absentMembers: ['Νίκος Αλεξίου'],
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

function makeSubject(overrides: Partial<ExtractionSubject> = {}): ExtractionSubject {
    return {
        subjectId: 'sub-1',
        name: 'Test Subject',
        agendaItemIndex: 1,
        decision: { pdfUrl: 'https://example.com/test.pdf', ada: null, protocolNumber: null },
        ...overrides,
    };
}

const people: PersonForMatching[] = [
    { id: 'p1', name: 'Γιάννης Παπαδόπουλος' },
    { id: 'p2', name: 'Μαρία Κωνσταντίνου' },
    { id: 'p3', name: 'Νίκος Αλεξίου' },
];

describe('extractDecisionsFromPdfs — warning propagation', () => {
    beforeEach(() => {
        mockExtractDecisionFromPdf.mockReset();
        mockMatchPersonByName.mockReset();
        mockLlmMatchMembers.mockReset();

        // Default: all names match by token-sort
        mockMatchPersonByName.mockImplementation((name: string) => {
            const match = people.find(p => p.name === name);
            return match?.id ?? null;
        });
    });

    it('produces MISSING_VOTE_RESULT when excerpt has ΑΠΟΦΑΣΙΖΕΙ but voteResult is null', async () => {
        mockExtractDecisionFromPdf.mockResolvedValueOnce({
            result: makeRaw({
                voteResult: null,
                decisionExcerpt: 'Το Δ.Σ. αφού έλαβε υπόψη... ΑΠΟΦΑΣΙΖΕΙ κάτι σημαντικό...',
            }),
            usage: noUsage,
            fromCache: false,
        });

        const result = await extractDecisionsFromPdfs([makeSubject()], people, noopProgress);

        expect(result.decisions).toHaveLength(1);
        const codes = result.decisions[0].warnings.map(w => w.code);
        expect(codes).toContain('MISSING_VOTE_RESULT');
    });

    it('produces EXTRACTION_INCOMPLETE when raw.incomplete is true', async () => {
        mockExtractDecisionFromPdf.mockResolvedValueOnce({
            result: makeRaw({ incomplete: true }),
            usage: noUsage,
            fromCache: false,
        });

        const result = await extractDecisionsFromPdfs([makeSubject()], people, noopProgress);

        const codes = result.decisions[0].warnings.map(w => w.code);
        expect(codes).toContain('EXTRACTION_INCOMPLETE');
    });

    it('produces NO_VOTE_DETAILS for majority vote without opposition voters', async () => {
        mockExtractDecisionFromPdf.mockResolvedValueOnce({
            result: makeRaw({
                voteResult: 'Κατά πλειοψηφία',
                voteDetails: [],  // majority but no AGAINST/ABSTAIN listed
            }),
            usage: noUsage,
            fromCache: false,
        });

        const result = await extractDecisionsFromPdfs([makeSubject()], people, noopProgress);

        const codes = result.decisions[0].warnings.map(w => w.code);
        expect(codes).toContain('NO_VOTE_DETAILS');
    });

    it('produces no warnings for a clean extraction', async () => {
        mockExtractDecisionFromPdf.mockResolvedValueOnce({
            result: makeRaw(),
            usage: noUsage,
            fromCache: false,
        });

        const result = await extractDecisionsFromPdfs([makeSubject()], people, noopProgress);

        // Only INFERRED_VOTES expected (unanimous with no explicit votes)
        const codes = result.decisions[0].warnings.map(w => w.code);
        expect(codes).not.toContain('MISSING_VOTE_RESULT');
        expect(codes).not.toContain('EXTRACTION_INCOMPLETE');
        expect(codes).not.toContain('EMPTY_EXCERPT');
        expect(codes).not.toContain('NO_ATTENDANCE');
    });

    it('deduplicates vote details when two name forms resolve to the same person', async () => {
        mockExtractDecisionFromPdf.mockResolvedValueOnce({
            result: makeRaw({
                presentMembers: ['ΠΑΠΑΔΟΠΟΥΛΟΣ ΙΩΑΝΝΗΣ', 'Μαρία Κωνσταντίνου'],
                voteResult: 'Κατά πλειοψηφία',
                voteDetails: [{ name: 'Παπαδόπουλος Ι.', vote: 'AGAINST' }],
            }),
            usage: noUsage,
            fromCache: false,
        });

        mockMatchPersonByName.mockImplementation((name: string) => {
            if (name === 'ΠΑΠΑΔΟΠΟΥΛΟΣ ΙΩΑΝΝΗΣ') return 'p1';
            if (name === 'Μαρία Κωνσταντίνου') return 'p2';
            return null;
        });

        mockLlmMatchMembers.mockResolvedValueOnce({
            matched: [{ name: 'Παπαδόπουλος Ι.', personId: 'p1' }],
            stillUnmatched: [],
            usage: noUsage,
        });

        const result = await extractDecisionsFromPdfs([makeSubject()], people, noopProgress);

        const decision = result.decisions[0];
        const p1Votes = decision.voteDetails.filter(v => v.personId === 'p1');
        expect(p1Votes).toHaveLength(1);
        expect(p1Votes[0].vote).toBe('AGAINST');
    });

    it('passes full people list to LLM fallback (not filtered by already-matched)', async () => {
        mockExtractDecisionFromPdf.mockResolvedValueOnce({
            result: makeRaw({
                presentMembers: ['Γιάννης Παπαδόπουλος'],
                absentMembers: [],
                voteDetails: [{ name: 'Unknown Name', vote: 'AGAINST' }],
            }),
            usage: noUsage,
            fromCache: false,
        });

        mockMatchPersonByName.mockImplementation((name: string) => {
            if (name === 'Γιάννης Παπαδόπουλος') return 'p1';
            return null;
        });

        mockLlmMatchMembers.mockResolvedValueOnce({
            matched: [],
            stillUnmatched: ['Unknown Name'],
            usage: noUsage,
        });

        await extractDecisionsFromPdfs([makeSubject()], people, noopProgress);

        expect(mockLlmMatchMembers).toHaveBeenCalledWith(
            ['Unknown Name'],
            people,
        );
    });

    it('combines raw and processed warnings on the same decision', async () => {
        // Majority vote with no opposition voters + missing decision number
        // → should get both raw-level and post-matching warnings
        mockExtractDecisionFromPdf.mockResolvedValueOnce({
            result: makeRaw({
                voteResult: 'Κατά πλειοψηφία',
                decisionNumber: null,
                voteDetails: [],  // majority but no AGAINST/ABSTAIN
            }),
            usage: noUsage,
            fromCache: false,
        });

        const result = await extractDecisionsFromPdfs([makeSubject()], people, noopProgress);

        const codes = result.decisions[0].warnings.map(w => w.code);
        // Raw-level warning
        expect(codes).toContain('MISSING_DECISION_NUMBER');
        // Post-matching warning
        expect(codes).toContain('NO_VOTE_DETAILS');
    });
});
