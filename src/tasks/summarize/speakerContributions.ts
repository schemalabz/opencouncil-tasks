/**
 * Speaker contribution generation functions for the summarize task.
 * Extracts speaker utterances from discussion ranges and generates summaries.
 */

import Anthropic from '@anthropic-ai/sdk';
import { DiscussionStatus, SpeakerContribution } from "../../types.js";
import { IdCompressor, formatTime, formatTokenCount } from "../../utils.js";
import { aiChat, addUsage, NO_USAGE } from "../../lib/ai.js";
import { getSpeakerContributionsSystemPrompt } from "./prompts.js";
import { CompressedTranscript, SubjectInProgress, ExtractedUtterances, UtteranceStatus } from "./types.js";

/**
 * Generate speaker contributions from utterance statuses.
 * Finds relevant utterances, extracts them, and generates summaries.
 */
export async function generateSpeakerContributions(
    subject: SubjectInProgress,
    allUtteranceStatuses: UtteranceStatus[],
    transcript: CompressedTranscript,
    idCompressor: IdCompressor,
    administrativeBodyName?: string
): Promise<{ contributions: SpeakerContribution[]; usage: Anthropic.Messages.Usage }> {
    // Find utterance statuses for this subject
    const relevantStatuses = allUtteranceStatuses.filter(s =>
        s.subjectId === subject.id &&
        s.status === DiscussionStatus.SUBJECT_DISCUSSION
    );

    if (relevantStatuses.length === 0) {
        console.log(`   ⚠️  Subject "${subject.name}": No SUBJECT_DISCUSSION utterances found`);
        return { contributions: [], usage: NO_USAGE };
    }

    console.log(`   🔍 Subject "${subject.name}" has ${relevantStatuses.length} relevant utterances`);

    // Extract utterances with full context
    const { utterancesBySpeaker, allSubjectUtterances } = extractAndGroupUtterances(relevantStatuses, transcript);

    const speakerCount = Object.keys(utterancesBySpeaker).length;
    console.log(`   🔍 Extracted ${allSubjectUtterances.length} total utterances from ${speakerCount} speakers`);

    if (allSubjectUtterances.length === 0) {
        console.log(`   ⚠️  Subject "${subject.name}": No utterances found!`);
        return { contributions: [], usage: NO_USAGE };
    }

    if (speakerCount === 0) {
        console.log(`   ⚠️  Subject "${subject.name}": No speakers with utterances!`);
        return { contributions: [], usage: NO_USAGE };
    }

    // Generate speaker contributions in batches to avoid token exhaustion
    return await generateSpeakerContributionsInBatches(
        utterancesBySpeaker,
        allSubjectUtterances,
        subject,
        idCompressor,
        administrativeBodyName
    );
}

/**
 * Extract and group utterances by speaker from utterance statuses.
 * Returns both grouped utterances and full chronological list.
 * Much simpler than range-based extraction - just filter by utteranceId set.
 */
export function extractAndGroupUtterances(
    utteranceStatuses: UtteranceStatus[],
    transcript: CompressedTranscript
): ExtractedUtterances {
    const utterancesBySpeaker: Record<string, Array<{ utteranceId: string; text: string }>> = {};
    const allSubjectUtterances: Array<{
        utteranceId: string;
        text: string;
        speakerId: string | null;
        speakerName: string | null;
        timestamp: number;
    }> = [];

    // Create a set of relevant utterance IDs for fast lookup
    const relevantUtteranceIds = new Set(utteranceStatuses.map(s => s.utteranceId));

    console.log(`   🔍 Filtering ${relevantUtteranceIds.size} relevant utterances from transcript...`);

    // Track which utterances we've already seen to prevent duplicates
    const seenUtterances = new Map<string, string | null>();
    const duplicateUtterances: Array<{ utteranceId: string; firstSpeaker: string | null; duplicateSpeaker: string | null }> = [];

    // Simple direct filtering: just check if utterance ID is in the set
    for (const segment of transcript) {
        for (const utterance of segment.utterances) {
            if (relevantUtteranceIds.has(utterance.utteranceId)) {
                // VALIDATION: Check if we've already seen this utterance
                const previousSpeakerId = seenUtterances.get(utterance.utteranceId);

                if (previousSpeakerId !== undefined) {
                    // This utterance was already processed
                    if (previousSpeakerId !== segment.speakerId) {
                        // CRITICAL: Same utterance attributed to different speakers!
                        duplicateUtterances.push({
                            utteranceId: utterance.utteranceId,
                            firstSpeaker: previousSpeakerId,
                            duplicateSpeaker: segment.speakerId
                        });
                    }
                    // Skip this duplicate utterance
                    continue;
                }

                // Mark this utterance as seen with its speaker
                seenUtterances.set(utterance.utteranceId, segment.speakerId);

                // Add to all utterances (for full context)
                allSubjectUtterances.push({
                    utteranceId: utterance.utteranceId,
                    text: utterance.text,
                    speakerId: segment.speakerId,
                    speakerName: segment.speakerName,
                    timestamp: utterance.startTimestamp
                });

                // Add to speaker-specific group
                // Use speakerId if available, otherwise fall back to speakerName
                const speakerKey = segment.speakerId || (segment.speakerName ? `name:${segment.speakerName}` : null);
                if (speakerKey) {
                    if (!utterancesBySpeaker[speakerKey]) {
                        utterancesBySpeaker[speakerKey] = [];
                    }
                    utterancesBySpeaker[speakerKey].push({
                        utteranceId: utterance.utteranceId,
                        text: utterance.text
                    });
                }
            }
        }
    }

    // Report duplicate utterances with different speakers
    if (duplicateUtterances.length > 0) {
        console.warn(`   ⚠️  CRITICAL: Found ${duplicateUtterances.length} duplicate utterances attributed to different speakers!`);
        console.warn(`   This indicates corrupted/duplicate data in the transcript.`);

        // Group duplicates by speakers to show patterns
        const speakerPairs = new Map<string, number>();
        for (const dup of duplicateUtterances) {
            const key = `${dup.firstSpeaker} vs ${dup.duplicateSpeaker}`;
            speakerPairs.set(key, (speakerPairs.get(key) || 0) + 1);
        }

        console.warn(`   Speaker pair conflicts:`);
        for (const [pair, count] of speakerPairs.entries()) {
            console.warn(`      - ${pair}: ${count} utterances`);
        }

        console.warn(`   → Keeping first occurrence and skipping duplicates`);
    }

    // Sort all utterances by timestamp to maintain chronological order
    allSubjectUtterances.sort((a, b) => a.timestamp - b.timestamp);

    return {
        utterancesBySpeaker,
        allSubjectUtterances
    };
}

/**
 * Generate speaker contributions in batches to avoid token exhaustion.
 * For large subjects with many speakers, processing all at once can exceed max_tokens (64K).
 * This function splits speakers into batches and processes each batch separately.
 */
export async function generateSpeakerContributionsInBatches(
    utterancesBySpeaker: Record<string, Array<{ utteranceId: string; text: string }>>,
    allSubjectUtterances: Array<{
        utteranceId: string;
        text: string;
        speakerId: string | null;
        speakerName: string | null;
        timestamp: number;
    }>,
    subject: SubjectInProgress,
    idCompressor: IdCompressor,
    administrativeBodyName?: string
): Promise<{ contributions: SpeakerContribution[]; usage: Anthropic.Messages.Usage }> {
    const speakerIds = Object.keys(utterancesBySpeaker);
    const totalSpeakers = speakerIds.length;

    // Configuration
    const INITIAL_BATCH_SIZE = 15;  // Start with 15 speakers per batch
    const MIN_BATCH_SIZE = 2;       // Minimum batch size for retry

    console.log(`   📦 Processing ${totalSpeakers} speakers in batches (batch size: ${INITIAL_BATCH_SIZE})`);

    const allContributions: SpeakerContribution[] = [];
    let totalUsage = NO_USAGE;
    let currentBatchSize = INITIAL_BATCH_SIZE;
    let batchNumber = 0;

    // Use while loop for proper batch size management during retries
    let i = 0;
    while (i < speakerIds.length) {
        batchNumber++;
        const batchSpeakerIds = speakerIds.slice(i, i + currentBatchSize);
        const totalBatches = Math.ceil(speakerIds.length / currentBatchSize);

        console.log(`   📦 Processing batch ${batchNumber}/${totalBatches} (${batchSpeakerIds.length} speakers, starting at index ${i})`);

        // Create a subset with only this batch's speakers
        const batchUtterancesBySpeaker: Record<string, Array<{ utteranceId: string; text: string }>> = {};
        for (const speakerId of batchSpeakerIds) {
            batchUtterancesBySpeaker[speakerId] = utterancesBySpeaker[speakerId];
        }

        try {
            // Process this batch using the existing single-call function
            const { contributions: batchContributions, usage: batchUsage } = await generateAllSpeakerContributionsInOneCall(
                batchUtterancesBySpeaker,
                allSubjectUtterances,  // Full context for understanding
                subject,
                idCompressor,
                administrativeBodyName
            );

            allContributions.push(...batchContributions);
            totalUsage = addUsage(totalUsage, batchUsage);
            console.log(`   ✓ Batch ${batchNumber} completed: ${batchContributions.length} contributions generated (${formatTokenCount(batchUsage.input_tokens)} input, ${formatTokenCount(batchUsage.output_tokens)} output)`);

            // Move forward by the actual number of speakers processed
            i += batchSpeakerIds.length;
            // Reset batch size on success (in case it was reduced due to previous failures)
            currentBatchSize = INITIAL_BATCH_SIZE;

        } catch (error) {
            console.error(`   ✗ Batch ${batchNumber} failed:`, error instanceof Error ? error.message : String(error));

            // Retry with smaller batch if possible
            if (currentBatchSize > MIN_BATCH_SIZE) {
                const newBatchSize = Math.max(MIN_BATCH_SIZE, Math.floor(currentBatchSize / 2));
                console.log(`   🔄 Retrying with smaller batch size: ${newBatchSize}`);
                currentBatchSize = newBatchSize;
                // Don't increment i - retry same position with smaller batch
                continue;
            }

            // If batch size is already at minimum, generate fallback contributions
            console.error(`   ⚠️  Batch ${batchNumber} failed even at minimum batch size. Generating fallback contributions.`);
            for (const key of batchSpeakerIds) {
                const isNameBased = key.startsWith('name:');
                allContributions.push({
                    speakerId: isNameBased ? null : key,
                    speakerName: isNameBased ? key.slice(5) : null,
                    text: "Σφάλμα κατά τη δημιουργία περίληψης."
                });
            }
            // Move forward past the failed batch
            i += batchSpeakerIds.length;
        }
    }

    console.log(`   ✓ All batches completed: ${allContributions.length} total contributions`);

    // Deduplicate contributions by speaker key (safety net)
    const contributionsBySpeaker = new Map<string, SpeakerContribution>();
    const duplicates: string[] = [];

    for (const contrib of allContributions) {
        const key = contrib.speakerId || `name:${contrib.speakerName}`;
        if (contributionsBySpeaker.has(key)) {
            duplicates.push(key);
        } else {
            contributionsBySpeaker.set(key, contrib);
        }
    }

    if (duplicates.length > 0) {
        console.warn(`   ⚠️  Detected ${duplicates.length} duplicate speaker contributions (keeping first occurrence):`);
        const uniqueDuplicates = [...new Set(duplicates)];
        uniqueDuplicates.forEach(key => {
            console.warn(`      - Speaker: ${key}`);
        });
    }

    const deduplicatedContributions = Array.from(contributionsBySpeaker.values());
    console.log(`   📊 After deduplication: ${deduplicatedContributions.length} unique contributions`);

    return { contributions: deduplicatedContributions, usage: totalUsage };
}

/**
 * Generate contributions for all speakers in a single AI call.
 * Used by the batching function to process speaker subsets.
 */
export async function generateAllSpeakerContributionsInOneCall(
    utterancesBySpeaker: Record<string, Array<{ utteranceId: string; text: string }>>,
    allSubjectUtterances: Array<{
        utteranceId: string;
        text: string;
        speakerId: string | null;
        speakerName: string | null;
        timestamp: number;
    }>,
    subject: SubjectInProgress,
    idCompressor: IdCompressor,
    administrativeBodyName?: string
): Promise<{ contributions: SpeakerContribution[]; usage: Anthropic.Messages.Usage }> {
    const systemPrompt = getSpeakerContributionsSystemPrompt(administrativeBodyName);

    // Build a mapping from speaker keys to their display names
    // For name-based keys (name:Παπαδόπουλος), extract the name
    const speakerKeyToName = new Map<string, string | null>();
    for (const u of allSubjectUtterances) {
        const key = u.speakerId || (u.speakerName ? `name:${u.speakerName}` : null);
        if (key && !speakerKeyToName.has(key)) {
            speakerKeyToName.set(key, u.speakerName);
        }
    }

    // Build speakers list with their utterances
    const speakersList = Object.entries(utterancesBySpeaker)
        .map(([speakerKey, utterances]) => `
**Speaker: ${speakerKey}**
${utterances.map(u => `- [${u.utteranceId}] "${u.text}"`).join('\n')}
`).join('\n\n');

    // Format the full subject discussion for context
    const fullDiscussion = allSubjectUtterances
        .map((u, idx) => {
            const speakerLabel = u.speakerName || (u.speakerId ? u.speakerId : 'Unknown');
            return `${idx + 1}. [${speakerLabel}] (${formatTime(u.timestamp)}): "${u.text}" [${u.utteranceId}]`;
        })
        .join('\n');

    const userPrompt = `
Θέμα: ${subject.name}
Περιγραφή: ${subject.description}

═══════════════════════════════════════════════════════════════════════════
ΟΛΟΙ ΟΙ ΟΜΙΛΗΤΕΣ ΚΑΙ ΤΑ UTTERANCES ΤΟΥΣ
═══════════════════════════════════════════════════════════════════════════

${speakersList}

═══════════════════════════════════════════════════════════════════════════
ΠΛΗΡΗΣ ΣΥΖΗΤΗΣΗ (ΓΙΑ ΠΛΑΙΣΙΟ)
═══════════════════════════════════════════════════════════════════════════

${fullDiscussion}

═══════════════════════════════════════════════════════════════════════════

Δημιούργησε contributions όπως περιγράφεται παραπάνω.
`;

    try {
        const result = await aiChat<{ speakerContributions: SpeakerContribution[] }>({
            model: "claude-opus-4-6",
            systemPrompt,
            userPrompt,
            outputFormat: {
                type: "json_schema",
                schema: {
                    type: "object",
                    properties: {
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
                    required: ["speakerContributions"],
                    additionalProperties: false
                }
            },
            cacheSystemPrompt: true  // Cache system prompt across speaker batches
        });

        // VALIDATION: Verify all returned speakerIds exist in the input
        const validSpeakerKeys = new Set(Object.keys(utterancesBySpeaker));
        const invalidContributions: SpeakerContribution[] = [];
        const validContributions: SpeakerContribution[] = [];

        for (const contrib of result.result.speakerContributions) {
            const key = contrib.speakerId!;
            if (!validSpeakerKeys.has(key)) {
                console.warn(`   ⚠️  LLM returned contribution for unknown speaker key: ${key}`);
                console.warn(`      This speaker was not in the input data!`);
                invalidContributions.push(contrib);
            } else {
                // Map speaker key back to proper speakerId/speakerName
                const isNameBased = key.startsWith('name:');
                validContributions.push({
                    speakerId: isNameBased ? null : key,
                    speakerName: speakerKeyToName.get(key) || (isNameBased ? key.slice(5) : null),
                    text: contrib.text
                });
            }
        }

        if (invalidContributions.length > 0) {
            console.warn(`   🚨 CRITICAL: LLM hallucinated ${invalidContributions.length} speaker contributions!`);
            console.warn(`   Valid speakers in input: ${Array.from(validSpeakerKeys).join(', ')}`);
            console.warn(`   Invalid speaker keys returned: ${invalidContributions.map(c => c.speakerId).join(', ')}`);
            console.warn(`   → Filtering out invalid contributions`);
        }

        return {
            contributions: validContributions,
            usage: result.usage
        };
    } catch (error) {
        console.error("Error generating speaker contributions:", error);
        // Return fallback contributions for all speakers
        return {
            contributions: Object.keys(utterancesBySpeaker).map(key => ({
                speakerId: key.startsWith('name:') ? null : key,
                speakerName: speakerKeyToName.get(key) || (key.startsWith('name:') ? key.slice(5) : null),
                text: "Σφάλμα κατά τη δημιουργία περίληψης."
            })),
            usage: NO_USAGE
        };
    }
}
