import { Diavgeia, msToISODate } from '@schemalabs/diavgeia-cli';
import type { Decision } from '@schemalabs/diavgeia-cli';
import Anthropic from '@anthropic-ai/sdk';
import { PollDecisionsRequest, PollDecisionsResult, ExtractedDecisionResult } from "../types.js";
import { Task } from "./pipeline.js";
import { aiChat, addUsage, NO_USAGE, HAIKU_MODEL } from "../lib/ai.js";
import { extractDecisionsFromPdfs, ExtractionSubject } from "./utils/extractionPipeline.js";

/**
 * Remove a match and its extraction from the results, moving the subject to unmatched.
 */
function removeMatchAndExtraction(
    subjectId: string,
    matchesArr: PollDecisionsResult['matches'],
    decisionsArr: ExtractedDecisionResult[],
    unmatchedArr: PollDecisionsResult['unmatchedSubjects'],
    subjectName: string,
    reason: string,
) {
    const matchIdx = matchesArr.findIndex(m => m.subjectId === subjectId);
    if (matchIdx >= 0) matchesArr.splice(matchIdx, 1);
    const decIdx = decisionsArr.findIndex(d => d.subjectId === subjectId);
    if (decIdx >= 0) decisionsArr.splice(decIdx, 1);
    unmatchedArr.push({ subjectId, name: subjectName, reason });
}

const client = new Diavgeia();

/**
 * Normalize text for comparison:
 * - Lowercase
 * - Remove quotes (both Greek and standard)
 * - Collapse whitespace
 * - Remove common punctuation
 */
function normalizeText(text: string): string {
    return text
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // Strip diacritics (Greek tonos, accents)
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
    decision: Decision;
    similarity: number;
    isExactMatch: boolean;
}

/**
 * Find the best matching decision for a subject
 */
function findBestMatch(
    subjectName: string,
    decisions: Decision[],
    usedDecisions: Set<string>
): MatchCandidate | null {
    const normalizedSubject = normalizeText(subjectName);
    if (normalizedSubject.length === 0) {
        return null;
    }
    let bestCandidate: MatchCandidate | null = null;

    for (const decision of decisions) {
        // Skip already matched decisions
        if (usedDecisions.has(decision.ada)) {
            continue;
        }

        const normalizedDecision = normalizeText(decision.subject);
        if (normalizedDecision.length === 0) {
            continue;
        }

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
    availableDecisions: Decision[]
): Promise<{ results: LLMMatchResult[]; usage: Anthropic.Messages.Usage }> {
    if (unmatchedSubjects.length === 0 || availableDecisions.length === 0) {
        return { results: [], usage: { ...NO_USAGE } };
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
        const { result, usage } = await aiChat<LLMMatchResult[]>({
            systemPrompt,
            userPrompt,
            model: HAIKU_MODEL,
            prefillSystemResponse: '[',
            prependToResponse: '[',
        });
        return { results: result, usage };
    } catch (error) {
        console.error('LLM matching failed:', error);
        return { results: [], usage: { ...NO_USAGE } };
    }
}

/**
 * Use LLM to resolve a conflict: which subject better matches a decision?
 */
async function resolveConflict(
    unmatchedSubject: { subjectId: string; name: string },
    linkedSubject: { subjectId: string; name: string; existingDecision?: { ada: string; decisionTitle: string; pdfUrl: string } },
    decision: Decision,
): Promise<{ winner: 'unmatched' | 'linked'; reason: string; usage: Anthropic.Messages.Usage }> {
    const systemPrompt = `You are a Greek municipal council decision matcher. You must determine which of two agenda subjects better corresponds to a Diavgeia decision.

Greek text may have different word forms (inflections) - focus on the semantic meaning, not exact word matches.

Return ONLY a JSON object: {"winner": "A" or "B", "reason": "brief explanation"}`;

    const userPrompt = `Which subject better matches this decision?

DECISION (ADA: ${decision.ada}):
"${decision.subject}"

SUBJECT A (currently unmatched):
"${unmatchedSubject.name}"

SUBJECT B (currently linked to this decision):
"${linkedSubject.name}"

Return ONLY JSON: {"winner": "A" or "B", "reason": "..."}`;

    try {
        const { result, usage } = await aiChat<{ winner: 'A' | 'B'; reason: string }>({
            systemPrompt,
            userPrompt,
            model: HAIKU_MODEL,
            prefillSystemResponse: '{',
            prependToResponse: '{',
        });
        return {
            winner: result.winner === 'A' ? 'unmatched' : 'linked',
            reason: result.reason,
            usage,
        };
    } catch (error) {
        console.error('LLM conflict resolution failed:', error);
        // Default to keeping the existing assignment
        return { winner: 'linked', reason: 'LLM conflict resolution failed, keeping existing assignment', usage: { ...NO_USAGE } };
    }
}

export const pollDecisions: Task<PollDecisionsRequest, PollDecisionsResult> = async (request, onProgress) => {
    let totalUsage: Anthropic.Messages.Usage = { ...NO_USAGE };

    console.log("Polling decisions from Diavgeia:", {
        diavgeiaUid: request.diavgeiaUid,
        diavgeiaUnitIds: request.diavgeiaUnitIds,
        meetingDate: request.meetingDate,
        subjectCount: request.subjects.length,
        peopleCount: request.people?.length ?? 0,
    });

    onProgress("fetching decisions", 5);

    // Calculate date range: meeting date to 45 days after (decisions may be published later)
    const meetingDate = new Date(request.meetingDate);
    if (isNaN(meetingDate.getTime())) {
        throw new Error(`Invalid meeting date: ${request.meetingDate}`);
    }
    const fromDate = meetingDate.toISOString().split('T')[0];
    const toDate = new Date(meetingDate.getTime() + 45 * 24 * 60 * 60 * 1000)
        .toISOString().split('T')[0];

    // Fetch decisions from Diavgeia — one request per unit ID, deduplicated by ADA
    const unitIds = request.diavgeiaUnitIds?.length ? request.diavgeiaUnitIds : [undefined];
    const seenAdas = new Set<string>();
    const decisions: Decision[] = [];
    for (const unitId of unitIds) {
        for await (const d of client.searchAll({
            org: request.diavgeiaUid,
            from_issue_date: fromDate,
            to_issue_date: toDate,
            unit: unitId,
            status: 'PUBLISHED',
        })) {
            if (!seenAdas.has(d.ada)) {
                seenAdas.add(d.ada);
                decisions.push(d);
            }
        }
    }

    console.log(`Fetched ${decisions.length} decisions from Diavgeia (${unitIds.length} unit query/queries)`);

    onProgress("matching subjects", 15);

    // Partition subjects into linked (already have a decision) and unlinked
    const linkedSubjects = request.subjects.filter(s => s.existingDecision);
    const unlinkedSubjects = request.subjects.filter(s => !s.existingDecision);

    // Build lookup of linked ADAs for conflict detection after matching
    const linkedByAda = new Map(
        linkedSubjects
            .filter(s => s.existingDecision)
            .map(s => [s.existingDecision!.ada, s]),
    );

    // Track which decisions have been matched (between unlinked subjects only —
    // linked ADAs are NOT excluded so matching can find the best candidate freely)
    const usedDecisions = new Set<string>();

    // Results
    const matches: PollDecisionsResult['matches'] = [];
    const reassignments: PollDecisionsResult['reassignments'] = [];
    const unmatchedSubjects: PollDecisionsResult['unmatchedSubjects'] = [];
    const ambiguousSubjects: PollDecisionsResult['ambiguousSubjects'] = [];

    // First pass: find high-confidence matches (only for unlinked subjects)
    for (const subject of unlinkedSubjects) {
        const bestMatch = findBestMatch(subject.name, decisions, usedDecisions);

        if (bestMatch && bestMatch.similarity >= HIGH_CONFIDENCE_THRESHOLD) {
            matches.push({
                subjectId: subject.subjectId,
                ada: bestMatch.decision.ada,
                decisionTitle: bestMatch.decision.subject,
                pdfUrl: bestMatch.decision.documentUrl,
                protocolNumber: bestMatch.decision.protocolNumber,
                publishDate: msToISODate(bestMatch.decision.publishTimestamp),
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

    // Second pass: LLM matching for unmatched and ambiguous subjects
    // Ambiguous subjects had multiple candidates with similar text scores — the LLM
    // can resolve these by understanding semantic differences (e.g. school numbers).
    const llmSubjects = [
        ...unmatchedSubjects,
        ...ambiguousSubjects.map(a => ({ subjectId: a.subjectId, name: a.name, reason: '' })),
    ];
    if (llmSubjects.length > 0) {
        onProgress("LLM matching", 35);
        console.log(`Attempting LLM matching for ${unmatchedSubjects.length} unmatched + ${ambiguousSubjects.length} ambiguous subjects...`);

        const availableDecisions = decisions.filter(d => !usedDecisions.has(d.ada));
        const { results: llmResults, usage: llmUsage } = await llmMatchSubjects(llmSubjects, availableDecisions);
        totalUsage = addUsage(totalUsage, llmUsage);

        // Process LLM results for unmatched subjects
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
                        publishDate: msToISODate(decision.publishTimestamp),
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
        unmatchedSubjects.length = 0;
        unmatchedSubjects.push(...stillUnmatched);

        // Process LLM results for ambiguous subjects
        const stillAmbiguous: typeof ambiguousSubjects = [];
        for (const ambiguous of ambiguousSubjects) {
            const llmResult = llmResults.find(r => r.subjectId === ambiguous.subjectId);

            if (llmResult?.ada && llmResult.confidence !== 'none') {
                const decision = decisions.find(d => d.ada === llmResult.ada);
                if (decision && !usedDecisions.has(decision.ada)) {
                    matches.push({
                        subjectId: ambiguous.subjectId,
                        ada: decision.ada,
                        decisionTitle: decision.subject,
                        pdfUrl: decision.documentUrl,
                        protocolNumber: decision.protocolNumber,
                        publishDate: msToISODate(decision.publishTimestamp),
                        matchConfidence: llmResult.confidence === 'high' ? 0.85 : 0.6,
                    });
                    usedDecisions.add(decision.ada);
                    console.log(`  LLM resolved ambiguous: "${ambiguous.name}" → ${decision.ada} (${llmResult.confidence})`);
                    continue;
                }
            }
            stillAmbiguous.push(ambiguous);
        }
        ambiguousSubjects.length = 0;
        ambiguousSubjects.push(...stillAmbiguous);
    }

    // Third pass: conflict resolution — check if any new match collides with
    // a decision already held by a linked subject
    const conflictingMatches = matches.filter(m => linkedByAda.has(m.ada));
    if (conflictingMatches.length > 0) {
        onProgress("conflict resolution", 45);

        for (const match of conflictingMatches) {
            const linked = linkedByAda.get(match.ada)!;
            const newSubject = unlinkedSubjects.find(s => s.subjectId === match.subjectId)!;

            const decision = decisions.find(d => d.ada === match.ada)!;
            const { winner, reason, usage: conflictUsage } = await resolveConflict(newSubject, linked, decision);
            totalUsage = addUsage(totalUsage, conflictUsage);

            if (winner === 'unmatched') {
                // New match wins — record reassignment, keep match in results
                reassignments.push({
                    ada: match.ada,
                    fromSubjectId: linked.subjectId,
                    toSubjectId: match.subjectId,
                    reason,
                });
                console.log(`  Conflict resolved: ADA ${match.ada} reassigned from "${linked.name}" to "${newSubject.name}": ${reason}`);
            } else {
                // Linked subject keeps the decision — remove match, add to unmatched
                const idx = matches.indexOf(match);
                matches.splice(idx, 1);
                usedDecisions.delete(match.ada);
                unmatchedSubjects.push({
                    subjectId: match.subjectId,
                    name: newSubject.name,
                    reason: `ADA ${match.ada} already correctly assigned to another subject: ${reason}`,
                });
                console.log(`  Conflict resolved: ADA ${match.ada} stays with "${linked.name}", not "${newSubject.name}": ${reason}`);
            }
        }
    }

    // --- Phase 2: Extract PDFs for newly matched subjects ---
    // Build subject→request lookup for agendaItemIndex
    const subjectLookup = new Map(request.subjects.map(s => [s.subjectId, s]));

    // Extract newly matched subjects
    const extractionSubjects: ExtractionSubject[] = matches.map(match => {
        const reqSubject = subjectLookup.get(match.subjectId)!;
        return {
            subjectId: match.subjectId,
            name: reqSubject.name,
            agendaItemIndex: reqSubject.agendaItemIndex,
            decision: {
                pdfUrl: match.pdfUrl,
                ada: match.ada,
                protocolNumber: match.protocolNumber,
            },
        };
    });

    // Also include subjects with linked decisions that need extraction
    // (e.g., PDF extraction failed on a previous run but the match was saved)
    const needsExtractionSubjects: ExtractionSubject[] = request.subjects
        .filter(s => s.existingDecision?.needsExtraction)
        .map(s => ({
            subjectId: s.subjectId,
            name: s.name,
            agendaItemIndex: s.agendaItemIndex,
            decision: {
                pdfUrl: s.existingDecision!.pdfUrl,
                ada: s.existingDecision!.ada,
                protocolNumber: null,
            },
        }));

    // Fetch Diavgeia metadata for needsExtraction subjects that have an ADA.
    // This enriches manually-added decisions with title, protocolNumber, and publishDate.
    // Runs in parallel with extraction since they're independent.
    const metadataPromise = (async () => {
        const metadata = new Map<string, { title: string; protocolNumber: string; publishDate: string }>();
        const fetches = needsExtractionSubjects
            .filter(s => s.decision.ada)
            .map(async (s) => {
                try {
                    const d = await client.decision(s.decision.ada!);
                    metadata.set(s.subjectId, {
                        title: d.subject,
                        protocolNumber: d.protocolNumber,
                        publishDate: msToISODate(d.publishTimestamp),
                    });
                } catch (e) {
                    console.warn(`Failed to fetch Diavgeia metadata for ADA ${s.decision.ada}:`, e);
                }
            });
        await Promise.allSettled(fetches);
        return metadata;
    })();

    const allExtractionSubjects = [...extractionSubjects, ...needsExtractionSubjects];

    let extractionResult: PollDecisionsResult['extractions'] = null;

    if (allExtractionSubjects.length > 0 && request.people?.length > 0) {
        onProgress("extracting PDFs", 50);
        console.log(`\nExtracting ${allExtractionSubjects.length} decision PDFs (${extractionSubjects.length} new, ${needsExtractionSubjects.length} re-extraction)...`);

        const pipelineResult = await extractDecisionsFromPdfs(
            allExtractionSubjects,
            request.people,
            (stage, percent) => {
                // Map extraction progress (0-100) to overall progress (50-85)
                const overallPercent = 50 + (percent / 100) * 35;
                onProgress(stage, overallPercent);
            },
            request.mayorId,
            request.forceExtract,
        );
        totalUsage = addUsage(totalUsage, pipelineResult.usage);

        // --- Verify matches using PDF subjectInfo (two-pass) ---
        // Similar titles can cause cascading mis-assignments (e.g. subject #6 matched
        // to PDF-for-#7, #7 to PDF-for-#8, etc.). A single-pass approach can't
        // re-assign because the correct target is still "matched" to another wrong PDF.
        // Two passes: first collect all mismatches, then bulk-reassign with full knowledge.
        onProgress("verifying matches", 90);

        const matchBySubjectId = new Map(matches.map(m => [m.subjectId, m]));

        // --- Pass 1: collect mismatches without mutating matches/unmatched ---
        interface VerificationMismatch {
            extraction: (typeof pipelineResult.decisions)[number];
            originalSubjectId: string;
            originalSubjectName: string;
            reason: string;
        }
        const mismatches: VerificationMismatch[] = [];

        for (const extraction of pipelineResult.decisions) {
            if (!extraction.subjectInfo) continue;

            const reqSubject = subjectLookup.get(extraction.subjectId);
            if (!reqSubject) continue;

            const expectedIndex = reqSubject.agendaItemIndex;
            const isOutOfAgenda = expectedIndex == null;

            if (isOutOfAgenda) {
                if (!extraction.subjectInfo.isOutOfAgenda) {
                    mismatches.push({
                        extraction, originalSubjectId: extraction.subjectId,
                        originalSubjectName: reqSubject.name,
                        reason: `PDF says regular item #${extraction.subjectInfo.number}, but subject is out-of-agenda`,
                    });
                }
                continue;
            }

            if (extraction.subjectInfo.isOutOfAgenda) {
                mismatches.push({
                    extraction, originalSubjectId: extraction.subjectId,
                    originalSubjectName: reqSubject.name,
                    reason: `PDF says out-of-agenda, but subject is regular item #${expectedIndex}`,
                });
                continue;
            }

            if (extraction.subjectInfo.number !== expectedIndex) {
                mismatches.push({
                    extraction, originalSubjectId: extraction.subjectId,
                    originalSubjectName: reqSubject.name,
                    reason: `PDF says subject #${extraction.subjectInfo.number} but matched to item #${expectedIndex}`,
                });
            }
        }

        // --- Pass 2: remove all mismatches at once, then try to reassign ---
        if (mismatches.length > 0) {
            // Remove all mismatched entries (frees all subjects simultaneously)
            const removedSubjectIds = new Set<string>();
            for (const { originalSubjectId } of mismatches) {
                if (removedSubjectIds.has(originalSubjectId)) continue;
                removedSubjectIds.add(originalSubjectId);
                removeMatchAndExtraction(
                    originalSubjectId, matches, pipelineResult.decisions,
                    unmatchedSubjects, subjectLookup.get(originalSubjectId)!.name, '',
                );
            }

            // Try to reassign each freed PDF to the subject with matching agendaItemIndex
            for (const { extraction, originalSubjectName, reason } of mismatches) {
                const pdfNumber = extraction.subjectInfo!.number;
                const pdfIsOutOfAgenda = extraction.subjectInfo!.isOutOfAgenda;

                const correctSubject = !pdfIsOutOfAgenda
                    ? request.subjects.find(s =>
                        s.agendaItemIndex === pdfNumber &&
                        !s.existingDecision &&
                        unmatchedSubjects.some(u => u.subjectId === s.subjectId))
                    : null;

                if (correctSubject) {
                    // Look up original match metadata (ada, pdfUrl, etc.)
                    const originalMatch = matchBySubjectId.get(extraction.subjectId);
                    if (originalMatch) {
                        matches.push({ ...originalMatch, subjectId: correctSubject.subjectId });
                        extraction.subjectId = correctSubject.subjectId;
                        pipelineResult.decisions.push(extraction);
                        const unmIdx = unmatchedSubjects.findIndex(u => u.subjectId === correctSubject.subjectId);
                        if (unmIdx >= 0) unmatchedSubjects.splice(unmIdx, 1);
                        pipelineResult.warnings.push(
                            `Re-matched PDF (subject #${pdfNumber}) from "${originalSubjectName}" to "${correctSubject.name}".`);
                        continue;
                    }
                }

                // Couldn't reassign — update reason on the unmatched entry
                const unmEntry = unmatchedSubjects.find(u => u.subjectId === extraction.subjectId);
                if (unmEntry) unmEntry.reason = reason;
                pipelineResult.warnings.push(
                    `Subject "${originalSubjectName}": ${reason}. Match discarded.`);
            }
        }

        // Enrich extraction results with Diavgeia metadata for needsExtraction subjects
        const diavgeiaMetadata = await metadataPromise;
        for (const decision of pipelineResult.decisions) {
            const meta = diavgeiaMetadata.get(decision.subjectId);
            if (meta) {
                decision.diavgeiaTitle = meta.title;
                decision.diavgeiaPublishDate = meta.publishDate;
                // Prefer Diavgeia API protocolNumber over PDF-extracted one
                decision.protocolNumber = meta.protocolNumber || decision.protocolNumber;
            }
        }

        extractionResult = {
            decisions: pipelineResult.decisions,
            warnings: pipelineResult.warnings,
        };
    } else if (allExtractionSubjects.length > 0 && (!request.people || request.people.length === 0)) {
        console.log(`Skipping extraction: no people provided for name matching`);
    }

    // Ensure metadata promise settles even if extraction was skipped
    await metadataPromise;

    onProgress("complete", 100);

    return {
        matches,
        reassignments,
        unmatchedSubjects,
        ambiguousSubjects,
        extractions: extractionResult,
        costs: {
            input_tokens: totalUsage.input_tokens,
            output_tokens: totalUsage.output_tokens,
            cache_creation_input_tokens: totalUsage.cache_creation_input_tokens ?? 0,
            cache_read_input_tokens: totalUsage.cache_read_input_tokens ?? 0,
        },
        metadata: {
            diavgeiaUid: request.diavgeiaUid,
            query: { fromDate, toDate, unitIds: request.diavgeiaUnitIds },
            fetchedCount: decisions.length,
            matchedCount: matches.length,
            unmatchedCount: unmatchedSubjects.length,
            ambiguousCount: ambiguousSubjects.length,
        },
    };
};
