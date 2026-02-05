import { diavgeiaClient, DiavgeiaDecision } from "../lib/DiavgeiaClient.js";
import { PollDecisionsRequest, PollDecisionsResult } from "../types.js";
import { Task } from "./pipeline.js";
import { aiChat } from "../lib/ai.js";

/**
 * Normalize text for comparison:
 * - Lowercase
 * - Remove quotes (both Greek and standard)
 * - Collapse whitespace
 * - Remove common punctuation
 */
function normalizeText(text: string): string {
    return text
        .toLowerCase()
        .replace(/[«»""'']/g, '') // Remove quotes
        .replace(/[.,;:!?()[\]{}]/g, ' ') // Replace punctuation with space
        .replace(/\s+/g, ' ') // Collapse whitespace
        .trim();
}

/**
 * Extract word tokens from text for similarity comparison
 */
function tokenize(text: string): Set<string> {
    const normalized = normalizeText(text);
    const words = normalized.split(' ').filter(w => w.length > 2); // Skip very short words
    return new Set(words);
}

/**
 * Calculate Jaccard similarity between two texts
 * Returns a value between 0 and 1
 */
function jaccardSimilarity(text1: string, text2: string): number {
    const tokens1 = tokenize(text1);
    const tokens2 = tokenize(text2);

    if (tokens1.size === 0 || tokens2.size === 0) {
        return 0;
    }

    const intersection = new Set([...tokens1].filter(t => tokens2.has(t)));
    const union = new Set([...tokens1, ...tokens2]);

    return intersection.size / union.size;
}

/**
 * Check if text1 contains text2 (normalized)
 */
function containsNormalized(text1: string, text2: string): boolean {
    return normalizeText(text1).includes(normalizeText(text2));
}

/**
 * Calculate what percentage of the shorter text's words appear in the longer text.
 * This handles cases where the subject is a brief version of a verbose decision title.
 */
function wordCoverage(text1: string, text2: string): number {
    const tokens1 = tokenize(text1);
    const tokens2 = tokenize(text2);

    // Determine which is shorter
    const shorter = tokens1.size <= tokens2.size ? tokens1 : tokens2;
    const longer = tokens1.size <= tokens2.size ? tokens2 : tokens1;

    if (shorter.size === 0) return 0;

    // Count how many words from the shorter text appear in the longer text
    const matchingWords = [...shorter].filter(w => longer.has(w)).length;
    return matchingWords / shorter.size;
}

interface MatchCandidate {
    decision: DiavgeiaDecision;
    similarity: number;
    isExactMatch: boolean;
}

/**
 * Find the best matching decision for a subject
 */
function findBestMatch(
    subjectName: string,
    decisions: DiavgeiaDecision[],
    usedDecisions: Set<string>
): MatchCandidate | null {
    const normalizedSubject = normalizeText(subjectName);
    let bestCandidate: MatchCandidate | null = null;

    for (const decision of decisions) {
        // Skip already matched decisions
        if (usedDecisions.has(decision.ada)) {
            continue;
        }

        const normalizedDecision = normalizeText(decision.subject);

        // Check for exact match (after normalization)
        if (normalizedSubject === normalizedDecision) {
            return {
                decision,
                similarity: 1.0,
                isExactMatch: true,
            };
        }

        // Check for containment (one contains the other)
        if (containsNormalized(decision.subject, subjectName) ||
            containsNormalized(subjectName, decision.subject)) {
            const similarity = jaccardSimilarity(subjectName, decision.subject);
            if (!bestCandidate || similarity > bestCandidate.similarity) {
                bestCandidate = {
                    decision,
                    similarity: Math.max(similarity, 0.85), // Boost containment matches
                    isExactMatch: false,
                };
            }
            continue;
        }

        // Check word coverage (handles brief subject vs verbose decision)
        // Threshold lowered to 0.6 to handle Greek word inflection differences
        const coverage = wordCoverage(subjectName, decision.subject);
        if (coverage >= 0.6) {
            // Most words from the shorter text appear in the longer text
            const similarity = jaccardSimilarity(subjectName, decision.subject);
            if (!bestCandidate || coverage > bestCandidate.similarity) {
                bestCandidate = {
                    decision,
                    similarity: Math.max(similarity, coverage * 0.9), // Boost based on coverage
                    isExactMatch: false,
                };
            }
            continue;
        }

        // Calculate similarity
        const similarity = jaccardSimilarity(subjectName, decision.subject);
        if (similarity >= 0.3 && (!bestCandidate || similarity > bestCandidate.similarity)) {
            bestCandidate = {
                decision,
                similarity,
                isExactMatch: false,
            };
        }
    }

    return bestCandidate;
}

// Thresholds for matching confidence
const HIGH_CONFIDENCE_THRESHOLD = 0.45; // Accept as match (Jaccard tends to be low for text comparison)
const AMBIGUOUS_THRESHOLD = 0.3; // Consider as candidate

interface LLMMatchResult {
    subjectId: string;
    ada: string | null;
    confidence: 'high' | 'low' | 'none';
    reasoning: string;
}

/**
 * Use LLM to match remaining unmatched subjects with available decisions
 */
async function llmMatchSubjects(
    unmatchedSubjects: Array<{ subjectId: string; name: string }>,
    availableDecisions: DiavgeiaDecision[]
): Promise<LLMMatchResult[]> {
    if (unmatchedSubjects.length === 0 || availableDecisions.length === 0) {
        return [];
    }

    const systemPrompt = `You are a Greek municipal council decision matcher. Your task is to match meeting agenda subjects with their corresponding Diavgeia (government transparency portal) decisions.

Greek text may have different word forms (inflections) - focus on the semantic meaning, not exact word matches.
For example: "Παράταση έργου ανάπλασης" and "παράτασης προθεσμίας του έργου ΑΝΑΠΛΑΣΗ" refer to the same thing.

Rules:
- Only match if you are confident the subject and decision refer to the same item
- Some subjects may not have a corresponding decision (procedural items, resolutions, etc.)
- Return "ada": null if no match is found
- Use "confidence": "high" only when you're certain, "low" if possible but uncertain, "none" if no match`;

    const decisionsForPrompt = availableDecisions.map(d => ({
        ada: d.ada,
        subject: d.subject,
        protocolNumber: d.protocolNumber,
    }));

    const subjectsForPrompt = unmatchedSubjects.map(s => ({
        subjectId: s.subjectId,
        name: s.name,
    }));

    const userPrompt = `Match these agenda subjects with decisions:

SUBJECTS:
${JSON.stringify(subjectsForPrompt, null, 2)}

AVAILABLE DECISIONS:
${JSON.stringify(decisionsForPrompt, null, 2)}

Return ONLY a JSON array (no explanation text), one object per subject:
[{"subjectId": "...", "ada": "..." or null, "confidence": "high"|"low"|"none", "reasoning": "brief explanation"}]`;

    try {
        const { result } = await aiChat<LLMMatchResult[]>({
            systemPrompt,
            userPrompt,
            model: 'haiku',
            prefillSystemResponse: '[',
            prependToResponse: '[',
        });
        return result;
    } catch (error) {
        console.error('LLM matching failed:', error);
        return [];
    }
}

export const pollDecisions: Task<PollDecisionsRequest, PollDecisionsResult> = async (request, onProgress) => {
    console.log("Polling decisions from Diavgeia:", {
        diavgeiaUid: request.diavgeiaUid,
        diavgeiaUnitId: request.diavgeiaUnitId,
        meetingDate: request.meetingDate,
        subjectCount: request.subjects.length,
    });

    onProgress("fetching decisions", 10);

    // Calculate date range: meeting date to 45 days after (decisions may be published later)
    const meetingDate = new Date(request.meetingDate);
    const fromDate = meetingDate.toISOString().split('T')[0];
    const toDate = new Date(meetingDate.getTime() + 45 * 24 * 60 * 60 * 1000)
        .toISOString().split('T')[0];

    // Fetch decisions from Diavgeia
    const decisions = await diavgeiaClient.fetchAllDecisions({
        organizationUid: request.diavgeiaUid,
        fromDate,
        toDate,
        unitId: request.diavgeiaUnitId,
    });

    console.log(`Fetched ${decisions.length} decisions from Diavgeia`);

    onProgress("matching subjects", 50);

    // Track which decisions have been matched
    const usedDecisions = new Set<string>();

    // Results
    const matches: PollDecisionsResult['matches'] = [];
    const unmatchedSubjects: PollDecisionsResult['unmatchedSubjects'] = [];
    const ambiguousSubjects: PollDecisionsResult['ambiguousSubjects'] = [];

    // First pass: find high-confidence matches
    for (const subject of request.subjects) {
        const bestMatch = findBestMatch(subject.name, decisions, usedDecisions);

        if (bestMatch && bestMatch.similarity >= HIGH_CONFIDENCE_THRESHOLD) {
            matches.push({
                subjectId: subject.subjectId,
                ada: bestMatch.decision.ada,
                decisionTitle: bestMatch.decision.subject,
                pdfUrl: bestMatch.decision.documentUrl,
                protocolNumber: bestMatch.decision.protocolNumber,
                issueDate: bestMatch.decision.issueDate,
                matchConfidence: bestMatch.similarity,
            });
            usedDecisions.add(bestMatch.decision.ada);
        } else if (bestMatch && bestMatch.similarity >= AMBIGUOUS_THRESHOLD) {
            // Collect all candidates above threshold for ambiguous matches
            const candidates = decisions
                .filter(d => !usedDecisions.has(d.ada))
                .map(d => ({
                    decision: d,
                    similarity: jaccardSimilarity(subject.name, d.subject),
                }))
                .filter(c => c.similarity >= AMBIGUOUS_THRESHOLD)
                .sort((a, b) => b.similarity - a.similarity)
                .slice(0, 3); // Top 3 candidates

            if (candidates.length > 0) {
                ambiguousSubjects.push({
                    subjectId: subject.subjectId,
                    name: subject.name,
                    candidates: candidates.map(c => ({
                        ada: c.decision.ada,
                        pdfUrl: c.decision.documentUrl,
                        title: c.decision.subject,
                        similarity: c.similarity,
                    })),
                });
            } else {
                unmatchedSubjects.push({
                    subjectId: subject.subjectId,
                    name: subject.name,
                    reason: "No decisions with sufficient similarity found",
                });
            }
        } else {
            unmatchedSubjects.push({
                subjectId: subject.subjectId,
                name: subject.name,
                reason: bestMatch
                    ? `Best match similarity too low (${(bestMatch.similarity * 100).toFixed(1)}%)`
                    : "No matching decisions found in date range",
            });
        }
    }

    // Second pass: LLM matching for remaining unmatched subjects
    if (unmatchedSubjects.length > 0) {
        onProgress("LLM matching", 70);
        console.log(`Attempting LLM matching for ${unmatchedSubjects.length} unmatched subjects...`);

        const availableDecisions = decisions.filter(d => !usedDecisions.has(d.ada));
        const llmResults = await llmMatchSubjects(unmatchedSubjects, availableDecisions);

        // Process LLM results
        const stillUnmatched: typeof unmatchedSubjects = [];
        for (const unmatched of unmatchedSubjects) {
            const llmResult = llmResults.find(r => r.subjectId === unmatched.subjectId);

            if (llmResult?.ada && llmResult.confidence !== 'none') {
                const decision = decisions.find(d => d.ada === llmResult.ada);
                if (decision && !usedDecisions.has(decision.ada)) {
                    matches.push({
                        subjectId: unmatched.subjectId,
                        ada: decision.ada,
                        decisionTitle: decision.subject,
                        pdfUrl: decision.documentUrl,
                        protocolNumber: decision.protocolNumber,
                        issueDate: decision.issueDate,
                        matchConfidence: llmResult.confidence === 'high' ? 0.85 : 0.6,
                    });
                    usedDecisions.add(decision.ada);
                    console.log(`  LLM matched: "${unmatched.name}" → ${decision.ada} (${llmResult.confidence})`);
                    continue;
                }
            }
            stillUnmatched.push({
                ...unmatched,
                reason: llmResult?.reasoning || unmatched.reason,
            });
        }

        // Update unmatched list
        unmatchedSubjects.length = 0;
        unmatchedSubjects.push(...stillUnmatched);
    }

    onProgress("complete", 100);

    return {
        matches,
        unmatchedSubjects,
        ambiguousSubjects,
        metadata: {
            diavgeiaUid: request.diavgeiaUid,
            query: { fromDate, toDate, unitId: request.diavgeiaUnitId },
            fetchedCount: decisions.length,
            matchedCount: matches.length,
            unmatchedCount: unmatchedSubjects.length,
            ambiguousCount: ambiguousSubjects.length,
        },
    };
};
