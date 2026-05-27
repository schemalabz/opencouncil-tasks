import Anthropic from '@anthropic-ai/sdk';
import { addUsage, NO_USAGE } from '../../lib/ai.js';
import { ExtractedDecisionResult } from '../../types.js';
import {
    extractDecisionFromPdf,
    RawExtractedDecision,
    matchPersonByName,
    llmMatchMembers,
    PersonForMatching,
    AgendaItemRef,
} from './decisionPdfExtraction.js';
import { resolveAndDeduplicateAttendanceChanges, computeAllSubjectAttendance, SubjectForAttendance, MeetingAttendanceData } from './meetingAttendance.js';
import { selectDiscussionOrder } from './discussionOrderVote.js';
import { validateRawExtraction, validateProcessedDecision } from './decisionValidation.js';

export interface ExtractionSubject {
    subjectId: string;
    name: string;
    agendaItemIndex: number | null;
    decision: {
        pdfUrl: string;
        ada: string | null;
        protocolNumber: string | null;
    };
}

export interface ExtractionPipelineResult {
    decisions: ExtractedDecisionResult[];
    warnings: string[];
    usage: Anthropic.Messages.Usage;
    /** Initial roll call — who was present/absent at session start (meeting-level, not per-subject) */
    initialAttendance: { personId: string; status: 'PRESENT' | 'ABSENT' }[];
    /** Names from the initial roll call that couldn't be matched to any person in the database */
    unmatchedInitialAttendance: string[];
    /** Per-subject effective attendance for subjects without decisions in the extraction */
    nonDecisionSubjectAttendance: Array<{
        subjectId: string;
        presentMemberIds: string[];
        absentMemberIds: string[];
    }>;
    /** Per-subject effective attendance for ALL subjects (used by caller to recompute non-decision filter after post-processing) */
    allSubjectAttendance: Array<{
        subjectId: string;
        presentMemberIds: string[];
        absentMemberIds: string[];
    }>;
}

const BATCH_SIZE = 5;

/**
 * Extract structured decision data from PDFs.
 *
 * Attendance and vote inference use meeting-level data: attendance changes
 * and discussion order are aggregated from all PDFs, names are resolved to
 * canonical forms, and effective attendance is computed once per subject
 * using the complete discussion order. Vote inference (FOR votes for
 * unanimous/majority decisions) uses the meeting-level effective attendance.
 *
 * @param subjects - Subjects with linked decisions (have PDF URLs)
 * @param allMeetingSubjects - ALL subjects in the meeting (for discussion order + non-decision attendance)
 * @param people - People for name matching
 */
export async function extractDecisionsFromPdfs(
    subjects: ExtractionSubject[],
    allMeetingSubjects: SubjectForAttendance[],
    people: PersonForMatching[],
    onProgress: (stage: string, percent: number) => void,
    mayorId?: string,
    skipCache?: boolean,
): Promise<ExtractionPipelineResult> {
    const taskStart = Date.now();
    const warnings: string[] = [];
    let totalUsage: Anthropic.Messages.Usage = { ...NO_USAGE };

    const mayorName = mayorId
        ? people.find(p => p.id === mayorId)?.name
        : undefined;

    console.log(`\n--- extractDecisionsFromPdfs ---`);
    console.log(`Subjects with decisions: ${subjects.length}`);
    console.log(`People for matching: ${people.length}`);
    if (mayorName) console.log(`Mayor: ${mayorName} (${mayorId})`);

    if (subjects.length === 0) {
        return { decisions: [], warnings: [], usage: totalUsage, initialAttendance: [], unmatchedInitialAttendance: [], nonDecisionSubjectAttendance: [], allSubjectAttendance: [] };
    }

    // --- Phase 1: Extract all PDFs (batched for concurrency) ---
    const extractions: { subjectId: string; agendaItemIndex: number | null; raw: RawExtractedDecision; usage: Anthropic.Messages.Usage; fromCache: boolean }[] = [];
    let completed = 0;

    for (let i = 0; i < subjects.length; i += BATCH_SIZE) {
        const batch = subjects.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.allSettled(
            batch.map(async (subject, batchIdx) => {
                const idx = i + batchIdx;
                const pdfUrl = subject.decision.pdfUrl;
                console.log(`\n[PDF ${idx + 1}/${subjects.length}] Subject: "${subject.name}"`);
                console.log(`  URL: ${pdfUrl}`);

                const pdfStart = Date.now();
                const { result: raw, usage: pdfUsage, fromCache } = await extractDecisionFromPdf(pdfUrl, mayorName, skipCache);
                const elapsed = ((Date.now() - pdfStart) / 1000).toFixed(1);

                console.log(`  Excerpt: ${raw.decisionExcerpt?.length ?? 0} chars`);
                console.log(`  Vote: ${raw.voteResult ?? '(none)'}`);
                console.log(`  Present: ${raw.presentMembers?.length ?? 0}, Absent: ${raw.absentMembers?.length ?? 0}`);
                console.log(`  SubjectInfo: ${raw.subjectInfo ? `#${raw.subjectInfo.agendaItemIndex}${raw.subjectInfo.nonAgendaReason ? ' (out-of-agenda)' : ''}` : '(none)'}`);
                if (fromCache) console.log(`  (from cache)`);
                console.log(`  Done in ${elapsed}s`);

                return { subjectId: subject.subjectId, agendaItemIndex: subject.agendaItemIndex, raw, usage: pdfUsage, fromCache };
            })
        );

        for (let j = 0; j < batchResults.length; j++) {
            const result = batchResults[j];
            if (result.status === 'fulfilled') {
                extractions.push(result.value);
                totalUsage = addUsage(totalUsage, result.value.usage);
            } else {
                const subject = batch[j];
                const msg = result.reason instanceof Error ? result.reason.message : 'Unknown error';
                console.error(`  [PDF ${i + j + 1}] FAILED for "${subject.name}" (${subject.decision.pdfUrl}): ${msg}`);
                warnings.push(`Failed to extract data from decision PDF for "${subject.name}" (${subject.decision.pdfUrl}): ${msg}`);
            }
        }

        completed += batch.length;
        const progressPercent = (completed / subjects.length) * 100;
        onProgress(`extracted ${completed}/${subjects.length} PDFs`, progressPercent);
    }

    // --- Phase 2: Meeting-level name matching ---
    onProgress('matching members', 100);

    // Collect all unique raw names across all decisions + attendance changes
    const allRawNames = new Set<string>();
    for (const { raw } of extractions) {
        for (const name of raw.presentMembers || []) allRawNames.add(name);
        for (const name of raw.absentMembers || []) allRawNames.add(name);
        for (const detail of raw.voteDetails || []) allRawNames.add(detail.name);
        for (const change of raw.attendanceChanges || []) allRawNames.add(change.name);
    }

    // Step 1: Token-sort matching — build name→personId map
    const nameToPersonId = new Map<string, string>();
    for (const rawName of allRawNames) {
        const personId = matchPersonByName(rawName, people);
        if (personId) {
            nameToPersonId.set(rawName, personId);
        }
    }
    const step1Unmatched = [...allRawNames].filter(n => !nameToPersonId.has(n));

    console.log(`\n--- Meeting-level matching ---`);
    console.log(`  Unique names: ${allRawNames.size}`);
    console.log(`  Token-sort matched: ${nameToPersonId.size}`);
    console.log(`  Remaining for LLM: ${step1Unmatched.length}`);

    // Step 2: LLM fallback for remaining unmatched
    if (step1Unmatched.length > 0) {
        try {
            const llmResult = await llmMatchMembers(step1Unmatched, people);
            totalUsage = addUsage(totalUsage, llmResult.usage);
            for (const { name, personId } of llmResult.matched) {
                nameToPersonId.set(name, personId);
            }
            console.log(`  LLM matched: ${llmResult.matched.length}`);
            console.log(`  Still unmatched: ${llmResult.stillUnmatched.length}`);
            if (llmResult.stillUnmatched.length > 0) {
                console.log(`  Unmatched names: ${llmResult.stillUnmatched.join(', ')}`);
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            console.warn(`  LLM matching failed: ${msg}`);
            warnings.push(`LLM name matching failed: ${msg}`);
        }
    }

    console.log(`  Final matched: ${nameToPersonId.size}/${allRawNames.size}`);

    const firstWithRoll = extractions.find(e => (e.raw.presentMembers?.length ?? 0) > 0 || (e.raw.absentMembers?.length ?? 0) > 0);

    // --- Aggregate meeting-level attendance data from all PDFs ---
    // All PDFs from the same meeting share the same attendance preamble.
    // See resolveAndDeduplicateAttendanceChanges for the resolution strategy.
    let meetingAttendanceData: MeetingAttendanceData | null = null;
    if (firstWithRoll) {
        const allInitialNames = [...(firstWithRoll.raw.presentMembers || []), ...(firstWithRoll.raw.absentMembers || [])];
        const aggregatedChanges = resolveAndDeduplicateAttendanceChanges(extractions, nameToPersonId, allInitialNames);

        // Select discussion order by majority vote across PDFs
        const discussionOrderVote = selectDiscussionOrder(
            extractions.map(({ raw }) => raw.discussionOrder),
        );
        const bestDiscussionOrder = discussionOrderVote.selected;

        // Log vote breakdown
        const nonNullCount = discussionOrderVote.totalPdfs - discussionOrderVote.nullCount;
        if (nonNullCount > 0) {
            const selectedLabel = bestDiscussionOrder
                ? `selected (${discussionOrderVote.breakdown[0].count}/${nonNullCount} agree)`
                : 'no consensus → natural order';
            console.log(`  Discussion order vote: ${selectedLabel}`);
            for (const { order, count } of discussionOrderVote.breakdown) {
                const refs = order.map(r => r.nonAgendaReason === 'outOfAgenda' ? `OA${r.agendaItemIndex}` : `#${r.agendaItemIndex}`);
                console.log(`    ${count}× [${refs.join(', ')}]`);
            }
            if (discussionOrderVote.nullCount > 0) {
                console.log(`    ${discussionOrderVote.nullCount}× null`);
            }
        }

        meetingAttendanceData = {
            initialPresent: firstWithRoll.raw.presentMembers || [],
            initialAbsent: firstWithRoll.raw.absentMembers || [],
            attendanceChanges: aggregatedChanges,
            discussionOrder: bestDiscussionOrder,
            nameToPersonId,
        };

        // Log attendance changes after resolution
        if (aggregatedChanges.length > 0) {
            console.log(`  Attendance changes (${aggregatedChanges.length} after resolution/dedup):`);
            for (const change of aggregatedChanges) {
                const personId = nameToPersonId.get(change.name);
                const status = personId ? '✓' : '✗ unmatched';
                const agendaLabel = change.agendaItem
                    ? `${change.timing} ${change.agendaItem.nonAgendaReason === 'outOfAgenda' ? 'OA' : '#'}${change.agendaItem.agendaItemIndex}`
                    : 'session';
                console.log(`    ${change.type} "${change.name}" ${agendaLabel} ${status}`);
            }
        }
    }

    // --- Build meeting-level initial attendance from the first extraction with roll call data ---
    // All PDFs from the same meeting have the same initial roll, so we use the first one.
    const initialAttendance: ExtractionPipelineResult['initialAttendance'] = [];
    const unmatchedInitialAttendance: string[] = [];
    if (firstWithRoll) {
        for (const name of firstWithRoll.raw.presentMembers || []) {
            const personId = nameToPersonId.get(name);
            if (personId) initialAttendance.push({ personId, status: 'PRESENT' });
            else unmatchedInitialAttendance.push(name);
        }
        for (const name of firstWithRoll.raw.absentMembers || []) {
            const personId = nameToPersonId.get(name);
            if (personId) initialAttendance.push({ personId, status: 'ABSENT' });
            else unmatchedInitialAttendance.push(name);
        }
        // Include mayor if extracted from decision narrative
        let mayorAdded = false;
        if (firstWithRoll.raw.mayorPresent?.present != null && mayorId) {
            if (!initialAttendance.some(a => a.personId === mayorId)) {
                initialAttendance.push({ personId: mayorId, status: firstWithRoll.raw.mayorPresent.present ? 'PRESENT' : 'ABSENT' });
                mayorAdded = true;
            }
        }
        const presentCount = initialAttendance.filter(a => a.status === 'PRESENT').length;
        const absentCount = initialAttendance.filter(a => a.status === 'ABSENT').length;
        const totalExtracted = (firstWithRoll.raw.presentMembers?.length ?? 0) + (firstWithRoll.raw.absentMembers?.length ?? 0);
        const matchedCount = presentCount + absentCount;
        const mayorNote = mayorAdded ? ' (includes mayor from narrative)' : '';
        console.log(`  Initial attendance: ${presentCount} present, ${absentCount} absent — ${matchedCount} matched from ${totalExtracted} extracted${mayorNote}`);
        if (unmatchedInitialAttendance.length > 0) {
            console.warn(`  ⚠ ${unmatchedInitialAttendance.length} unmatched members in initial roll call:`);
            for (const name of unmatchedInitialAttendance) {
                console.warn(`    - "${name}"`);
            }
        }
    }

    // --- Phase 3: Compute meeting-level attendance for all subjects ---
    // Uses the aggregated attendance data (resolved names, complete discussion order)
    // to compute effective attendance consistently for every subject.
    const attendanceBySubject = new Map<string, { presentMemberIds: string[]; absentMemberIds: string[] }>();
    let nonDecisionSubjectAttendance: ExtractionPipelineResult['nonDecisionSubjectAttendance'] = [];
    let allSubjectAttendance: ExtractionPipelineResult['allSubjectAttendance'] = [];

    if (meetingAttendanceData) {
        const allAttendance = computeAllSubjectAttendance(allMeetingSubjects, meetingAttendanceData);
        allSubjectAttendance = allAttendance;
        for (const a of allAttendance) {
            attendanceBySubject.set(a.subjectId, { presentMemberIds: a.presentMemberIds, absentMemberIds: a.absentMemberIds });
        }
        const decisionSubjectIds = new Set(extractions.map(e => e.subjectId));
        nonDecisionSubjectAttendance = allAttendance.filter(a => !decisionSubjectIds.has(a.subjectId));
        console.log(`  Computed attendance for ${allAttendance.length} subjects (${nonDecisionSubjectAttendance.length} without decisions)`);
    }

    // --- Phase 4: Build decision results ---
    // Combines raw PDF content (excerpt, explicit votes) with meeting-level
    // attendance. Vote inference uses the meeting-level present list.
    const decisions: ExtractedDecisionResult[] = [];

    for (const { subjectId, raw, fromCache } of extractions) {
        const unmatchedMembers: string[] = [];

        // Attendance: use meeting-level if available, otherwise raw from PDF
        const attendance = attendanceBySubject.get(subjectId);
        let presentMemberIds: string[];
        let absentMemberIds: string[];
        if (attendance) {
            presentMemberIds = attendance.presentMemberIds;
            absentMemberIds = attendance.absentMemberIds;
        } else {
            // Fallback: convert raw names to personIds (no attendance changes applied)
            presentMemberIds = [];
            absentMemberIds = [];
            for (const name of raw.presentMembers || []) {
                const personId = nameToPersonId.get(name);
                if (personId) presentMemberIds.push(personId);
                else unmatchedMembers.push(name);
            }
            for (const name of raw.absentMembers || []) {
                const personId = nameToPersonId.get(name);
                if (personId) absentMemberIds.push(personId);
                else unmatchedMembers.push(name);
            }
        }

        // Explicit votes from PDF (AGAINST, ABSTAIN, PRESENT, DID_NOT_VOTE)
        // Resolve names to personIds, deduplicate
        const voteDetails: ExtractedDecisionResult['voteDetails'] = [];
        const seenVoterIds = new Set<string>();
        for (const detail of raw.voteDetails || []) {
            const personId = nameToPersonId.get(detail.name);
            if (personId) {
                if (!seenVoterIds.has(personId)) {
                    seenVoterIds.add(personId);
                    voteDetails.push({ personId, vote: detail.vote });
                }
            } else {
                unmatchedMembers.push(detail.name);
            }
        }

        // Infer FOR votes for unanimous/majority decisions using meeting-level attendance
        const isUnanimous = raw.voteResult && /[οό]μ[οό]φων/i.test(raw.voteResult);
        const isMajority = raw.voteResult && /κατ[άα]\s+πλειοψηφ[ίι]/i.test(raw.voteResult);
        const hasNoForVotes = voteDetails.every(v => v.vote !== 'FOR');

        let inferredVoteCount = 0;
        if ((isUnanimous || isMajority) && hasNoForVotes && presentMemberIds.length > 0) {
            for (const personId of presentMemberIds) {
                if (!seenVoterIds.has(personId)) {
                    seenVoterIds.add(personId);
                    voteDetails.push({ personId, vote: 'FOR' });
                    inferredVoteCount++;
                }
            }
        }
        if (inferredVoteCount > 0) {
            console.log(`  [${subjectId}] Inferred ${inferredVoteCount} FOR votes from effective present members`);
        }

        const dedupedUnmatched = [...new Set(unmatchedMembers)];

        // Validate raw extraction and post-processing
        const rawWarnings = validateRawExtraction(raw);
        const processedWarnings = validateProcessedDecision({
            voteResult: raw.voteResult,
            voteDetails: voteDetails.map(v => ({ vote: v.vote })),
        });
        const decisionWarnings = [...rawWarnings, ...processedWarnings];

        decisions.push({
            subjectId,
            excerpt: raw.decisionExcerpt || '',
            references: raw.references || '',
            presentMemberIds,
            absentMemberIds,
            mayorPresent: raw.mayorPresent?.present ?? undefined,
            voteResult: raw.voteResult || null,
            voteDetails,
            unmatchedMembers: dedupedUnmatched,
            subjectInfo: raw.subjectInfo
                ? { number: raw.subjectInfo.agendaItemIndex, isOutOfAgenda: raw.subjectInfo.nonAgendaReason !== null }
                : null,
            fromCache,
            warnings: decisionWarnings,
            protocolNumber: raw.decisionNumber || null,
        });

        console.log(`  [${subjectId}] ${presentMemberIds.length} present, ${absentMemberIds.length} absent, ${voteDetails.length} votes`);
        if (dedupedUnmatched.length > 0) {
            console.warn(`  ⚠ [${subjectId}] ${dedupedUnmatched.length} unmatched members: ${dedupedUnmatched.map(n => `"${n}"`).join(', ')}`);
        }
    }

    const totalElapsed = ((Date.now() - taskStart) / 1000).toFixed(1);
    console.log(`\n--- extractDecisionsFromPdfs DONE (${totalElapsed}s) ---`);
    console.log(`  Extracted: ${extractions.length}/${subjects.length}`);
    console.log(`  Warnings: ${warnings.length}`);

    return { decisions, warnings, usage: totalUsage, initialAttendance, unmatchedInitialAttendance, nonDecisionSubjectAttendance, allSubjectAttendance };
}
