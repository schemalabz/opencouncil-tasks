import { describe, it, expect } from 'vitest';
import type { Decision } from '@schemalabs/diavgeia-cli';
import {
    computeSimilarityMatrix,
    buildCandidatePool,
    buildResolverPrompt,
    processResolverOutput,
    type SubjectForMatching,
    type SimilarityEntry,
    type CandidateDecision,
    type LinkedDecision,
    type ResolverOutput,
} from './resolverMatchDecisions.js';

function makeDecision(overrides: Partial<Decision> & { ada: string; subject: string; protocolNumber: string }): Decision {
    return {
        issueDate: 1735084800000, publishTimestamp: 1735171200000, submissionTimestamp: 1735171200000,
        decisionTypeId: 'test', thematicCategoryIds: [], organizationId: '6104',
        unitIds: [], signerIds: [], extraFieldValues: {}, status: 'PUBLISHED',
        versionId: 'v1', correctedVersionId: null,
        documentUrl: `https://diavgeia.gov.gr/doc/${overrides.ada}`,
        documentChecksum: null, url: `https://diavgeia.gov.gr/decision/view/${overrides.ada}`,
        attachments: [], privateData: false, ...overrides,
    };
}

const subjectA: SubjectForMatching = {
    subjectId: 'sub-1',
    name: 'Έγκριση προϋπολογισμού Δήμου',
    agendaItemIndex: 1,
    nonAgendaReason: null,
};

const subjectB: SubjectForMatching = {
    subjectId: 'sub-2',
    name: 'Ορισμός επιτροπής παρακολούθησης',
    agendaItemIndex: 2,
    nonAgendaReason: null,
};

const decisionMatch = makeDecision({
    ada: 'ADA-MATCH',
    subject: 'Έγκριση προϋπολογισμού οικονομικού έτους Δήμου',
    protocolNumber: '100/2025',
});

const decisionUnrelated = makeDecision({
    ada: 'ADA-UNRELATED',
    subject: 'Άσχετο θέμα για ασφαλτόστρωση οδών',
    protocolNumber: '101/2025',
});

const decisionPartialMatch = makeDecision({
    ada: 'ADA-PARTIAL',
    subject: 'Ορισμός μελών επιτροπής',
    protocolNumber: '102/2025',
});

describe('computeSimilarityMatrix', () => {
    it('produces similarity scores for all subject-decision pairs', () => {
        const subjects = [subjectA, subjectB];
        const decisions = [decisionMatch, decisionUnrelated];
        const matrix = computeSimilarityMatrix(subjects, decisions);

        expect(matrix.has('sub-1')).toBe(true);
        expect(matrix.has('sub-2')).toBe(true);
        // Each subject should have an entry for each decision
        expect(matrix.get('sub-1')).toHaveLength(2);
        expect(matrix.get('sub-2')).toHaveLength(2);
    });

    it('returns results sorted descending by similarity', () => {
        const subjects = [subjectA];
        const decisions = [decisionUnrelated, decisionMatch]; // unrelated first, match second
        const matrix = computeSimilarityMatrix(subjects, decisions);

        const entries = matrix.get('sub-1') as SimilarityEntry[];
        expect(entries).toHaveLength(2);
        // First entry should have higher similarity than second
        expect(entries[0].similarity).toBeGreaterThanOrEqual(entries[1].similarity);
        // The matching decision should rank first
        expect(entries[0].ada).toBe('ADA-MATCH');
    });

    it('gives higher similarity to Greek text that shares tokens', () => {
        const subjects = [subjectA];
        const decisions = [decisionMatch, decisionUnrelated];
        const matrix = computeSimilarityMatrix(subjects, decisions);

        const entries = matrix.get('sub-1') as SimilarityEntry[];
        const matchEntry = entries.find(e => e.ada === 'ADA-MATCH')!;
        const unrelatedEntry = entries.find(e => e.ada === 'ADA-UNRELATED')!;

        expect(matchEntry.similarity).toBeGreaterThan(unrelatedEntry.similarity);
        expect(matchEntry.similarity).toBeGreaterThan(0);
    });

    it('returns empty array for subject with no decisions', () => {
        const subjects = [subjectA];
        const decisions: Decision[] = [];
        const matrix = computeSimilarityMatrix(subjects, decisions);

        expect(matrix.get('sub-1')).toEqual([]);
    });

    it('returns a map with no entries for empty subjects', () => {
        const subjects: SubjectForMatching[] = [];
        const decisions = [decisionMatch];
        const matrix = computeSimilarityMatrix(subjects, decisions);

        expect(matrix.size).toBe(0);
    });

    it('handles all subjects in the matrix', () => {
        const subjects = [subjectA, subjectB];
        const decisions = [decisionMatch, decisionPartialMatch];
        const matrix = computeSimilarityMatrix(subjects, decisions);

        expect(matrix.size).toBe(2);
        const sub2Entries = matrix.get('sub-2') as SimilarityEntry[];
        // subjectB shares tokens with decisionPartialMatch
        const partialEntry = sub2Entries.find(e => e.ada === 'ADA-PARTIAL')!;
        const matchEntry = sub2Entries.find(e => e.ada === 'ADA-MATCH')!;
        expect(partialEntry.similarity).toBeGreaterThan(matchEntry.similarity);
    });
});

describe('buildCandidatePool', () => {
    const decisions = [decisionMatch, decisionUnrelated, decisionPartialMatch];

    function buildMatrix(subjects: SubjectForMatching[]): ReturnType<typeof computeSimilarityMatrix> {
        return computeSimilarityMatrix(subjects, decisions);
    }

    it('selects top-N candidates per subject', () => {
        const subjects = [subjectA];
        const matrix = buildMatrix(subjects);
        const pool = buildCandidatePool({
            matrix,
            decisions,
            topN: 2,
            gapCandidateAdas: new Set(),
        });

        const candidates = pool.get('sub-1') as CandidateDecision[];
        expect(candidates).toHaveLength(2);
    });

    it('includes all decisions when topN exceeds decision count', () => {
        const subjects = [subjectA];
        const matrix = buildMatrix(subjects);
        const pool = buildCandidatePool({
            matrix,
            decisions,
            topN: 10,
            gapCandidateAdas: new Set(),
        });

        const candidates = pool.get('sub-1') as CandidateDecision[];
        expect(candidates).toHaveLength(decisions.length);
    });

    it('includes gap candidates regardless of similarity ranking', () => {
        const subjects = [subjectA];
        const matrix = computeSimilarityMatrix(subjects, decisions);
        const pool = buildCandidatePool({
            matrix,
            decisions,
            topN: 1, // Only 1 top candidate
            gapCandidateAdas: new Set(['ADA-UNRELATED']), // gap candidate not in top-1
        });

        const candidates = pool.get('sub-1') as CandidateDecision[];
        const adas = candidates.map(c => c.ada);
        expect(adas).toContain('ADA-UNRELATED');
    });

    it('deduplicates when gap candidate is already in top-N', () => {
        const subjects = [subjectA];
        const matrix = buildMatrix(subjects);
        // ADA-MATCH should be top-1 for subjectA; also mark it as gap candidate
        const pool = buildCandidatePool({
            matrix,
            decisions,
            topN: 1,
            gapCandidateAdas: new Set(['ADA-MATCH']),
        });

        const candidates = pool.get('sub-1') as CandidateDecision[];
        const adaCount = candidates.filter(c => c.ada === 'ADA-MATCH').length;
        expect(adaCount).toBe(1);
    });

    it('marks gap candidates with isGapCandidate flag', () => {
        const subjects = [subjectA];
        const matrix = buildMatrix(subjects);
        const pool = buildCandidatePool({
            matrix,
            decisions,
            topN: 1,
            gapCandidateAdas: new Set(['ADA-UNRELATED']),
        });

        const candidates = pool.get('sub-1') as CandidateDecision[];
        const topCandidate = candidates.find(c => c.ada === 'ADA-MATCH');
        const gapCandidate = candidates.find(c => c.ada === 'ADA-UNRELATED');

        expect(topCandidate!.isGapCandidate).toBe(false);
        expect(gapCandidate!.isGapCandidate).toBe(true);
    });

    it('populates candidate fields from decision', () => {
        const subjects = [subjectA];
        const matrix = buildMatrix(subjects);
        const pool = buildCandidatePool({
            matrix,
            decisions,
            topN: 1,
            gapCandidateAdas: new Set(),
        });

        const candidates = pool.get('sub-1') as CandidateDecision[];
        const top = candidates[0];
        expect(top.ada).toBe('ADA-MATCH');
        expect(top.title).toBe(decisionMatch.subject);
        expect(top.protocolNumber).toBe(decisionMatch.protocolNumber);
        expect(top.pdfUrl).toBe(decisionMatch.documentUrl);
        // publishDate should be YYYY-MM-DD format
        expect(top.publishDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(typeof top.similarity).toBe('number');
    });

    it('handles multiple subjects independently', () => {
        const subjects = [subjectA, subjectB];
        const matrix = buildMatrix(subjects);
        const pool = buildCandidatePool({
            matrix,
            decisions,
            topN: 2,
            gapCandidateAdas: new Set(),
        });

        expect(pool.has('sub-1')).toBe(true);
        expect(pool.has('sub-2')).toBe(true);
        expect(pool.get('sub-1')).toHaveLength(2);
        expect(pool.get('sub-2')).toHaveLength(2);
    });
});

// ---------------------------------------------------------------------------
// Helpers for prompt/output tests
// ---------------------------------------------------------------------------

function makeCandidateDecision(overrides: Partial<CandidateDecision> & { ada: string }): CandidateDecision {
    return {
        title: `Title for ${overrides.ada}`,
        protocolNumber: '100/2025',
        publishDate: '2025-01-01',
        pdfUrl: `https://diavgeia.gov.gr/doc/${overrides.ada}`,
        similarity: 0.75,
        isGapCandidate: false,
        ...overrides,
    };
}

const promptSubjectA: SubjectForMatching = {
    subjectId: 'sub-1',
    name: 'Έγκριση προϋπολογισμού Δήμου',
    agendaItemIndex: 1,
    nonAgendaReason: null,
};

const promptSubjectB: SubjectForMatching = {
    subjectId: 'sub-2',
    name: 'Ορισμός επιτροπής',
    agendaItemIndex: null,
    nonAgendaReason: 'extra item',
};

const candidateA1 = makeCandidateDecision({ ada: 'ADA-A1', protocolNumber: '55/2025', similarity: 0.85, publishDate: '2025-03-01' });
const candidateA2 = makeCandidateDecision({ ada: 'ADA-A2', similarity: 0.45, isGapCandidate: true });
const candidateB1 = makeCandidateDecision({ ada: 'ADA-B1', protocolNumber: '60/2025', similarity: 0.60 });

describe('buildResolverPrompt', () => {
    it('includes subjects with position labels and subjectIds', () => {
        const candidatePool = new Map<string, CandidateDecision[]>([
            ['sub-1', [candidateA1]],
            ['sub-2', [candidateB1]],
        ]);
        const prompt = buildResolverPrompt({
            subjects: [promptSubjectA, promptSubjectB],
            candidatePool,
            protocolAnalysis: null,
            linkedDecisions: [],
        });

        expect(prompt).toContain('sub-1');
        expect(prompt).toContain('Έγκριση προϋπολογισμού Δήμου');
        expect(prompt).toContain('#1'); // agenda position label
        expect(prompt).toContain('sub-2');
        expect(prompt).toContain('Ορισμός επιτροπής');
        expect(prompt).toContain('OA'); // non-agenda label
    });

    it('includes candidates with all signals', () => {
        const candidatePool = new Map<string, CandidateDecision[]>([
            ['sub-1', [candidateA1, candidateA2]],
            ['sub-2', [candidateB1]],
        ]);
        const prompt = buildResolverPrompt({
            subjects: [promptSubjectA, promptSubjectB],
            candidatePool,
            protocolAnalysis: null,
            linkedDecisions: [],
        });

        // ADA
        expect(prompt).toContain('ADA-A1');
        expect(prompt).toContain('ADA-A2');
        // Protocol number
        expect(prompt).toContain('55/2025');
        // Similarity formatted to 2 decimal places
        expect(prompt).toContain('0.85');
        expect(prompt).toContain('0.45');
        // Publish date
        expect(prompt).toContain('2025-03-01');
        // Gap candidate flag
        expect(prompt).toContain('gap');
    });

    it('includes protocol analysis section when provided', () => {
        const candidatePool = new Map<string, CandidateDecision[]>([['sub-1', [candidateA1]]]);
        const prompt = buildResolverPrompt({
            subjects: [promptSubjectA],
            candidatePool,
            protocolAnalysis: {
                pattern: 'N/2025',
                gaps: [{ number: 56, ada: 'ADA-GAP', title: 'Gap decision title' }],
            },
            linkedDecisions: [],
        });

        expect(prompt).toContain('PROTOCOL NUMBER ANALYSIS');
        expect(prompt).toContain('N/2025');
        expect(prompt).toContain('56');
        expect(prompt).toContain('ADA-GAP');
        expect(prompt).toContain('Gap decision title');
    });

    it('omits protocol analysis section when not provided', () => {
        const candidatePool = new Map<string, CandidateDecision[]>([['sub-1', [candidateA1]]]);
        const prompt = buildResolverPrompt({
            subjects: [promptSubjectA],
            candidatePool,
            protocolAnalysis: null,
            linkedDecisions: [],
        });

        expect(prompt).not.toContain('PROTOCOL NUMBER ANALYSIS');
    });

    it('includes already-linked decisions with re-extraction label', () => {
        const linked: LinkedDecision[] = [
            {
                subjectId: 'sub-1',
                subjectName: 'Έγκριση προϋπολογισμού Δήμου',
                ada: 'ADA-LINKED',
                decisionTitle: 'Linked decision title',
                isReExtraction: true,
            },
        ];
        const candidatePool = new Map<string, CandidateDecision[]>([['sub-1', [candidateA1]]]);
        const prompt = buildResolverPrompt({
            subjects: [promptSubjectA],
            candidatePool,
            protocolAnalysis: null,
            linkedDecisions: linked,
        });

        expect(prompt).toContain('ALREADY LINKED');
        expect(prompt).toContain('ADA-LINKED');
        expect(prompt).toContain('re-extraction');
    });

    it('omits already-linked section when no linked decisions', () => {
        const candidatePool = new Map<string, CandidateDecision[]>([['sub-1', [candidateA1]]]);
        const prompt = buildResolverPrompt({
            subjects: [promptSubjectA],
            candidatePool,
            protocolAnalysis: null,
            linkedDecisions: [],
        });

        expect(prompt).not.toContain('ALREADY LINKED');
    });
});

describe('processResolverOutput', () => {
    const candidatePool = new Map<string, CandidateDecision[]>([
        ['sub-1', [candidateA1, candidateA2]],
        ['sub-2', [candidateB1]],
    ]);

    it('maps resolver matches to result format with confidence scores', () => {
        const resolverOutput: ResolverOutput = {
            matches: [
                { subjectId: 'sub-1', ada: 'ADA-A1', confidence: 'high', reasoning: 'Strong match' },
                { subjectId: 'sub-2', ada: 'ADA-B1', confidence: 'medium', reasoning: 'Partial match' },
            ],
            reassignments: [],
            unmatched: [],
        };
        const result = processResolverOutput({ resolverOutput, candidatePool });

        expect(result.matches).toHaveLength(2);
        const m1 = result.matches.find(m => m.subjectId === 'sub-1')!;
        expect(m1.ada).toBe('ADA-A1');
        expect(m1.matchConfidence).toBe(0.9); // high
        expect(m1.pdfUrl).toBe(candidateA1.pdfUrl);
        expect(m1.decisionTitle).toBe(candidateA1.title);
        expect(m1.protocolNumber).toBe(candidateA1.protocolNumber);
        expect(m1.publishDate).toBe(candidateA1.publishDate);

        const m2 = result.matches.find(m => m.subjectId === 'sub-2')!;
        expect(m2.matchConfidence).toBe(0.7); // medium

        // Low confidence matches are rejected (treated as unmatched)
        const lowOutput: ResolverOutput = {
            matches: [{ subjectId: 'sub-1', ada: 'ADA-A1', confidence: 'low', reasoning: 'Weak' }],
            reassignments: [],
            unmatched: [],
        };
        const lowResult = processResolverOutput({ resolverOutput: lowOutput, candidatePool });
        expect(lowResult.matches).toHaveLength(0);
        expect(lowResult.warnings).toEqual(
            expect.arrayContaining([expect.stringContaining('low-confidence')])
        );
    });

    it('ignores unknown ADAs and adds a warning', () => {
        const resolverOutput: ResolverOutput = {
            matches: [
                { subjectId: 'sub-1', ada: 'ADA-UNKNOWN', confidence: 'high', reasoning: 'Hallucinated' },
            ],
            reassignments: [],
            unmatched: [],
        };
        const result = processResolverOutput({ resolverOutput, candidatePool });

        expect(result.matches).toHaveLength(0);
        expect(result.warnings.length).toBeGreaterThan(0);
        expect(result.warnings.some(w => w.includes('ADA-UNKNOWN'))).toBe(true);
    });

    it('handles duplicate ADA assignments by keeping first and warning', () => {
        const resolverOutput: ResolverOutput = {
            matches: [
                { subjectId: 'sub-1', ada: 'ADA-A1', confidence: 'high', reasoning: 'First' },
                { subjectId: 'sub-2', ada: 'ADA-A1', confidence: 'medium', reasoning: 'Duplicate' },
            ],
            reassignments: [],
            unmatched: [],
        };
        // sub-2 pool also needs to have ADA-A1 so it passes the unknown check
        const poolWithDup = new Map<string, CandidateDecision[]>([
            ['sub-1', [candidateA1]],
            ['sub-2', [candidateA1, candidateB1]],
        ]);
        const result = processResolverOutput({ resolverOutput, candidatePool: poolWithDup });

        const adaA1Matches = result.matches.filter(m => m.ada === 'ADA-A1');
        expect(adaA1Matches).toHaveLength(1);
        expect(adaA1Matches[0].subjectId).toBe('sub-1'); // first one wins
        expect(result.warnings.some(w => w.includes('ADA-A1'))).toBe(true);
    });

    it('maps reassignments with reasoning to reason', () => {
        const resolverOutput: ResolverOutput = {
            matches: [],
            reassignments: [
                { ada: 'ADA-A1', fromSubjectId: 'sub-1', toSubjectId: 'sub-2', reasoning: 'Better fit' },
            ],
            unmatched: [],
        };
        const result = processResolverOutput({ resolverOutput, candidatePool });

        expect(result.reassignments).toHaveLength(1);
        expect(result.reassignments[0].ada).toBe('ADA-A1');
        expect(result.reassignments[0].fromSubjectId).toBe('sub-1');
        expect(result.reassignments[0].toSubjectId).toBe('sub-2');
        expect(result.reassignments[0].reason).toBe('Better fit');
    });

    it('maps unmatched with empty name and reasoning to reason', () => {
        const resolverOutput: ResolverOutput = {
            matches: [],
            reassignments: [],
            unmatched: [
                { subjectId: 'sub-1', reasoning: 'No good candidates' },
            ],
        };
        const result = processResolverOutput({ resolverOutput, candidatePool });

        expect(result.unmatchedSubjects).toHaveLength(1);
        expect(result.unmatchedSubjects[0].subjectId).toBe('sub-1');
        expect(result.unmatchedSubjects[0].name).toBe('');
        expect(result.unmatchedSubjects[0].reason).toBe('No good candidates');
    });
});
