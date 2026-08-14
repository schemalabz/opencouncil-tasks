import { Diavgeia, msToISODate } from '@schemalabs/diavgeia-cli';
import type { Decision } from '@schemalabs/diavgeia-cli';
import Anthropic from '@anthropic-ai/sdk';
import { PollDecisionsRequest, PollDecisionsResult } from "../types.js";
import { Task } from "./pipeline.js";
import { aiChat, addUsage, NO_USAGE } from "../lib/ai.js";
import { extractDecisionsFromPdfs, ExtractionSubject } from "./utils/extractionPipeline.js";
import { computeSimilarityMatrix, buildCandidatePool, buildResolverPrompt, processResolverOutput, decisionPdfUrl } from './utils/resolverMatchDecisions.js';
import type { ResolverOutput } from './utils/resolverMatchDecisions.js';
import { detectProtocolPattern, findGaps, reconstructProtocolNumber } from './utils/protocolGapFill.js';
import { createScopedLogger } from './utils/scopedLogger.js';
import { readDecisionDocument } from './utils/readDecisionDocument.js';
import { partitionReadDecisions, type ReadDecision } from './utils/decisionPartition.js';

const client = new Diavgeia();

const RESOLVER_SYSTEM_PROMPT = `You are matching Greek municipal council agenda subjects to their corresponding decisions published on the Diavgeia transparency portal.

You will receive:
1. A list of SUBJECTS (agenda items) to match
2. CANDIDATE DECISIONS per subject, with text similarity scores, protocol numbers, and publication dates
3. PROTOCOL NUMBER ANALYSIS showing if decisions follow a sequential pattern with gaps (when available)
4. ALREADY LINKED decisions from previous runs (context only — not available for matching)

Candidates marked [declares this session] are FACTS: their own document states it was produced by this meeting's session. They definitely belong to this meeting — the only question is which subject. Prefer them over unmarked candidates when both fit.

Your job is to produce the optimal 1:1 assignment of decisions to subjects.

RULES:
- Each decision (ADA) can be assigned to at most one subject
- Consider ALL signals together: text similarity, protocol number sequence, and publication dates
- Greek text uses different word forms (inflections) — focus on semantic meaning, not exact word matches
- Ordinal numbers in subject names (e.g., "5η Τροποποίηση", "9η Αναμόρφωση") indicate the specific amendment/version number — match them precisely. "9η Αναμόρφωση Προϋπολογισμού" must match the 9th budget amendment, NOT the 10th or 8th, even if text similarity is identical.
- PROTOCOL NUMBER CLUSTER IS A STRONG SIGNAL. Decisions from the same meeting session have sequential protocol numbers (e.g., 198, 199, 200, 201). When a subject has two semantically matching candidates — one with a protocol number in the cluster and one with an outlier number — ALWAYS prefer the cluster candidate. The outlier likely belongs to a different administrative phase (e.g., a later award/approval decision). A gap candidate (marked in the protocol analysis) that semantically matches should be strongly preferred over an outlier with a slightly better title match.
- Provide brief reasoning for each decision to aid debugging

CRITICAL — when to leave a subject UNMATCHED:
- If no candidate decision is semantically related to the subject, leave it unmatched. Do NOT force a match just because candidates exist.
- A low text similarity score (e.g., below 0.3) with no semantic connection is NOT a match.
- "Least bad option" is NOT a valid reason to match. If the best candidate is about a different topic entirely, leave the subject unmatched.
- It is better to leave a subject unmatched than to assign a wrong decision. Wrong matches cause incorrect data to be stored.
- If the subject names a specific person, group, or event (e.g., "Συναυλία Encardia"), the decision MUST reference the same entity. A decision about a different concert is NOT a match even if both are concerts.

CONFIDENCE levels — use these strictly:
- "high": The decision clearly corresponds to the subject. Title shares key terms or the semantic meaning is unambiguous.
- "medium": The decision likely corresponds but there is some uncertainty (e.g., similar but not identical titles, or matched primarily through protocol number sequence).
- "low": Weak match. Only assign with "low" if there is some supporting signal (e.g., protocol number fits a gap) but the title match is tenuous.
- If you find yourself writing reasoning that says "this is likely wrong" or "despite not matching", that is NOT a match at any confidence level — leave the subject unmatched.

ALREADY LINKED decisions are CONFIRMED. Never propose moving them: their decisions and subjects are simply not available for matching. If you believe an existing link is wrong, leave the affected subject unmatched and say why in its reasoning.

Return structured JSON with matches and unmatched subjects.`;

const RESOLVER_MODEL = 'claude-sonnet-4-5-20250929';

const RESOLVER_OUTPUT_SCHEMA = {
    type: 'object' as const,
    properties: {
        matches: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    subjectId: { type: 'string' },
                    ada: { type: 'string' },
                    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
                    reasoning: { type: 'string' },
                },
                required: ['subjectId', 'ada', 'confidence', 'reasoning'],
                additionalProperties: false,
            },
        },
        unmatched: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    subjectId: { type: 'string' },
                    reasoning: { type: 'string' },
                },
                required: ['subjectId', 'reasoning'],
                additionalProperties: false,
            },
        },
    },
    required: ['matches', 'unmatched'],
    additionalProperties: false,
};

interface GapCandidate {
    gapNumber: number;
    protocolNumber: string;
    decision: Decision;
}

interface GapAnalysisResult {
    gapCandidates: GapCandidate[];
    gapCandidateAdas: Set<string>;
    protocolAnalysis: { pattern: string; gaps: Array<{ number: number; ada: string | null; title: string | null }> } | null;
}

/**
 * Detect protocol number chain, find gaps, and query Diavgeia for missing decisions.
 * Returns gap candidates and protocol analysis for the resolver prompt.
 */
async function analyzeProtocolGaps(
    protocolNumbers: string[],
    fetchedDecisions: Decision[],
    diavgeiaClient: Diavgeia,
    diavgeiaUid: string,
    log: (...args: unknown[]) => void,
    label: string,
): Promise<GapAnalysisResult> {
    const empty: GapAnalysisResult = { gapCandidates: [], gapCandidateAdas: new Set(), protocolAnalysis: null };

    if (protocolNumbers.length < 3) {
        log(`  ${label}: insufficient for pattern detection (${protocolNumbers.length} numbers, need 3+)`);
        return empty;
    }

    const pattern = detectProtocolPattern(protocolNumbers);
    if (!pattern) {
        log(`  ${label}: inconsistent format`);
        return empty;
    }
    if (!pattern.sequential) {
        log(`  ${label}: no cluster of 3+ sequential numbers found`);
        return empty;
    }

    const gaps = findGaps(pattern.numbers);
    if (gaps.length === 0) {
        log(`  ${label}: no gaps in sequence ${Math.min(...pattern.numbers)}-${Math.max(...pattern.numbers)}`);
        return empty;
    }

    log(`  ${label}: ${pattern.numbers.length} numbers in cluster ${Math.min(...pattern.numbers)}-${Math.max(...pattern.numbers)}, ${gaps.length} gaps`);
    if (pattern.outliers.length > 0) {
        log(`  ${label} outliers (excluded from cluster): ${pattern.outliers.join(', ')}`);
    }
    log(`  ${label} gaps: ${gaps.join(', ')}`);

    const gapCandidates: GapCandidate[] = [];
    const gapCandidateAdas = new Set<string>();
    const gapDetails: Array<{ number: number; ada: string | null; title: string | null }> = [];

    for (const gapNumber of gaps) {
        const expectedPN = reconstructProtocolNumber(pattern, gapNumber);
        let found = fetchedDecisions.find(d => d.protocolNumber === expectedPN);

        if (!found) {
            try {
                const query = `protocolNumber:"${expectedPN}" AND organizationUid:"${diavgeiaUid}"`;
                const response = await diavgeiaClient.searchAdvanced({ q: query, size: 1 });
                if (response.decisions.length > 0) {
                    found = response.decisions[0];
                    fetchedDecisions.push(found);
                }
            } catch { /* skip */ }
        }

        if (found) {
            gapCandidates.push({ gapNumber, protocolNumber: expectedPN, decision: found });
            gapCandidateAdas.add(found.ada);
            gapDetails.push({ number: gapNumber, ada: found.ada, title: found.subject });
            log(`    Gap ${expectedPN}: found ADA:${found.ada}`);
        } else {
            gapDetails.push({ number: gapNumber, ada: null, title: null });
            log(`    Gap ${expectedPN}: not found on Diavgeia`);
        }
    }

    const protocolAnalysis = {
        pattern: `${Math.min(...pattern.numbers)}-${Math.max(...pattern.numbers)} (sequential, ${gaps.length} gap${gaps.length !== 1 ? 's' : ''})`,
        gaps: gapDetails,
    };

    return { gapCandidates, gapCandidateAdas, protocolAnalysis };
}

export interface ResolveInput {
    subjects: PollDecisionsRequest['subjects'];
    /** Documents whose page-1 reading declares this meeting's session date — facts, not guesses. */
    inMeeting: Decision[];
    /** Unread/unreadable window candidates — the legacy similarity pool. */
    fallback: Decision[];
    diavgeiaUid: string;
    log: (...args: unknown[]) => void;
    onProgress?: (status: string, percent: number) => void;
}

export interface ResolveOutcome {
    matches: PollDecisionsResult['matches'];
    unmatchedSubjects: PollDecisionsResult['unmatchedSubjects'];
    usage: Anthropic.Messages.Usage;
}

/**
 * The matching core: similarity -> candidate pool -> resolver LLM -> protocol
 * gap-fill. Exported so the matching eval CLI measures this exact path, not a
 * copy. Candidates split by phase-0 reading: `inMeeting` documents declare this
 * session (exact partition), `fallback` documents could not be read and go
 * through the legacy window-similarity flow. Protocol-chain gap-fill only ever
 * reasons over the fallback pool — for read documents the declared date already
 * settles meeting membership.
 */
export async function resolveMeetingDecisions(input: ResolveInput): Promise<ResolveOutcome> {
    const { subjects, inMeeting, fallback, diavgeiaUid, log } = input;
    const onProgress = input.onProgress ?? (() => {});

    const subjectLookup = new Map(subjects.map(s => [s.subjectId, s]));
    const linkedSubjects = subjects.filter(s => s.existingDecision);
    const unlinkedSubjects = subjects.filter(s => !s.existingDecision);
    const pooledDecisions = [...inMeeting, ...fallback];
    const declaredAdas = new Set(inMeeting.map(d => d.ada));

    const matches: PollDecisionsResult['matches'] = [];
    const unmatchedSubjects: PollDecisionsResult['unmatchedSubjects'] = [];
    let usage: Anthropic.Messages.Usage = { ...NO_USAGE };

    if (unlinkedSubjects.length === 0) {
        return { matches, unmatchedSubjects, usage };
    }
    if (pooledDecisions.length === 0) {
        // Nothing to offer the resolver — don't burn a call on an empty pool.
        for (const s of unlinkedSubjects) {
            unmatchedSubjects.push({ subjectId: s.subjectId, name: s.name, reason: 'No decisions available in the window' });
        }
        return { matches, unmatchedSubjects, usage };
    }

    // Step 2: Compute text similarity signals
    onProgress("computing signals", 15);
    const similarityMatrix = computeSimilarityMatrix(
        unlinkedSubjects.map(s => ({ subjectId: s.subjectId, name: s.name })),
        pooledDecisions,
    );

    // Step 3: Pre-resolver gap-fill from linked decisions (confirmed anchors).
    // Only the fallback pool needs it — read documents already declare their session.
    const declaredBoost = inMeeting.length > 0;
    const TOP_N = declaredBoost ? 8 : 5;

    const linkedProtocolNumbers: string[] = [];
    for (const s of linkedSubjects) {
        if (!s.existingDecision?.ada) continue;
        const d = pooledDecisions.find(d => d.ada === s.existingDecision!.ada);
        if (d?.protocolNumber) linkedProtocolNumbers.push(d.protocolNumber);
    }

    const preResolverGaps = fallback.length > 0
        ? await analyzeProtocolGaps(linkedProtocolNumbers, fallback, client, diavgeiaUid, log, 'Pre-resolver chain')
        : { gapCandidates: [], gapCandidateAdas: new Set<string>(), protocolAnalysis: null };

    // Build candidate pool: top-N by similarity + gap candidates from linked chain
    const candidatePool = buildCandidatePool({
        matrix: similarityMatrix,
        decisions: pooledDecisions,
        topN: TOP_N,
        gapCandidateAdas: preResolverGaps.gapCandidateAdas,
        declaredAdas,
    });

    // Build linked decisions context for resolver
    const linkedDecisions = [
        ...linkedSubjects.filter(s => s.existingDecision && !s.existingDecision.needsExtraction).map(s => ({
            subjectId: s.subjectId,
            subjectName: s.name,
            ada: s.existingDecision!.ada,
            decisionTitle: s.existingDecision!.decisionTitle,
            isReExtraction: false,
        })),
        ...subjects.filter(s => s.existingDecision?.needsExtraction).map(s => ({
            subjectId: s.subjectId,
            subjectName: s.name,
            ada: s.existingDecision!.ada,
            decisionTitle: s.existingDecision!.decisionTitle,
            isReExtraction: true,
        })),
    ];

    // Step 4: Single resolver LLM call
    onProgress("resolver matching", 30);
    const resolverPrompt = buildResolverPrompt({
        subjects: unlinkedSubjects.map(s => ({
            subjectId: s.subjectId,
            name: s.name,
            agendaItemIndex: s.agendaItemIndex,
            nonAgendaReason: s.nonAgendaReason ?? null,
        })),
        candidatePool,
        protocolAnalysis: preResolverGaps.protocolAnalysis,
        linkedDecisions,
    });

    const resolverStart = Date.now();
    const { result: resolverOutput, usage: resolverUsage } = await aiChat<ResolverOutput>({
        model: RESOLVER_MODEL,
        label: "decision-resolver",
        systemPrompt: RESOLVER_SYSTEM_PROMPT,
        userPrompt: resolverPrompt,
        outputFormat: {
            type: 'json_schema',
            schema: RESOLVER_OUTPUT_SCHEMA,
        },
    });
    usage = addUsage(usage, resolverUsage);

    // Step 5: Process resolver output
    const resolverResult = processResolverOutput({
        resolverOutput,
        candidatePool,
    });

    for (const u of resolverResult.unmatchedSubjects) {
        const reqSubject = subjectLookup.get(u.subjectId);
        if (reqSubject) u.name = reqSubject.name;
    }

    matches.push(...resolverResult.matches);
    unmatchedSubjects.push(...resolverResult.unmatchedSubjects);

    // Add subjects not mentioned by resolver to unmatched
    const resolverMentioned = new Set([
        ...resolverResult.matches.map(m => m.subjectId),
        ...resolverResult.unmatchedSubjects.map(u => u.subjectId),
    ]);
    for (const s of unlinkedSubjects) {
        if (!resolverMentioned.has(s.subjectId)) {
            unmatchedSubjects.push({ subjectId: s.subjectId, name: s.name, reason: 'Not mentioned in resolver output' });
        }
    }

    for (const w of resolverResult.warnings) {
        console.warn(`  \u26a0 ${w}`);
    }

    // Phase 1 summary — resolver results
    const totalCandidates = [...candidatePool.values()].reduce((sum, c) => sum + c.length, 0);
    const resolverElapsed = ((Date.now() - resolverStart) / 1000).toFixed(1);
    const confidenceCounts = { high: 0, medium: 0, low: 0 };
    for (const m of resolverOutput.matches) confidenceCounts[m.confidence]++;
    log(`=== PHASE 1: RESOLVE ===`);
    log(`  Pool: ${pooledDecisions.length} decisions (${inMeeting.length} declare this session, ${fallback.length} fallback)`);
    log(`  Candidate pool: ${unlinkedSubjects.length} subjects \u00d7 ${(totalCandidates / Math.max(unlinkedSubjects.length, 1)).toFixed(1)} avg candidates`);
    log(`  Resolver: ${matches.length} matched (${confidenceCounts.high} high, ${confidenceCounts.medium} medium, ${confidenceCounts.low} low), ${unmatchedSubjects.length} unmatched`);
    log(`  Resolver cost: ${resolverUsage.input_tokens.toLocaleString()} input, ${resolverUsage.output_tokens.toLocaleString()} output tokens (${resolverElapsed}s)`);
    for (const m of resolverResult.matches) {
        const reqSubject = subjectLookup.get(m.subjectId);
        const pos = reqSubject?.agendaItemIndex != null ? `#${reqSubject.agendaItemIndex}` : 'OA';
        log(`    ${pos} "${reqSubject?.name}" \u2192 ADA:${m.ada} (${m.matchConfidence.toFixed(2)}) \u2014 ${resolverOutput.matches.find(rm => rm.subjectId === m.subjectId)?.reasoning ?? ''}`);
    }
    for (const u of unmatchedSubjects) {
        log(`    "${u.name}" \u2192 unmatched \u2014 ${u.reason}`);
    }

    // Step 6: Post-resolver protocol number gap-fill — fallback pool only.
    if (unmatchedSubjects.length > 0 && fallback.length > 0) {
        const confirmedProtocolNumbers: string[] = [];
        for (const m of matches) {
            if (m.protocolNumber) confirmedProtocolNumbers.push(m.protocolNumber);
        }
        confirmedProtocolNumbers.push(...linkedProtocolNumbers);

        const postResolverGaps = await analyzeProtocolGaps(
            [...new Set(confirmedProtocolNumbers)], fallback, client, diavgeiaUid, log, 'Post-resolver chain',
        );

        // Second resolver pass: match remaining unmatched subjects against gap candidates
        const { gapCandidates } = postResolverGaps;
        if (gapCandidates.length > 0 && unmatchedSubjects.length > 0) {
            log(`  Gap-fill resolver: ${gapCandidates.length} candidates \u00d7 ${unmatchedSubjects.length} unmatched subjects`);

            const gapCandidateLines = gapCandidates.map(gc =>
                `  - ADA:${gc.decision.ada} protocol:${gc.protocolNumber} "${gc.decision.subject}"`
            ).join('\n');

            const unmatchedLines = unmatchedSubjects.map(s => {
                const reqSubject = subjectLookup.get(s.subjectId);
                const pos = reqSubject?.agendaItemIndex != null ? `#${reqSubject.agendaItemIndex}` : 'OA';
                return `  - [${s.subjectId}] ${pos} "${s.name}"`;
            }).join('\n');

            const gapResolverSystemPrompt = `You are matching unmatched Greek municipal council agenda subjects to GAP CANDIDATE decisions \u2014 decisions whose protocol numbers fill gaps in a confirmed sequential chain from this meeting.

CRITICAL CONTEXT: These gap candidates are CONFIRMED to belong to this meeting session by their protocol number position. The structural evidence (protocol number in the sequence) is very strong. You should match aggressively.

RULES:
- Gap candidates belong to this meeting \u2014 the protocol chain proves it. The only question is WHICH subject they correspond to.
- Greek municipal decision titles are often generic administrative language (e.g., "Approval for organizing artistic event (concert)") that doesn't name the specific event. This is normal \u2014 match by topic category (concert\u2192concert, workshop\u2192workshop, theater\u2192theater).
- Use elimination reasoning: if there are 2 gap candidates about concerts and 2 unmatched concert subjects, assign them. Don't leave them unmatched just because the title doesn't name the artist.
- Each decision can be assigned to at most one subject (1:1 mapping).
- Only leave a subject unmatched if no gap candidate is even in the same topic area (e.g., a concert subject and all gap candidates are about budget/administration).
- Provide reasoning for each match.

CONFIDENCE:
- "high": Topic clearly matches (concert\u2192concert, workshop\u2192workshop), even if title is generic.
- "medium": Topic is related but uncertain (children's event could be theater or concert).
- "low": Only use if the connection is very tenuous.`;

            const gapResolverPrompt = `UNMATCHED SUBJECTS:
${unmatchedLines}

GAP CANDIDATE DECISIONS (protocol numbers ${postResolverGaps.protocolAnalysis?.pattern ?? 'unknown'}):
${gapCandidateLines}`;

            const gapResolverStart = Date.now();
            const { result: gapResolverOutput, usage: gapResolverUsage } = await aiChat<ResolverOutput>({
                model: RESOLVER_MODEL,
                label: "protocol-gap-resolver",
                systemPrompt: gapResolverSystemPrompt,
                userPrompt: gapResolverPrompt,
                outputFormat: {
                    type: 'json_schema',
                    schema: RESOLVER_OUTPUT_SCHEMA,
                },
            });
            usage = addUsage(usage, gapResolverUsage);
            const gapDecisionByAda = new Map(gapCandidates.map(gc => [gc.decision.ada, gc]));

            for (const m of gapResolverOutput.matches) {
                const gc = gapDecisionByAda.get(m.ada);
                if (!gc) continue;
                // Only accept high/medium confidence from gap resolver
                if (m.confidence === 'low') {
                    log(`    Gap resolver: "${unmatchedSubjects.find(u => u.subjectId === m.subjectId)?.name}" \u2192 ADA:${m.ada} rejected (low confidence) \u2014 ${m.reasoning}`);
                    continue;
                }
                const matchedSubject = unmatchedSubjects.find(u => u.subjectId === m.subjectId);
                if (!matchedSubject) continue;

                matches.push({
                    subjectId: m.subjectId,
                    ada: gc.decision.ada,
                    decisionTitle: gc.decision.subject,
                    pdfUrl: decisionPdfUrl(gc.decision),
                    protocolNumber: gc.protocolNumber,
                    publishDate: msToISODate(gc.decision.publishTimestamp),
                    matchConfidence: m.confidence === 'high' ? 0.75 : 0.6,
                });
                const unmIdx = unmatchedSubjects.findIndex(u => u.subjectId === m.subjectId);
                if (unmIdx >= 0) unmatchedSubjects.splice(unmIdx, 1);
                log(`    Gap resolver: "${matchedSubject.name}" \u2192 ADA:${gc.decision.ada} (${m.confidence}) \u2014 ${m.reasoning}`);
            }

            for (const u of gapResolverOutput.unmatched) {
                const existing = unmatchedSubjects.find(s => s.subjectId === u.subjectId);
                if (existing) existing.reason = u.reasoning;
            }

            const gapResolverElapsed = ((Date.now() - gapResolverStart) / 1000).toFixed(1);
            log(`  Gap-fill resolver cost: ${gapResolverUsage.input_tokens.toLocaleString()} input, ${gapResolverUsage.output_tokens.toLocaleString()} output tokens (${gapResolverElapsed}s)`);
        }
    }

    return { matches, unmatchedSubjects, usage };
}

export const pollDecisions: Task<PollDecisionsRequest, PollDecisionsResult> = async (request, onProgress) => {
    let totalUsage: Anthropic.Messages.Usage = { ...NO_USAGE };
    const log = createScopedLogger.fromCallbackUrl(request.callbackUrl);

    log("Polling decisions from Diavgeia:", {
        diavgeiaUid: request.diavgeiaUid,
        diavgeiaUnitIds: request.diavgeiaUnitIds,
        meetingDate: request.meetingDate,
        subjectCount: request.subjects.length,
        peopleCount: request.people?.length ?? 0,
    });

    onProgress("fetching decisions", 5);

    // Date range: from the request's derived window when present, else the
    // legacy 45 days after the meeting date.
    const meetingDate = new Date(request.meetingDate);
    if (isNaN(meetingDate.getTime())) {
        throw new Error(`Invalid meeting date: ${request.meetingDate}`);
    }
    const fromDate = request.window?.fromDate ?? meetingDate.toISOString().split('T')[0];
    const toDate = request.window?.toDate ?? new Date(meetingDate.getTime() + 45 * 24 * 60 * 60 * 1000)
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

    log(`Fetched ${decisions.length} decisions from Diavgeia (${unitIds.length} unit query/queries)`);

    // --- Phase 0: read every candidate's own statement of its session ---
    onProgress("reading decisions", 10);
    const known = new Map((request.knownDecisions ?? []).map(k => [k.ada, k]));
    const READ_CONCURRENCY = 4;
    const reads: ReadDecision[] = [];
    let readCursor = 0;
    const readWorker = async () => {
        while (readCursor < decisions.length) {
            const d = decisions[readCursor++];
            const k = known.get(d.ada);
            if (k && k.readStatus !== 'unread') {
                // Already read on a previous poll — never pay twice. Only
                // 'unread' is retried; 'unreadable'/'no_meeting_date' recovery
                // is a prompt-version bump plus manual re-run.
                reads.push({
                    decision: d,
                    reading: k.meetingDate ? { meetingDate: k.meetingDate, decisionNumber: null } : null,
                    readStatus: k.readStatus,
                    fromKnown: true,
                });
                continue;
            }
            try {
                const { result } = await readDecisionDocument(decisionPdfUrl(d));
                reads.push({
                    decision: d,
                    reading: result,
                    readStatus: result.meetingDate ? 'ok' : 'no_meeting_date',
                    fromKnown: false,
                });
            } catch (e) {
                log(`  read failed for ${d.ada}: ${e instanceof Error ? e.message : e}`);
                reads.push({ decision: d, reading: null, readStatus: 'unreadable', fromKnown: false });
            }
        }
    };
    await Promise.all(Array.from({ length: READ_CONCURRENCY }, readWorker));

    const partition = partitionReadDecisions(reads, request.meetingDate);
    log(`=== PHASE 0: READ === ${reads.length} candidates: ${partition.inMeeting.length} declare this meeting, ${partition.elsewhere.length} another, ${partition.fallback.length} unreadable/unread (fallback pool)`);

    // Partition subjects
    const subjectLookup = new Map(request.subjects.map(s => [s.subjectId, s]));
    const linkedSubjects = request.subjects.filter(s => s.existingDecision);
    const unlinkedSubjects = request.subjects.filter(s => !s.existingDecision);

    const matches: PollDecisionsResult['matches'] = [];
    // Always empty since #617 phase 3: the pipeline never moves confirmed links.
    // The field survives for older app versions that still read it.
    const reassignments: PollDecisionsResult['reassignments'] = [];
    const unmatchedSubjects: PollDecisionsResult['unmatchedSubjects'] = [];
    const ambiguousSubjects: PollDecisionsResult['ambiguousSubjects'] = [];

    const resolveOutcome = await resolveMeetingDecisions({
        subjects: request.subjects,
        inMeeting: partition.inMeeting.map(r => r.decision),
        fallback: partition.fallback.map(r => r.decision),
        diavgeiaUid: request.diavgeiaUid,
        log,
        onProgress,
    });
    matches.push(...resolveOutcome.matches);
    unmatchedSubjects.push(...resolveOutcome.unmatchedSubjects);
    totalUsage = addUsage(totalUsage, resolveOutcome.usage);

    // --- Phase 2: Extract PDFs for newly matched subjects ---

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
        log(`\nExtracting ${allExtractionSubjects.length} decision PDFs (${extractionSubjects.length} new, ${needsExtractionSubjects.length} re-extraction)...`);

        // Build subject list for meeting-level attendance computation.
        // The pipeline uses this to compute effective attendance for ALL subjects
        // (including those without decisions) using the complete discussion order.
        let oaCounter = 0;
        const allMeetingSubjects = request.subjects.map(s => {
            const isOA = s.nonAgendaReason === 'outOfAgenda';
            if (isOA) oaCounter++;
            return {
                subjectId: s.subjectId,
                agendaItemIndex: s.agendaItemIndex,
                outOfAgendaIndex: isOA ? oaCounter : null,
            };
        });

        const pipelineResult = await extractDecisionsFromPdfs(
            allExtractionSubjects,
            allMeetingSubjects,
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

        // --- subjectInfo mismatch warnings (informational only) ---
        // Compare extracted subjectInfo against actual agenda positions.
        // Mismatches are logged as warnings but matches are preserved.
        const reExtractionIds = new Set(needsExtractionSubjects.map(s => s.subjectId));
        for (const extraction of pipelineResult.decisions) {
            if (!extraction.subjectInfo) continue;
            if (reExtractionIds.has(extraction.subjectId)) continue;

            const reqSubject = subjectLookup.get(extraction.subjectId);
            if (!reqSubject) continue;

            const match = matches.find(m => m.subjectId === extraction.subjectId);
            const expectedIndex = reqSubject.agendaItemIndex;
            const isOutOfAgenda = expectedIndex == null;
            const pdfNumber = extraction.subjectInfo.number;
            const pdfIsOA = extraction.subjectInfo.isOutOfAgenda;

            let mismatch: string | null = null;
            if (isOutOfAgenda && !pdfIsOA) {
                mismatch = `PDF says regular item #${pdfNumber}, but subject is out-of-agenda`;
            } else if (!isOutOfAgenda && pdfIsOA) {
                mismatch = `PDF says out-of-agenda, but subject is regular item #${expectedIndex}`;
            } else if (!isOutOfAgenda && !pdfIsOA && pdfNumber !== expectedIndex) {
                mismatch = `PDF says item #${pdfNumber}, actual agenda position is #${expectedIndex}`;
            }

            if (mismatch) {
                const ada = match?.ada ?? 'unknown';
                const pdfUrl = match?.pdfUrl ?? 'unknown';
                const confidence = match?.matchConfidence?.toFixed(2) ?? 'N/A';
                pipelineResult.warnings.push(
                    `subjectInfo mismatch for "${reqSubject.name}" (ADA: ${ada}, ${pdfUrl}): ${mismatch}. Match preserved (confidence: ${confidence}).`
                );
            }
        }

        // Enrich extraction results with Diavgeia metadata for needsExtraction subjects
        const diavgeiaMetadata = await metadataPromise;
        for (const decision of pipelineResult.decisions) {
            const meta = diavgeiaMetadata.get(decision.subjectId);
            if (meta) {
                decision.diavgeiaTitle = meta.title;
                decision.diavgeiaPublishDate = meta.publishDate;
                // Diavgeia's protocol field travels separately from the PDF-extracted
                // decision number: they are different identifiers in most municipalities,
                // and the app mirrors one while rendering the other.
                decision.diavgeiaProtocolNumber = meta.protocolNumber || undefined;
            }
        }

        // Compute nonDecisionSubjectAttendance: effective attendance for subjects
        // NOT extracted in this run. This includes subjects with linked decisions from
        // previous runs — their attendance is safe to update because the effective
        // attendance computation uses meeting-level data (roll call + attendance changes)
        // that is the same regardless of how many PDFs were extracted.
        const extractedSubjectIds = new Set(pipelineResult.decisions.map(d => d.subjectId));
        const finalNonDecisionAttendance = pipelineResult.allSubjectAttendance
            .filter(a => !extractedSubjectIds.has(a.subjectId));

        // Phase 2 summary
        log(`=== PHASE 2: EXTRACT ===`);
        log(`  PDFs: ${allExtractionSubjects.length} (${extractionSubjects.length} new, ${needsExtractionSubjects.length} re-extraction)`);
        log(`  Extracted: ${pipelineResult.decisions.length}/${allExtractionSubjects.length}`);
        log(`  Attendance computed: ${pipelineResult.allSubjectAttendance.length} subjects (${finalNonDecisionAttendance.length} non-decision)`);
        if (pipelineResult.warnings.length > 0) {
            log(`  Warnings: ${pipelineResult.warnings.length}`);
            for (const w of pipelineResult.warnings) {
                log(`    ${w}`);
            }
        }

        extractionResult = {
            decisions: pipelineResult.decisions,
            warnings: pipelineResult.warnings,
            initialAttendance: pipelineResult.initialAttendance,
            unmatchedInitialAttendance: pipelineResult.unmatchedInitialAttendance,
            nonDecisionSubjectAttendance: finalNonDecisionAttendance,
        };
    } else if (allExtractionSubjects.length > 0 && (!request.people || request.people.length === 0)) {
        log(`Skipping extraction: no people provided for name matching`);
    }

    // Ensure metadata promise settles even if extraction was skipped
    await metadataPromise;

    onProgress("complete", 100);

    // Phase 3 summary
    log(`=== PHASE 3: FINALIZE ===`);
    log(`  Non-decision attendance: ${extractionResult?.nonDecisionSubjectAttendance?.length ?? 0} subjects`);

    // Per-subject journey
    log(`=== SUBJECT JOURNEY ===`);
    for (const subject of request.subjects) {
        const match = matches.find(m => m.subjectId === subject.subjectId);
        const extraction = extractionResult?.decisions.find(d => d.subjectId === subject.subjectId);
        const nonDecAtt = extractionResult?.nonDecisionSubjectAttendance?.find(a => a.subjectId === subject.subjectId);
        const posLabel = subject.agendaItemIndex != null ? `#${subject.agendaItemIndex}` : 'OA';

        let journey = `  ${posLabel} "${subject.name}"`;
        if (subject.existingDecision && !match) {
            journey += ` → linked(existing)`;
        } else if (match) {
            journey += ` → resolved(${match.matchConfidence.toFixed(2)}) → ADA:${match.ada}`;
        } else {
            journey += ` → unmatched`;
        }
        if (extraction) {
            journey += ` → extracted → ${extraction.presentMemberIds.length}p/${extraction.absentMemberIds.length}a`;
        } else if (nonDecAtt) {
            journey += ` → attendance(${nonDecAtt.presentMemberIds.length}p/${nonDecAtt.absentMemberIds.length}a)`;
        }
        log(journey);
    }

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
