import Anthropic from '@anthropic-ai/sdk';
import { addUsage, NO_USAGE } from '../../lib/ai.js';
import { ExtractedDecisionResult } from '../../types.js';
import {
    extractDecisionFromPdf,
    RawExtractedDecision,
    AttendanceChange,
    matchPersonByName,
    llmMatchMembers,
    inferForVotes,
    PersonForMatching,
} from './decisionPdfExtraction.js';
import { computeEffectiveAttendance } from './effectiveAttendance.js';

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
}

const BATCH_SIZE = 5;

/**
 * Extract structured decision data from PDFs.
 *
 * Each PDF is self-contained for effective attendance: the agenda item list
 * is derived from the PDF's own attendanceChanges, discussionOrder, and
 * subjectInfo rather than requiring external context.
 */
export async function extractDecisionsFromPdfs(
    subjects: ExtractionSubject[],
    people: PersonForMatching[],
    onProgress: (stage: string, percent: number) => void,
): Promise<ExtractionPipelineResult> {
    const taskStart = Date.now();
    const warnings: string[] = [];
    let totalUsage: Anthropic.Messages.Usage = { ...NO_USAGE };

    console.log(`\n--- extractDecisionsFromPdfs ---`);
    console.log(`Subjects with decisions: ${subjects.length}`);
    console.log(`People for matching: ${people.length}`);

    if (subjects.length === 0) {
        return { decisions: [], warnings: [], usage: totalUsage };
    }

    // --- Phase 1: Extract all PDFs (batched for concurrency) ---
    const extractions: { subjectId: string; agendaItemIndex: number | null; raw: RawExtractedDecision; usage: Anthropic.Messages.Usage }[] = [];
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
                const { result: raw, usage: pdfUsage } = await extractDecisionFromPdf(pdfUrl);
                const elapsed = ((Date.now() - pdfStart) / 1000).toFixed(1);

                console.log(`  Excerpt: ${raw.decisionExcerpt?.length ?? 0} chars`);
                console.log(`  Vote: ${raw.voteResult ?? '(none)'}`);
                console.log(`  Present: ${raw.presentMembers?.length ?? 0}, Absent: ${raw.absentMembers?.length ?? 0}`);
                console.log(`  SubjectInfo: ${raw.subjectInfo ? `#${raw.subjectInfo.number}${raw.subjectInfo.isOutOfAgenda ? ' (out-of-agenda)' : ''}` : '(none)'}`);
                console.log(`  Done in ${elapsed}s`);

                return { subjectId: subject.subjectId, agendaItemIndex: subject.agendaItemIndex, raw, usage: pdfUsage };
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
                console.error(`  [PDF ${i + j + 1}] FAILED: ${msg}`);
                warnings.push(`Failed to extract data from decision PDF for "${subject.name}": ${msg}`);
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
        const matchedIds = new Set(nameToPersonId.values());
        const availablePeople = people.filter(p => !matchedIds.has(p.id));

        try {
            const llmResult = await llmMatchMembers(step1Unmatched, availablePeople);
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

    // --- Phase 3: Build decision results using the name→personId map ---
    // Each PDF is self-contained: build allAgendaItemNumbers from its own data
    const decisions: ExtractedDecisionResult[] = [];

    for (const { subjectId, agendaItemIndex, raw } of extractions) {
        const unmatchedMembers: string[] = [];

        // Determine target agenda item number: prefer PDF's subjectInfo, fall back to request
        const targetAgendaItemNumber = raw.subjectInfo?.number ?? agendaItemIndex;

        // Build allAgendaItemNumbers from this PDF's own data (self-contained)
        const agendaItemNumbersFromPdf = new Set<number>();
        if (targetAgendaItemNumber != null) {
            agendaItemNumbersFromPdf.add(targetAgendaItemNumber);
        }
        for (const change of raw.attendanceChanges || []) {
            if (change.duringAgendaItem != null) {
                agendaItemNumbersFromPdf.add(change.duringAgendaItem);
            }
        }
        if (raw.discussionOrder) {
            for (const n of raw.discussionOrder) {
                agendaItemNumbersFromPdf.add(n);
            }
        }

        // Compute effective attendance for this subject
        const meetingAttendanceChanges = raw.attendanceChanges || [];
        const meetingDiscussionOrder = raw.discussionOrder ?? null;

        const effective = targetAgendaItemNumber != null
            ? computeEffectiveAttendance({
                initialPresent: raw.presentMembers || [],
                initialAbsent: raw.absentMembers || [],
                attendanceChanges: meetingAttendanceChanges,
                discussionOrder: meetingDiscussionOrder,
                allAgendaItemNumbers: [...agendaItemNumbersFromPdf],
                targetAgendaItemNumber,
            })
            : { presentNames: raw.presentMembers || [], absentNames: raw.absentMembers || [] };

        const presentMemberIds: string[] = [];
        const absentMemberIds: string[] = [];

        for (const name of effective.presentNames) {
            const personId = nameToPersonId.get(name);
            if (personId) presentMemberIds.push(personId);
            else unmatchedMembers.push(name);
        }

        for (const name of effective.absentNames) {
            const personId = nameToPersonId.get(name);
            if (personId) absentMemberIds.push(personId);
            else unmatchedMembers.push(name);
        }

        // Infer FOR votes for majority decisions using effective present members
        const { voteDetails: inferredVoteDetails, inferredCount } = inferForVotes(
            effective.presentNames,
            raw.voteResult,
            raw.voteDetails || [],
        );
        if (inferredCount > 0) {
            console.log(`  [${subjectId}] Inferred ${inferredCount} FOR votes from effective present members`);
        }

        const voteDetails: ExtractedDecisionResult['voteDetails'] = [];
        for (const detail of inferredVoteDetails) {
            const personId = nameToPersonId.get(detail.name);
            if (personId) {
                voteDetails.push({ personId, vote: detail.vote });
            } else {
                unmatchedMembers.push(detail.name);
            }
        }

        decisions.push({
            subjectId,
            excerpt: raw.decisionExcerpt || '',
            references: raw.references || '',
            presentMemberIds,
            absentMemberIds,
            voteResult: raw.voteResult || null,
            voteDetails,
            unmatchedMembers: [...new Set(unmatchedMembers)],
            subjectInfo: raw.subjectInfo || null,
        });

        console.log(`  [${subjectId}] ${presentMemberIds.length} present, ${absentMemberIds.length} absent, ${unmatchedMembers.length} unmatched, ${voteDetails.length} votes`);
    }

    const totalElapsed = ((Date.now() - taskStart) / 1000).toFixed(1);
    console.log(`\n--- extractDecisionsFromPdfs DONE (${totalElapsed}s) ---`);
    console.log(`  Extracted: ${extractions.length}/${subjects.length}`);
    console.log(`  Warnings: ${warnings.length}`);

    return { decisions, warnings, usage: totalUsage };
}
