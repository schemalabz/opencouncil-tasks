/**
 * Batch processing functions for the summarize task.
 * Handles stateful processing of transcript batches with conversation state management.
 */

import Anthropic from '@anthropic-ai/sdk';
import { DiscussionRange, DiscussionStatus } from "../../types.js";
import { IdCompressor, formatTokenCount, generateSubjectUUID } from "../../utils.js";
import { aiChat, addUsage, NO_USAGE } from "../../lib/ai.js";
import { getBatchProcessingSystemPrompt } from "./prompts.js";
import {
    CompressedTranscript,
    SubjectInProgress,
    BatchProcessingResult
} from "./types.js";
import {
    splitTranscript,
    initializeSubjectsFromExisting,
    getStatusEmoji
} from "./utils.js";

/**
 * Main unified batch processing function.
 * Processes transcript in batches, maintaining conversation state across batches.
 */
export async function processBatchesWithState(
    request: {
        transcript: CompressedTranscript;
        existingSubjects: any[];
        cityName: string;
        date: string;
        topicLabels: string[];
        administrativeBodyName?: string;
        requestedSubjects?: string[];
        additionalInstructions?: string;
    },
    idCompressor: IdCompressor,
    onProgress: (stage: string, progress: number) => void
): Promise<{
    speakerSegmentSummaries: BatchProcessingResult['segmentSummaries'];
    subjects: SubjectInProgress[];
    allDiscussionRanges: DiscussionRange[];
    usage: Anthropic.Messages.Usage;
}> {
    const batches = splitTranscript(request.transcript, 130000);

    let conversationState = {
        subjects: initializeSubjectsFromExisting(request.existingSubjects),
        allDiscussionRanges: [] as DiscussionRange[],
        discussionSummary: undefined as string | undefined  // Narrative summary of where the discussion is
    };

    const allSummaries: BatchProcessingResult['segmentSummaries'] = [];
    let totalUsage = NO_USAGE;

    console.log(`Processing ${batches.length} batches...`);

    for (let i = 0; i < batches.length; i++) {
        onProgress("batch_processing", i / batches.length);
        console.log('');
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`📦 BATCH ${i + 1}/${batches.length}`);
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

        // Find the last range from previous batch - should be at most one open range
        const lastRange = conversationState.allDiscussionRanges[conversationState.allDiscussionRanges.length - 1];
        const openRange = lastRange?.endUtteranceId === null ? lastRange : null;

        if (openRange) {
            const statusEmoji = getStatusEmoji(openRange.status);
            const subject = openRange.subjectId ? conversationState.subjects.find(s => s.id === openRange.subjectId) : null;
            const subjectInfo = openRange.subjectId
                ? subject
                    ? ` - "${subject.name}" [subjectId: ${openRange.subjectId}]`
                    : ` - [⚠️ UNKNOWN: ${openRange.subjectId}]`
                : '';
            console.log(`🔄 Continuing open range: ${statusEmoji} ${openRange.status}${subjectInfo}`);
        } else {
            console.log(`🆕 Starting fresh (no open range from previous batch)`);
        }

        // Get the last few ranges for context (up to 5)
        const recentRanges = conversationState.allDiscussionRanges.slice(-5);
        if (recentRanges.length > 0) {
            console.log(`📜 Recent context (last ${recentRanges.length} ranges):`);
            recentRanges.forEach((r, idx) => {
                const statusEmoji = getStatusEmoji(r.status);
                const subject = r.subjectId ? conversationState.subjects.find(s => s.id === r.subjectId) : null;
                const subjectInfo = r.subjectId
                    ? subject
                        ? ` - "${subject.name}" [${r.subjectId}]`
                        : ` - [⚠️ UNKNOWN: ${r.subjectId}]`
                    : '';
                const isOpen = r.endUtteranceId === null ? ' [OPEN]' : '';
                console.log(`   ${idx + 1}. ${statusEmoji} ${r.status}${subjectInfo}${isOpen}`);
            });
        }

        const { result: batchResult, usage: batchUsage } = await processSingleBatch(
            batches[i],
            i,
            batches.length,
            conversationState,
            openRange,
            recentRanges,
            {
                cityName: request.cityName,
                date: request.date,
                topicLabels: request.topicLabels,
                administrativeBodyName: request.administrativeBodyName,
                requestedSubjects: request.requestedSubjects,
                additionalInstructions: request.additionalInstructions
            },
            conversationState.discussionSummary  // Pass previous discussion summary
        );

        // Accumulate token usage
        totalUsage = addUsage(totalUsage, batchUsage);
        console.log(`   📊 Batch tokens: ${formatTokenCount(batchUsage.input_tokens)} input, ${formatTokenCount(batchUsage.output_tokens)} output`);

        allSummaries.push(...batchResult.segmentSummaries);

        // Register any new subject IDs from the LLM in the IdCompressor
        // This is critical for subjects created dynamically during batch processing
        const idMapping = new Map<string, string>(); // old ID -> new ID
        for (const subject of batchResult.subjects) {
            // Check if this ID is already registered in the IdCompressor
            if (!idCompressor.hasShortId(subject.id)) {
                // ID doesn't exist - this is a NEW subject created by the LLM
                // Generate a UUID for it and register the mapping
                const uuid = generateSubjectUUID({
                    name: subject.name,
                    description: subject.description,
                    agendaItemIndex: subject.agendaItemIndex
                });

                // Register the mapping: uuid (long) -> compressed ID (short)
                const properShortId = idCompressor.addLongId(uuid);

                // Track the ID change so we can update ranges
                const oldId = subject.id;
                idMapping.set(oldId, properShortId);

                // Update the subject ID to use the proper compressed ID
                subject.id = properShortId;

                console.log(`   📝 Registered new subject ID: "${subject.name}" - ${oldId} -> ${properShortId}`);
            }
        }

        // Update ranges to use the corrected subject IDs
        for (const range of batchResult.ranges) {
            if (range.subjectId && idMapping.has(range.subjectId)) {
                const oldId = range.subjectId;
                const newId = idMapping.get(range.subjectId)!;
                range.subjectId = newId;
                console.log(`   🔄 Updated range subjectId: ${oldId} -> ${newId}`);
            }
        }

        // VALIDATION: Verify ALL range subject IDs are registered in IdCompressor
        console.log(`\n   🔑 ID Registration Validation:`);
        const rangeSubjectIds = new Set(batchResult.ranges.map(r => r.subjectId).filter(Boolean));
        let hasUnregisteredIds = false;

        rangeSubjectIds.forEach(sid => {
            const isRegistered = idCompressor.hasShortId(sid!);
            const subject = batchResult.subjects.find(s => s.id === sid);
            const subjectName = subject?.name || 'Unknown Subject';

            if (isRegistered) {
                console.log(`      ✓ ${sid} - "${subjectName}"`);
            } else {
                console.error(`      ✗ MISSING ${sid} - "${subjectName}"`);
                hasUnregisteredIds = true;
            }
        });

        if (hasUnregisteredIds) {
            console.error(`   ⚠️  WARNING: Found unregistered subject IDs in ranges! This will cause utterances to have null subjectId.`);
            console.error(`   📋 All registered IDs:`, Array.from(idCompressor['shortIdToLong'].keys()));
        }

        // Add new ranges from this batch
        const newRanges = batchResult.ranges.map(r => ({
            id: r.id,
            startUtteranceId: r.start,
            endUtteranceId: r.end,
            status: r.status,
            subjectId: r.subjectId
        }));

        // VALIDATION: If continuing an open range, ensure consistency
        if (openRange && newRanges.length > 0 && newRanges[0].startUtteranceId === null) {
            const continuedRange = newRanges[0];

            if (continuedRange.id !== openRange.id) {
                console.warn(`   ⚠️  LLM returned wrong range ID for continuation!`);
                console.warn(`      Expected: ${openRange.id}`);
                console.warn(`      Got: ${continuedRange.id}`);
                console.warn(`      Auto-correcting to use expected range ID...`);
                continuedRange.id = openRange.id;
            }

            if (continuedRange.subjectId !== openRange.subjectId) {
                const oldSubject = batchResult.subjects.find(s => s.id === continuedRange.subjectId);
                const expectedSubject = conversationState.subjects.find(s => s.id === openRange.subjectId);
                console.warn(`   🚨 CRITICAL: LLM changed subject for continued range!`);
                console.warn(`      Expected: ${openRange.subjectId} - "${expectedSubject?.name}"`);
                console.warn(`      Got: ${continuedRange.subjectId} - "${oldSubject?.name}"`);
                console.warn(`      Auto-correcting to preserve original subject...`);
                continuedRange.subjectId = openRange.subjectId;
            }

            if (continuedRange.status !== openRange.status) {
                console.warn(`   ⚠️  LLM changed status for continued range!`);
                console.warn(`      Expected: ${openRange.status}`);
                console.warn(`      Got: ${continuedRange.status}`);
                console.warn(`      Auto-correcting to use expected status...`);
                continuedRange.status = openRange.status;
            }
        }

        console.log(`\n✅ Batch ${i + 1} processed:`);
        console.log(`   • Subjects in conversation state: ${batchResult.subjects.length}`);
        console.log(`   • Ranges created in this batch: ${newRanges.length}`);

        // Log all subjects returned by LLM
        console.log(`\n   📚 Subjects in this batch's response:`);
        batchResult.subjects.forEach((s, idx) => {
            console.log(`      ${idx + 1}. [${s.id}] "${s.name}"`);
        });

        // Log each new range with subject ID
        if (newRanges.length > 0) {
            console.log(`\n   📊 Ranges from this batch:`);
            newRanges.forEach((r, idx) => {
                const statusEmoji = getStatusEmoji(r.status);
                const subject = r.subjectId ? batchResult.subjects.find(s => s.id === r.subjectId) : null;
                const subjectInfo = r.subjectId
                    ? subject
                        ? ` - "${subject.name}" [subjectId: ${r.subjectId}]`
                        : ` - [⚠️ UNKNOWN SUBJECT ID: ${r.subjectId}]`
                    : '';
                const startInfo = r.startUtteranceId === null ? 'continues from prev' : `starts at ${r.startUtteranceId}`;
                const endInfo = r.endUtteranceId === null ? 'OPEN (continues to next)' : `ends at ${r.endUtteranceId}`;
                console.log(`      ${idx + 1}. ${statusEmoji} ${r.status}${subjectInfo}`);
                console.log(`         ${startInfo} → ${endInfo}`);
            });
        }

        // Validate that all subject IDs in ranges exist in subjects list
        const invalidRanges = newRanges.filter(r =>
            r.subjectId && !batchResult.subjects.find(s => s.id === r.subjectId)
        );
        if (invalidRanges.length > 0) {
            console.log(`\n   🚨 CRITICAL ERROR: ${invalidRanges.length} ranges reference unknown subject IDs!`);
            console.log(`   This means the LLM created ranges with subject IDs that don't exist in the subjects list.`);
            console.log(`   Invalid ranges:`);
            invalidRanges.forEach((r, idx) => {
                console.log(`      ${idx + 1}. Range ${r.id} references subjectId: ${r.subjectId}`);
            });
            console.log(`   Available subject IDs in this batch:`);
            batchResult.subjects.forEach((s, idx) => {
                console.log(`      ${idx + 1}. ${s.id} - "${s.name}"`);
            });
        }

        // Merge ranges: if a new range continues from previous (start=null), replace the old one
        const mergedRanges = [...conversationState.allDiscussionRanges];
        const continuedRanges: string[] = [];
        for (const newRange of newRanges) {
            if (newRange.startUtteranceId === null) {
                // This range continues from previous batch - find and replace the old range with same ID
                const oldRangeIndex = mergedRanges.findIndex(r => r.id === newRange.id);
                if (oldRangeIndex !== -1) {
                    // Replace the old open range with the updated one
                    mergedRanges[oldRangeIndex] = newRange;
                    continuedRanges.push(newRange.id);
                } else {
                    // Shouldn't happen, but add it anyway
                    console.log(`   ⚠️  WARNING: Range ${newRange.id} has start=null but no matching open range found!`);
                    mergedRanges.push(newRange);
                }
            } else {
                // New range, just append
                mergedRanges.push(newRange);
            }
        }

        if (continuedRanges.length > 0) {
            console.log(`\n   🔄 Replaced ${continuedRanges.length} continued range(s) from previous batch`);
        }

        conversationState = {
            subjects: batchResult.subjects,
            allDiscussionRanges: mergedRanges,
            discussionSummary: batchResult.discussionSummary  // Pass forward for next batch
        };

        // Validation: check that we have at most one open range
        const openRanges = conversationState.allDiscussionRanges.filter(r => r.endUtteranceId === null);
        const openRangesCount = openRanges.length;

        if (openRangesCount > 1) {
            console.log(`\n   ⚠️  WARNING: ${openRangesCount} open ranges detected! Should be at most 1.`);
            console.log(`   Open ranges:`);
            openRanges.forEach((r, idx) => {
                const statusEmoji = getStatusEmoji(r.status);
                const subjectName = r.subjectId
                    ? conversationState.subjects.find(s => s.id === r.subjectId)?.name || `[Unknown]`
                    : null;
                console.log(`      ${idx + 1}. ${statusEmoji} ${r.status}${subjectName ? ` - "${subjectName}"` : ''} [id: ${r.id}]`);
            });
        } else if (openRangesCount === 1) {
            const r = openRanges[0];
            const statusEmoji = getStatusEmoji(r.status);
            const subject = r.subjectId ? conversationState.subjects.find(s => s.id === r.subjectId) : null;
            const subjectInfo = r.subjectId
                ? subject
                    ? ` - "${subject.name}" [subjectId: ${r.subjectId}]`
                    : ` - [⚠️ UNKNOWN: ${r.subjectId}]`
                : '';
            console.log(`\n   🔓 1 open range (will continue to next batch): ${statusEmoji} ${r.status}${subjectInfo}`);
        } else {
            console.log(`\n   🔒 All ranges closed (no continuation to next batch)`);
        }
    }

    return {
        speakerSegmentSummaries: allSummaries,
        subjects: conversationState.subjects,
        allDiscussionRanges: conversationState.allDiscussionRanges,
        usage: totalUsage
    };
}

/**
 * Process a single batch with AI.
 * Generates segment summaries, discussion ranges, and updates subjects.
 */
export async function processSingleBatch(
    batch: any[],
    batchIndex: number,
    totalBatches: number,
    conversationState: { subjects: SubjectInProgress[] },
    openRange: DiscussionRange | null,
    recentRanges: DiscussionRange[],
    metadata: {
        cityName: string;
        date: string;
        topicLabels: string[];
        administrativeBodyName?: string;
        requestedSubjects?: string[];
        additionalInstructions?: string;
    },
    previousDiscussionSummary?: string
): Promise<{ result: BatchProcessingResult; usage: Anthropic.Messages.Usage }> {
    const systemPrompt = getBatchProcessingSystemPrompt(metadata);

    // Create context summary
    const progressSummary = batchIndex === 0
        ? "Αυτό είναι το ΠΡΩΤΟ batch της συνεδρίασης (αρχή συνεδρίασης)."
        : batchIndex === totalBatches - 1
        ? `Αυτό είναι το ΤΕΛΕΥΤΑΙΟ batch της συνεδρίασης (batch ${batchIndex + 1}/${totalBatches}).`
        : `Αυτό είναι το batch ${batchIndex + 1}/${totalBatches} της συνεδρίασης (μέση πορεία).`;

    const recentRangesSummary = recentRanges.length > 0
        ? `\n\nΠΡΟΣΦΑΤΑ RANGES (τελευταία ${recentRanges.length}):
${recentRanges.map((r, idx) => {
    const statusLabel = r.status === DiscussionStatus.ATTENDANCE ? "Παρουσίες" :
                       r.status === DiscussionStatus.SUBJECT_DISCUSSION ? "Συζήτηση θέματος" :
                       r.status === DiscussionStatus.VOTE ? "Ψηφοφορία" : "Άλλο";
    const subjectInfo = r.subjectId ? ` (θέμα: ${conversationState.subjects.find(s => s.id === r.subjectId)?.name || r.subjectId})` : '';
    return `${idx + 1}. ${statusLabel}${subjectInfo}`;
}).join('\n')}`
        : '';

    const discussionContextSummary = previousDiscussionSummary ? `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ΠΛΑΙΣΙΟ ΣΥΖΗΤΗΣΗΣ (από προηγούμενο batch)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${previousDiscussionSummary}

` : '';

    const openRangeInstructions = openRange ? `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️  ΚΡΙΣΙΜΟ: ΑΝΟΙΧΤΟ RANGE ΠΟΥ ΣΥΝΕΧΙΖΕΤΑΙ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Το προηγούμενο batch τελείωσε με ανοιχτό range που ΠΡΕΠΕΙ να συνεχίσεις:

Range ID: "${openRange.id}"
Status: ${openRange.status}
Subject ID: ${openRange.subjectId}
Subject: "${conversationState.subjects.find(s => s.id === openRange.subjectId)?.name || 'Unknown'}"

**ΥΠΟΧΡΕΩΤΙΚΕΣ ΟΔΗΓΙΕΣ:**
1. Το ΠΡΩΤΟ range στην απάντησή σου ΠΡΕΠΕΙ να είναι η συνέχεια αυτού του range
2. Χρησιμοποίησε το ΑΚΡΙΒΩΣ ΙΔΙΟ range id: "${openRange.id}"
3. Χρησιμοποίησε το ΑΚΡΙΒΩΣ ΙΔΙΟ subjectId: "${openRange.subjectId}"
4. Χρησιμοποίησε το ΑΚΡΙΒΩΣ ΙΔΙΟ status: "${openRange.status}"
5. Βάλε start = null (σημαίνει ότι ξεκινάει από προηγούμενο batch)
6. Βάλε end = το utteranceId όπου τελειώνει, ή null αν συνεχίζεται στο επόμενο batch

ΜΗΝ αλλάξεις το range ID, subject ID, ή status!

Παράδειγμα πρώτου range:
{
  "id": "${openRange.id}",
  "start": null,
  "end": "utt-xxx" ή null,
  "status": "${openRange.status}",
  "subjectId": "${openRange.subjectId}"
}

` : '';

    const userPrompt = `
${progressSummary}${recentRangesSummary}

${discussionContextSummary}${openRangeInstructions}
Το απόσπασμα της συνεδρίασης είναι το εξής:
${JSON.stringify(batch, null, 2)}

${metadata.requestedSubjects && metadata.requestedSubjects.length > 0 ?
            `Αν στο παραπάνω transcript αναφέρεται κάποιο από τα ακόλουθα θέματα, είναι σημαντικό να το συμπεριλάβεις: ${metadata.requestedSubjects.join(', ')}` : ''}

Η τρέχουσα λίστα subjects (χρησιμοποίησε το ίδιο ID και ΔΙΑΤΗΡΗΣΕ τα type/agendaItemIndex/introducedByPersonId):
${JSON.stringify(conversationState.subjects.map(s => ({
                id: s.id,
                name: s.name,
                description: s.description,
                type: s.type,
                agendaItemIndex: s.agendaItemIndex,
                introducedByPersonId: s.introducedByPersonId
            })), null, 2)}
`;

    const response = await aiChat<BatchProcessingResult>({
        systemPrompt,
        userPrompt,
        prefillSystemResponse: "Αναλύω το batch και παράγω τα αποτελέσματα σε JSON:\n{",
        prependToResponse: "{",
        cacheSystemPrompt: true  // Cache system prompt across batches
    });

    return { result: response.result, usage: response.usage };
}
