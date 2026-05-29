import type { Decision } from '@schemalabs/diavgeia-cli';
import { msToISODate } from '@schemalabs/diavgeia-cli';

/** Get the PDF URL for a decision, falling back to the standard Diavgeia doc URL if documentUrl is empty */
export function decisionPdfUrl(decision: Decision): string {
    return decision.documentUrl || `https://diavgeia.gov.gr/doc/${decision.ada}`;
}

export interface SubjectForMatching {
    subjectId: string;
    name: string;
    agendaItemIndex: number | null;
    nonAgendaReason: string | null;
}

export interface SimilarityEntry {
    ada: string;
    similarity: number;
}

export interface CandidateDecision {
    ada: string;
    title: string;
    protocolNumber: string;
    publishDate: string;
    pdfUrl: string;
    similarity: number;
    isGapCandidate: boolean;
}

// ---------------------------------------------------------------------------
// Text similarity helpers
// ---------------------------------------------------------------------------

function normalizeText(text: string): string {
    return text.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[«»"'"'`]/g, '')
        .replace(/[^\w\sα-ωά-ώ]/gi, ' ')
        .replace(/\s+/g, ' ').trim();
}

function tokenize(text: string): Set<string> {
    return new Set(normalizeText(text).split(' ').filter(w => w.length >= 3));
}

function jaccardSimilarity(text1: string, text2: string): number {
    const t1 = tokenize(text1), t2 = tokenize(text2);
    if (t1.size === 0 && t2.size === 0) return 0;
    let intersection = 0;
    for (const token of t1) { if (t2.has(token)) intersection++; }
    return intersection / (t1.size + t2.size - intersection);
}

function wordCoverage(text1: string, text2: string): number {
    const t1 = tokenize(text1), t2 = tokenize(text2);
    if (t1.size === 0 || t2.size === 0) return 0;
    const [shorter, longer] = t1.size <= t2.size ? [t1, t2] : [t2, t1];
    let covered = 0;
    for (const token of shorter) { if (longer.has(token)) covered++; }
    return covered / shorter.size;
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Compute a similarity matrix between subjects and decisions.
 * For each subject, returns a sorted (descending) list of SimilarityEntry values,
 * one per decision, using the max of Jaccard similarity and word coverage.
 */
export function computeSimilarityMatrix(
    subjects: Array<{ subjectId: string; name: string }>,
    decisions: Decision[],
): Map<string, SimilarityEntry[]> {
    const matrix = new Map<string, SimilarityEntry[]>();

    for (const subject of subjects) {
        const entries: SimilarityEntry[] = decisions.map(decision => {
            const jaccard = jaccardSimilarity(subject.name, decision.subject);
            const coverage = wordCoverage(subject.name, decision.subject);
            const similarity = Math.max(jaccard, coverage);
            return { ada: decision.ada, similarity };
        });

        entries.sort((a, b) => b.similarity - a.similarity);
        matrix.set(subject.subjectId, entries);
    }

    return matrix;
}

/**
 * Build a candidate pool for each subject.
 * Selects top-N candidates by similarity and adds gap candidates unconditionally,
 * deduplicating when a gap candidate is already in the top-N list.
 */
export function buildCandidatePool(options: {
    matrix: Map<string, SimilarityEntry[]>;
    decisions: Decision[];
    topN: number;
    gapCandidateAdas: Set<string>;
}): Map<string, CandidateDecision[]> {
    const { matrix, decisions, topN, gapCandidateAdas } = options;

    // Build a lookup map for decisions by ADA
    const decisionByAda = new Map<string, Decision>(decisions.map(d => [d.ada, d]));

    const pool = new Map<string, CandidateDecision[]>();

    for (const [subjectId, entries] of matrix) {
        const seen = new Set<string>();
        const candidates: CandidateDecision[] = [];

        // Add top-N from similarity matrix
        for (const entry of entries.slice(0, topN)) {
            const decision = decisionByAda.get(entry.ada);
            if (!decision) continue;
            seen.add(entry.ada);
            candidates.push({
                ada: decision.ada,
                title: decision.subject,
                protocolNumber: decision.protocolNumber,
                publishDate: msToISODate(decision.publishTimestamp),
                pdfUrl: decisionPdfUrl(decision),
                similarity: entry.similarity,
                isGapCandidate: false,
            });
        }

        // Add gap candidates not already included
        for (const ada of gapCandidateAdas) {
            if (seen.has(ada)) continue;
            const decision = decisionByAda.get(ada);
            if (!decision) continue;
            // Find similarity from the matrix entry list
            const similarityEntry = entries.find(e => e.ada === ada);
            const similarity = similarityEntry?.similarity ?? 0;
            seen.add(ada);
            candidates.push({
                ada: decision.ada,
                title: decision.subject,
                protocolNumber: decision.protocolNumber,
                publishDate: msToISODate(decision.publishTimestamp),
                pdfUrl: decisionPdfUrl(decision),
                similarity,
                isGapCandidate: true,
            });
        }

        pool.set(subjectId, candidates);
    }

    return pool;
}

// ---------------------------------------------------------------------------
// Prompt construction & output processing types
// ---------------------------------------------------------------------------

export interface LinkedDecision {
    subjectId: string;
    subjectName: string;
    ada: string;
    decisionTitle: string;
    isReExtraction: boolean;
}

export interface ResolverOutput {
    matches: Array<{ subjectId: string; ada: string; confidence: 'high' | 'medium' | 'low'; reasoning: string }>;
    reassignments: Array<{ ada: string; fromSubjectId: string; toSubjectId: string; reasoning: string }>;
    unmatched: Array<{ subjectId: string; reasoning: string }>;
}

export interface ProcessedResolverResult {
    matches: Array<{
        subjectId: string;
        ada: string;
        decisionTitle: string;
        pdfUrl: string;
        protocolNumber: string;
        publishDate: string;
        matchConfidence: number;
    }>;
    reassignments: Array<{
        ada: string;
        fromSubjectId: string;
        toSubjectId: string;
        reason: string;
    }>;
    unmatchedSubjects: Array<{
        subjectId: string;
        name: string;
        reason: string;
    }>;
    warnings: string[];
}

interface BuildResolverPromptOptions {
    subjects: SubjectForMatching[];
    candidatePool: Map<string, CandidateDecision[]>;
    protocolAnalysis: { pattern: string; gaps: Array<{ number: number; ada: string | null; title: string | null }> } | null;
    linkedDecisions: LinkedDecision[];
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/**
 * Build a structured text prompt for the LLM resolver.
 * Assembles subjects, candidate decisions, optional protocol analysis,
 * and already-linked decisions into a single prompt string.
 */
export function buildResolverPrompt(options: BuildResolverPromptOptions): string {
    const { subjects, candidatePool, protocolAnalysis, linkedDecisions } = options;

    const lines: string[] = [];

    // Section 1: Subjects
    lines.push('SUBJECTS (to match):');
    for (const subject of subjects) {
        const positionLabel = subject.agendaItemIndex !== null ? `#${subject.agendaItemIndex}` : 'OA';
        const typeLabel = subject.nonAgendaReason !== null ? `non-agenda (${subject.nonAgendaReason})` : 'agenda';
        lines.push(`  ${positionLabel} | subjectId: ${subject.subjectId} | ${subject.name} | type: ${typeLabel}`);
    }
    lines.push('');

    // Section 2: Candidate decisions per subject
    lines.push('CANDIDATE DECISIONS (per subject):');
    for (const subject of subjects) {
        const positionLabel = subject.agendaItemIndex !== null ? `#${subject.agendaItemIndex}` : 'OA';
        lines.push(`  ${positionLabel} ${subject.subjectId}:`);
        const candidates = candidatePool.get(subject.subjectId) ?? [];
        for (const candidate of candidates) {
            const gapFlag = candidate.isGapCandidate ? ' [gap candidate]' : '';
            lines.push(
                `    ADA: ${candidate.ada} | protocol: ${candidate.protocolNumber} | title: ${candidate.title}` +
                ` | similarity: ${candidate.similarity.toFixed(2)} | published: ${candidate.publishDate}${gapFlag}`
            );
        }
    }
    lines.push('');

    // Section 3: Protocol number analysis (optional)
    if (protocolAnalysis !== null) {
        lines.push('PROTOCOL NUMBER ANALYSIS:');
        lines.push(`  Pattern: ${protocolAnalysis.pattern}`);
        lines.push('  Gaps:');
        for (const gap of protocolAnalysis.gaps) {
            const ada = gap.ada !== null ? gap.ada : 'unknown';
            const title = gap.title !== null ? gap.title : 'unknown';
            lines.push(`    number: ${gap.number} | ADA: ${ada} | title: ${title}`);
        }
        lines.push('');
    }

    // Section 4: Already linked decisions (optional)
    if (linkedDecisions.length > 0) {
        lines.push('ALREADY LINKED:');
        for (const linked of linkedDecisions) {
            const reExtractLabel = linked.isReExtraction ? ' [re-extraction]' : '';
            lines.push(
                `  subjectId: ${linked.subjectId} | ${linked.subjectName} → ADA: ${linked.ada} | ${linked.decisionTitle}${reExtractLabel}`
            );
        }
        lines.push('');
    }

    // Section 5: Constraints
    lines.push('CONSTRAINTS:');
    lines.push('  - 1:1 mapping: each ADA may be assigned to at most one subject.');
    lines.push('  - Re-extraction subjects keep their existing links unless clearly wrong.');

    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Output processing
// ---------------------------------------------------------------------------

const CONFIDENCE_SCORE: Record<'high' | 'medium' | 'low', number> = {
    high: 0.9,
    medium: 0.7,
    low: 0.5,
};

/**
 * Process the structured output from the LLM resolver into the
 * ProcessedResolverResult format. Validates ADAs against the candidate pool,
 * deduplicates assignments, and collects warnings for anomalies.
 */
export function processResolverOutput(options: {
    resolverOutput: ResolverOutput;
    candidatePool: Map<string, CandidateDecision[]>;
}): ProcessedResolverResult {
    const { resolverOutput, candidatePool } = options;

    // Build ADA → CandidateDecision lookup from all pools
    const adaLookup = new Map<string, CandidateDecision>();
    for (const candidates of candidatePool.values()) {
        for (const candidate of candidates) {
            if (!adaLookup.has(candidate.ada)) {
                adaLookup.set(candidate.ada, candidate);
            }
        }
    }

    const warnings: string[] = [];
    const usedAdas = new Set<string>();

    // If the resolver lists a subject in both matches and unmatched, prefer unmatched —
    // the resolver is contradicting itself, and "unmatched" is the safer choice.
    const unmatchedSubjectIds = new Set(resolverOutput.unmatched.map(u => u.subjectId));

    const matches: ProcessedResolverResult['matches'] = [];
    for (const match of resolverOutput.matches) {
        if (unmatchedSubjectIds.has(match.subjectId)) {
            warnings.push(`Subject "${match.subjectId}" appears in both matches and unmatched — treating as unmatched.`);
            continue;
        }
        if (match.confidence === 'low') {
            warnings.push(`Rejecting low-confidence match for "${match.subjectId}" → ADA:${match.ada} — treating as unmatched. Reasoning: ${match.reasoning}`);
            continue;
        }
        const candidate = adaLookup.get(match.ada);
        if (!candidate) {
            warnings.push(`Unknown ADA "${match.ada}" returned by resolver — skipping.`);
            continue;
        }
        if (usedAdas.has(match.ada)) {
            warnings.push(`Duplicate ADA assignment "${match.ada}" for subjectId "${match.subjectId}" — keeping first assignment.`);
            continue;
        }
        usedAdas.add(match.ada);
        matches.push({
            subjectId: match.subjectId,
            ada: match.ada,
            decisionTitle: candidate.title,
            pdfUrl: candidate.pdfUrl,
            protocolNumber: candidate.protocolNumber,
            publishDate: candidate.publishDate,
            matchConfidence: CONFIDENCE_SCORE[match.confidence],
        });
    }

    const reassignments: ProcessedResolverResult['reassignments'] = resolverOutput.reassignments.map(r => ({
        ada: r.ada,
        fromSubjectId: r.fromSubjectId,
        toSubjectId: r.toSubjectId,
        reason: r.reasoning,
    }));

    const unmatchedSubjects: ProcessedResolverResult['unmatchedSubjects'] = resolverOutput.unmatched.map(u => ({
        subjectId: u.subjectId,
        name: '', // caller fills in
        reason: u.reasoning,
    }));

    return { matches, reassignments, unmatchedSubjects, warnings };
}
