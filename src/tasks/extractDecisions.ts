import { Task } from './pipeline.js';
import { ExtractDecisionsRequest, ExtractDecisionsResult, ExtractedDecisionResult } from '../types.js';
import { extractDecisionFromPdf, RawExtractedDecision, AttendanceChange, matchPersonByName, llmMatchMembers, inferForVotes } from './utils/decisionPdfExtraction.js';
import { computeEffectiveAttendance } from './utils/effectiveAttendance.js';

export { extractDecisionFromPdf };

export const extractDecisions: Task<ExtractDecisionsRequest, ExtractDecisionsResult> = async (request, onProgress) => {
    const taskStart = Date.now();
    const warnings: string[] = [];

    console.log(`\n========== extractDecisions ==========`);
    console.log(`Meeting: ${request.cityId}/${request.meetingId}`);
    console.log(`Subjects with decisions: ${request.subjects.length}`);
    console.log(`People for matching: ${request.people.length}`);
    console.log(`======================================\n`);

    // --- Phase 1: Extract all PDFs (batched for concurrency) ---
    const BATCH_SIZE = 5;
    const extractions: { subjectId: string; raw: RawExtractedDecision }[] = [];
    let completed = 0;

    for (let i = 0; i < request.subjects.length; i += BATCH_SIZE) {
        const batch = request.subjects.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.allSettled(
            batch.map(async (subject, batchIdx) => {
                const idx = i + batchIdx;
                const pdfUrl = subject.decision.pdfUrl;
                console.log(`\n[PDF ${idx + 1}/${request.subjects.length}] Subject: "${subject.name}"`);
                console.log(`  URL: ${pdfUrl}`);

                const pdfStart = Date.now();
                const raw = await extractDecisionFromPdf(pdfUrl);
                const elapsed = ((Date.now() - pdfStart) / 1000).toFixed(1);

                console.log(`  Excerpt: ${raw.decisionExcerpt?.length ?? 0} chars`);
                console.log(`  Vote: ${raw.voteResult ?? '(none)'}`);
                console.log(`  Present: ${raw.presentMembers?.length ?? 0}, Absent: ${raw.absentMembers?.length ?? 0}`);
                console.log(`  Done in ${elapsed}s`);

                return { subjectId: subject.subjectId, raw };
            })
        );

        for (let j = 0; j < batchResults.length; j++) {
            const result = batchResults[j];
            if (result.status === 'fulfilled') {
                extractions.push(result.value);
            } else {
                const subject = batch[j];
                const msg = result.reason instanceof Error ? result.reason.message : 'Unknown error';
                console.error(`  [PDF ${i + j + 1}] FAILED: ${msg}`);
                warnings.push(`Failed to extract data from decision PDF for "${subject.name}": ${msg}`);
            }
        }

        completed += batch.length;
        const progressPercent = (completed / request.subjects.length) * 80;
        onProgress(`extracted ${completed}/${request.subjects.length} PDFs`, progressPercent);
    }

    // --- Extract meeting-level attendance changes and discussion order ---
    // These are the same across all PDFs for a meeting (initial roll call is identical).
    // Use the first successful extraction as the source.
    let meetingAttendanceChanges: AttendanceChange[] = [];
    let meetingDiscussionOrder: number[] | null = null;

    if (extractions.length > 0) {
        meetingAttendanceChanges = extractions[0].raw.attendanceChanges || [];
        meetingDiscussionOrder = extractions[0].raw.discussionOrder ?? null;

        if (meetingAttendanceChanges.length > 0) {
            console.log(`\n--- Attendance changes (from first PDF) ---`);
            for (const change of meetingAttendanceChanges) {
                const where = change.duringAgendaItem != null
                    ? `during item #${change.duringAgendaItem}`
                    : change.atSessionBoundary
                        ? `at session ${change.atSessionBoundary}`
                        : 'unknown';
                console.log(`  ${change.type}: ${change.name} (${where})`);
            }
        }
        if (meetingDiscussionOrder) {
            console.log(`\n--- Discussion order: ${meetingDiscussionOrder.join(', ')} ---`);
        }
    }

    // --- Phase 2: Match all names at meeting level ---
    onProgress('matching members', 85);

    // Collect all unique raw names across all decisions + attendance changes
    const allRawNames = new Set<string>();
    for (const { raw } of extractions) {
        for (const name of raw.presentMembers || []) allRawNames.add(name);
        for (const name of raw.absentMembers || []) allRawNames.add(name);
        for (const detail of raw.voteDetails || []) allRawNames.add(detail.name);
    }
    for (const change of meetingAttendanceChanges) {
        allRawNames.add(change.name);
    }

    // Step 1: Token-sort matching — build name→personId map
    const nameToPersonId = new Map<string, string>();
    for (const rawName of allRawNames) {
        const personId = matchPersonByName(rawName, request.people);
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
        const availablePeople = request.people.filter(p => !matchedIds.has(p.id));

        try {
            const llmResult = await llmMatchMembers(step1Unmatched, availablePeople);
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
    onProgress('building results', 95);

    // Build the set of all agenda item numbers for effective attendance computation.
    // Include items referenced by attendance changes (even without decisions) so that
    // departures/arrivals during non-decision items are still processed in the walk.
    const allAgendaItemNumbers = [...new Set([
        ...request.subjects.map(s => s.agendaItemIndex),
        ...meetingAttendanceChanges
            .filter(c => c.duringAgendaItem != null)
            .map(c => c.duringAgendaItem!),
    ])];
    // Build subjectId → agendaItemIndex lookup
    const subjectAgendaIndex = new Map(
        request.subjects.map(s => [s.subjectId, s.agendaItemIndex])
    );

    const decisions: ExtractedDecisionResult[] = [];

    for (const { subjectId, raw } of extractions) {
        const unmatchedMembers: string[] = [];

        // Compute effective attendance for this subject
        const targetIndex = subjectAgendaIndex.get(subjectId);
        const effective = targetIndex != null
            ? computeEffectiveAttendance({
                initialPresent: raw.presentMembers || [],
                initialAbsent: raw.absentMembers || [],
                attendanceChanges: meetingAttendanceChanges,
                discussionOrder: meetingDiscussionOrder,
                allAgendaItemNumbers,
                targetAgendaItemNumber: targetIndex,
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
        });

        console.log(`  [${subjectId}] ${presentMemberIds.length} present, ${absentMemberIds.length} absent, ${unmatchedMembers.length} unmatched, ${voteDetails.length} votes`);
    }

    const totalElapsed = ((Date.now() - taskStart) / 1000).toFixed(1);
    console.log(`\n========== extractDecisions DONE (${totalElapsed}s) ==========`);
    console.log(`  Extracted: ${extractions.length}/${request.subjects.length}`);
    console.log(`  Warnings: ${warnings.length}`);
    console.log(`====================================================\n`);

    onProgress('complete', 100);

    return { decisions, warnings };
};
