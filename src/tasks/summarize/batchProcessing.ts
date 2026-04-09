/**
 * Batch processing functions for the summarize task.
 * Handles stateful processing of transcript batches with conversation state management.
 */

import Anthropic from '@anthropic-ai/sdk';
import { DiscussionStatus } from "../../types.js";
import { IdCompressor, formatTokenCount, generateSubjectUUID } from "../../utils.js";
import { aiChat, addUsage, NO_USAGE } from "../../lib/ai.js";
import { getBatchProcessingSystemPrompt } from "./prompts.js";
import {
    CompressedTranscript,
    SubjectInProgress,
    BatchProcessingResult,
    UtteranceStatus
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
    allUtteranceStatuses: UtteranceStatus[];
    usage: Anthropic.Messages.Usage;
}> {
    const batches = splitTranscript(request.transcript, 120000);

    let conversationState = {
        subjects: initializeSubjectsFromExisting(request.existingSubjects),
        allUtteranceStatuses: [] as UtteranceStatus[],
        meetingProgressSummary: undefined as string | undefined  // Meeting context for next batch
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

        // Show previous meeting progress summary if available
        if (conversationState.meetingProgressSummary) {
            console.log(`📋 Meeting progress context:`);
            console.log(`   ${conversationState.meetingProgressSummary}`);
        } else {
            console.log(`🆕 Starting first batch (no previous context)`);
        }

        const { result: batchResult, usage: batchUsage } = await processSingleBatch(
            batches[i],
            i,
            batches.length,
            conversationState,
            {
                cityName: request.cityName,
                date: request.date,
                topicLabels: request.topicLabels,
                administrativeBodyName: request.administrativeBodyName,
                requestedSubjects: request.requestedSubjects,
                additionalInstructions: request.additionalInstructions
            },
            conversationState.meetingProgressSummary  // Pass previous meeting progress summary
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

                // Track the ID change so we can update utterance statuses
                const oldId = subject.id;
                idMapping.set(oldId, properShortId);

                // Update the subject ID to use the proper compressed ID
                subject.id = properShortId;

                console.log(`   📝 Registered new subject ID: "${subject.name}" - ${oldId} -> ${properShortId}`);
            }
        }

        // Update utterance statuses to use the corrected subject IDs
        let statusIdsUpdated = 0;
        for (const status of batchResult.utteranceStatuses) {
            if (status.subjectId && idMapping.has(status.subjectId)) {
                status.subjectId = idMapping.get(status.subjectId)!;
                statusIdsUpdated++;
            }
        }
        if (statusIdsUpdated > 0) {
            console.log(`   🔄 Updated ${statusIdsUpdated} utterance status subjectIds to use proper compressed IDs`);
        }

        // Update discussedIn references to use the corrected subject IDs
        let discussedInUpdated = 0;
        for (const subject of batchResult.subjects) {
            if (subject.discussedIn && idMapping.has(subject.discussedIn)) {
                const oldDiscussedIn = subject.discussedIn;
                subject.discussedIn = idMapping.get(subject.discussedIn)!;
                console.log(`   🔄 Updated discussedIn for "${subject.name}": ${oldDiscussedIn} -> ${subject.discussedIn}`);
                discussedInUpdated++;
            }
        }
        if (discussedInUpdated > 0) {
            console.log(`   🔄 Updated ${discussedInUpdated} subject discussedIn references to use proper compressed IDs`);
        }

        // VALIDATION: Preserve introducedByPersonId from existing subjects
        // Bug fix: LLM often changes introducers to the chair who merely announces the subject
        console.log(`\n   🔒 Preserving introducers from existing subjects...`);
        const previousSubjects = conversationState.subjects;
        for (const subject of batchResult.subjects) {
            const previousSubject = previousSubjects.find(s => s.id === subject.id);
            if (previousSubject && previousSubject.introducedByPersonId !== null) {
                if (subject.introducedByPersonId !== previousSubject.introducedByPersonId) {
                    console.warn(`      ⚠️  LLM changed introducer for "${subject.name}"`);
                    console.warn(`         Original: ${previousSubject.introducedByPersonId}`);
                    console.warn(`         LLM changed to: ${subject.introducedByPersonId}`);
                    console.warn(`         → Restoring original introducer`);
                    subject.introducedByPersonId = previousSubject.introducedByPersonId;
                }
            }
        }

        // VALIDATION: Verify ALL utterance status subject IDs are registered in IdCompressor
        console.log(`\n   🔑 ID Registration Validation:`);
        const statusSubjectIds = new Set(batchResult.utteranceStatuses.map(s => s.subjectId).filter(Boolean));
        let hasUnregisteredIds = false;

        statusSubjectIds.forEach(sid => {
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
            console.error(`   ⚠️  WARNING: Found unregistered subject IDs in utterance statuses! This will cause issues.`);
            console.error(`   📋 All registered IDs:`, Array.from(idCompressor['shortIdToLong'].keys()));
        }

        console.log(`\n✅ Batch ${i + 1} processed:`);
        console.log(`   • Subjects in conversation state: ${batchResult.subjects.length}`);
        console.log(`   • Utterance statuses created in this batch: ${batchResult.utteranceStatuses.length}`);

        // Log all subjects returned by LLM
        console.log(`\n   📚 Subjects in this batch's response:`);
        batchResult.subjects.forEach((s, idx) => {
            console.log(`      ${idx + 1}. [${s.id}] "${s.name}"`);
        });

        // Log utterance status distribution (THIS BATCH ONLY)
        const statusCounts = new Map<string, number>();
        for (const status of batchResult.utteranceStatuses) {
            const key = `${status.status}${status.subjectId ? `:${status.subjectId}` : ''}`;
            statusCounts.set(key, (statusCounts.get(key) || 0) + 1);
        }

        console.log(`\n   📊 Utterance status distribution (this batch):`);
        console.log(`      Total utterances in this batch: ${batchResult.utteranceStatuses.length}`);

        // Group by status type for better organization
        const byStatus = new Map<DiscussionStatus, Array<{ subjectId: string | null; count: number }>>();

        for (const [key, count] of statusCounts.entries()) {
            const [statusStr, subjectId] = key.split(':');
            const status = statusStr as DiscussionStatus;
            if (!byStatus.has(status)) {
                byStatus.set(status, []);
            }
            byStatus.get(status)!.push({ subjectId: subjectId || null, count });
        }

        // Sort entries within each status by count (descending)
        for (const [status, entries] of byStatus.entries()) {
            entries.sort((a, b) => b.count - a.count);
        }

        // Display organized by status type
        const statusDisplayOrder: DiscussionStatus[] = [
            DiscussionStatus.ATTENDANCE,
            DiscussionStatus.SUBJECT_DISCUSSION,
            DiscussionStatus.VOTE,
            DiscussionStatus.OTHER
        ];

        for (const status of statusDisplayOrder) {
            const entries = byStatus.get(status);
            if (!entries) continue;

            const statusEmoji = getStatusEmoji(status);
            const totalForStatus = entries.reduce((sum, e) => sum + e.count, 0);
            console.log(`      ${statusEmoji} ${status} (${totalForStatus} total):`);

            for (const entry of entries) {
                if (entry.subjectId) {
                    const subject = batchResult.subjects.find(s => s.id === entry.subjectId);
                    console.log(`         • "${subject?.name || 'Unknown'}" [${entry.subjectId}]: ${entry.count} utterances`);
                } else {
                    console.log(`         • (no subject): ${entry.count} utterances`);
                }
            }
        }

        // VALIDATION: Ensure utterance statuses don't point to secondary subjects
        console.log(`\n   🔗 Validating joint discussion subjects...`);
        const secondarySubjects = batchResult.subjects.filter(s => s.discussedIn !== null);

        if (secondarySubjects.length > 0) {
            console.log(`      Found ${secondarySubjects.length} secondary subjects in joint discussions:`);

            // Group by primary subject
            const groupedByPrimary = new Map<string, string[]>();
            for (const secondary of secondarySubjects) {
                if (!groupedByPrimary.has(secondary.discussedIn!)) {
                    groupedByPrimary.set(secondary.discussedIn!, []);
                }
                groupedByPrimary.get(secondary.discussedIn!)!.push(secondary.name);
            }

            // Log the groups
            groupedByPrimary.forEach((secondaries, primaryId) => {
                const primarySubject = batchResult.subjects.find(s => s.id === primaryId);
                console.log(`      Primary: "${primarySubject?.name}" (${primaryId})`);
                console.log(`         Secondary subjects: ${secondaries.join(', ')}`);
            });

            // Check for invalid utterance statuses pointing to secondary subjects
            const invalidStatuses = batchResult.utteranceStatuses.filter(s =>
                s.subjectId &&
                (s.status === DiscussionStatus.SUBJECT_DISCUSSION || s.status === DiscussionStatus.VOTE) &&
                secondarySubjects.some(sub => sub.id === s.subjectId)
            );

            if (invalidStatuses.length > 0) {
                console.warn(`      ⚠️  CRITICAL: Found ${invalidStatuses.length} utterance statuses pointing to secondary subjects!`);
                console.warn(`      This violates the joint discussion model.`);

                for (const status of invalidStatuses) {
                    const secondary = secondarySubjects.find(s => s.id === status.subjectId);
                    const primary = batchResult.subjects.find(s => s.id === secondary?.discussedIn);

                    console.warn(`         Utterance ${status.utteranceId} points to secondary "${secondary?.name}"`);

                    // Validate that the primary subject exists before auto-correcting
                    if (!primary) {
                        console.error(`         ⚠️  Primary subject ${secondary?.discussedIn} not found! Keeping original subjectId.`);
                        continue;
                    }

                    console.warn(`         Should point to primary "${primary.name}" (${primary.id})`);
                    console.warn(`         → Auto-correcting to primary subject`);

                    // Auto-correct the status
                    status.subjectId = secondary!.discussedIn;
                }
            }
        }

        // Simple concatenation: just add all new utterance statuses to the accumulated list
        conversationState.allUtteranceStatuses.push(...batchResult.utteranceStatuses);

        // Log cumulative distribution across ALL batches processed so far
        console.log(`\n   📈 CUMULATIVE utterance status distribution (all batches so far):`);
        console.log(`      Total utterances across all batches: ${conversationState.allUtteranceStatuses.length}`);

        const cumulativeCounts = new Map<string, number>();
        for (const status of conversationState.allUtteranceStatuses) {
            const key = `${status.status}${status.subjectId ? `:${status.subjectId}` : ''}`;
            cumulativeCounts.set(key, (cumulativeCounts.get(key) || 0) + 1);
        }

        const cumulativeByStatus = new Map<DiscussionStatus, Array<{ subjectId: string | null; count: number }>>();
        for (const [key, count] of cumulativeCounts.entries()) {
            const [statusStr, subjectId] = key.split(':');
            const status = statusStr as DiscussionStatus;
            if (!cumulativeByStatus.has(status)) {
                cumulativeByStatus.set(status, []);
            }
            cumulativeByStatus.get(status)!.push({ subjectId: subjectId || null, count });
        }

        // Sort by count
        for (const entries of cumulativeByStatus.values()) {
            entries.sort((a, b) => b.count - a.count);
        }

        // Display top subjects per status
        const statusOrder: DiscussionStatus[] = [
            DiscussionStatus.ATTENDANCE,
            DiscussionStatus.SUBJECT_DISCUSSION,
            DiscussionStatus.VOTE,
            DiscussionStatus.OTHER
        ];

        for (const status of statusOrder) {
            const entries = cumulativeByStatus.get(status);
            if (!entries) continue;

            const statusEmoji = getStatusEmoji(status);
            const totalForStatus = entries.reduce((sum, e) => sum + e.count, 0);
            console.log(`      ${statusEmoji} ${status}: ${totalForStatus} utterances`);

            // Show top 5 subjects for SUBJECT_DISCUSSION
            if (status === DiscussionStatus.SUBJECT_DISCUSSION) {
                const subjectEntries = entries.filter(e => e.subjectId !== null).slice(0, 5);
                subjectEntries.forEach(entry => {
                    const subject = conversationState.subjects.find(s => s.id === entry.subjectId);
                    console.log(`         • "${subject?.name || 'Unknown'}" [${entry.subjectId}]: ${entry.count} utterances`);
                });
                if (entries.filter(e => e.subjectId !== null).length > 5) {
                    console.log(`         • ... and ${entries.filter(e => e.subjectId !== null).length - 5} more subjects`);
                }
            }

            // Show all subjects for VOTE (usually not many)
            if (status === DiscussionStatus.VOTE) {
                entries.forEach(entry => {
                    if (entry.subjectId) {
                        const subject = conversationState.subjects.find(s => s.id === entry.subjectId);
                        console.log(`         • "${subject?.name || 'Unknown'}" [${entry.subjectId}]: ${entry.count} utterances`);
                    } else {
                        console.log(`         • ⚠️  (no subject - INVALID): ${entry.count} utterances`);
                    }
                });
            }
        }

        // VALIDATION: Ensure all existing subjects are preserved, even if not discussed
        // Bug fix: Undiscussed agenda items were being dropped
        console.log(`\n   📋 Checking for undiscussed subjects...`);
        const discussedSubjectIds = new Set(batchResult.subjects.map(s => s.id));
        const undiscussedSubjects = conversationState.subjects.filter(s => !discussedSubjectIds.has(s.id));

        if (undiscussedSubjects.length > 0) {
            console.log(`      Found ${undiscussedSubjects.length} undiscussed subjects - preserving with low priority:`);
            for (const subject of undiscussedSubjects) {
                console.log(`         • "${subject.name}" (ID: ${subject.id})`);
                // Preserve subject but mark with lowest importance to prevent notifications
                batchResult.subjects.push({
                    ...subject,
                    discussedIn: subject.discussedIn || null,  // PRESERVE discussedIn if set
                    speakerContributions: [],
                    topicImportance: 'doNotNotify',
                    proximityImportance: 'none'
                });
            }
        }

        conversationState = {
            subjects: batchResult.subjects,
            allUtteranceStatuses: conversationState.allUtteranceStatuses,  // Accumulated across all batches
            meetingProgressSummary: batchResult.meetingProgressSummary  // Pass forward for next batch
        };

        // Log meeting progress summary if generated
        if (batchResult.meetingProgressSummary) {
            console.log(`\n   📋 Meeting progress summary for next batch:`);
            console.log(`      ${batchResult.meetingProgressSummary}`);
        }
    }

    return {
        speakerSegmentSummaries: allSummaries,
        subjects: conversationState.subjects,
        allUtteranceStatuses: conversationState.allUtteranceStatuses,
        usage: totalUsage
    };
}

/**
 * Process a single batch with AI.
 * Generates segment summaries, utterance statuses, and updates subjects.
 */
export async function processSingleBatch(
    batch: any[],
    batchIndex: number,
    totalBatches: number,
    conversationState: { subjects: SubjectInProgress[] },
    metadata: {
        cityName: string;
        date: string;
        topicLabels: string[];
        administrativeBodyName?: string;
        requestedSubjects?: string[];
        additionalInstructions?: string;
    },
    previousMeetingProgressSummary?: string
): Promise<{ result: BatchProcessingResult; usage: Anthropic.Messages.Usage }> {
    const systemPrompt = getBatchProcessingSystemPrompt(metadata);

    // Create context summary
    const progressSummary = batchIndex === 0
        ? "Αυτό είναι το ΠΡΩΤΟ batch της συνεδρίασης (αρχή συνεδρίασης)."
        : batchIndex === totalBatches - 1
        ? `Αυτό είναι το ΤΕΛΕΥΤΑΙΟ batch της συνεδρίασης (batch ${batchIndex + 1}/${totalBatches}).`
        : `Αυτό είναι το batch ${batchIndex + 1}/${totalBatches} της συνεδρίασης (μέση πορεία).`;

    const meetingContextSummary = previousMeetingProgressSummary ? `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ΠΛΑΙΣΙΟ ΣΥΝΕΔΡΙΑΣΗΣ (από προηγούμενο batch)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${previousMeetingProgressSummary}

Χρησιμοποίησε αυτό το πλαίσιο για να κατανοήσεις που βρίσκεται η συνεδρίαση και να ταξινομήσεις σωστά τα utterances.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

` : '';

    const userPrompt = `
${progressSummary}

${meetingContextSummary}
Το απόσπασμα της συνεδρίασης είναι το εξής:
${JSON.stringify(batch, null, 2)}

${metadata.requestedSubjects && metadata.requestedSubjects.length > 0 ?
            `Αν στο παραπάνω transcript αναφέρεται κάποιο από τα ακόλουθα θέματα, είναι σημαντικό να το συμπεριλάβεις: ${metadata.requestedSubjects.join(', ')}` : ''}

Η τρέχουσα λίστα subjects (χρησιμοποίησε το ίδιο ID και ΔΙΑΤΗΡΗΣΕ τα type/agendaItemIndex/introducedByPersonId/discussedIn):
${JSON.stringify(conversationState.subjects.map(s => ({
                id: s.id,
                name: s.name,
                description: s.description,
                type: s.type,
                agendaItemIndex: s.agendaItemIndex,
                introducedByPersonId: s.introducedByPersonId,
                discussedIn: s.discussedIn
            })), null, 2)}
`;

    const response = await aiChat<BatchProcessingResult>({
        model: "claude-opus-4-6",
        systemPrompt,
        userPrompt,
        outputFormat: {
            type: "json_schema",
            schema: {
                type: "object",
                properties: {
                    segmentSummaries: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                id: { type: "string" },
                                summary: { type: "string" },
                                labels: { type: "array", items: { type: "string" } },
                                type: { type: "string", enum: ["SUBSTANTIAL", "PROCEDURAL"] }
                            },
                            required: ["id", "summary", "labels", "type"],
                            additionalProperties: false
                        }
                    },
                    subjects: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                id: { type: "string" },
                                type: { type: "string", enum: ["IN_AGENDA", "BEFORE_AGENDA", "OUT_OF_AGENDA"] },
                                agendaItemIndex: { type: ["number", "string"] },
                                name: { type: "string" },
                                description: { type: "string" },
                                topicImportance: { type: "string", enum: ["doNotNotify", "normal", "high"] },
                                proximityImportance: { type: "string", enum: ["none", "near", "wide"] },
                                introducedByPersonId: { type: ["string", "null"] },
                                locationText: { type: ["string", "null"] },
                                topicLabel: { type: ["string", "null"] },
                                discussedIn: { type: ["string", "null"] },
                                speakerContributions: {
                                    type: "array",
                                    items: {
                                        type: "object",
                                        properties: {
                                            speakerId: { type: "string" },
                                            text: { type: "string" }
                                        },
                                        required: ["speakerId", "text"],
                                        additionalProperties: false
                                    }
                                }
                            },
                            required: ["id", "type", "agendaItemIndex", "name", "description", "topicImportance", "proximityImportance", "introducedByPersonId", "locationText", "topicLabel", "discussedIn", "speakerContributions"],
                            additionalProperties: false
                        }
                    },
                    utteranceStatuses: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                utteranceId: { type: "string" },
                                status: { type: "string", enum: ["ATTENDANCE", "SUBJECT_DISCUSSION", "VOTE", "OTHER"] },
                                subjectId: { type: ["string", "null"] }
                            },
                            required: ["utteranceId", "status", "subjectId"],
                            additionalProperties: false
                        }
                    },
                    meetingProgressSummary: { type: "string" }
                },
                required: ["segmentSummaries", "subjects", "utteranceStatuses"],
                additionalProperties: false
            }
        },
        cacheSystemPrompt: true  // Cache system prompt across batches
    });

    return { result: response.result, usage: response.usage };
}
