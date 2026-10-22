/**
 * Utility functions for the summarize task.
 * Pure helper functions with no side effects.
 */

import { DiscussionStatus, DiscussionRange } from "../../types.js";
import { CompressedTranscript, SubjectInProgress } from "./types.js";

/**
 * Word count target for summaries (configurable constant)
 */
export const requestedSummaryWordCount = 50;

/**
 * Build a chronological index map for utterances.
 * Maps utteranceId → chronological position (0-indexed).
 */
export function buildUtteranceIndexMap(transcript: CompressedTranscript): Map<string, number> {
    const utteranceIndex = new Map<string, number>();
    let chronologicalIndex = 0;
    for (const segment of transcript) {
        for (const utterance of segment.utterances) {
            utteranceIndex.set(utterance.utteranceId, chronologicalIndex++);
        }
    }
    return utteranceIndex;
}

/**
 * Get emoji for discussion status (for logging/debugging).
 */
export function getStatusEmoji(status: DiscussionStatus): string {
    switch (status) {
        case DiscussionStatus.ATTENDANCE: return '📋';
        case DiscussionStatus.SUBJECT_DISCUSSION: return '💬';
        case DiscussionStatus.PROCEDURAL_VOTE: return '⚖️';
        case DiscussionStatus.VOTE: return '🗳️';
        default: return '📝';
    }
}

/**
 * Split transcript into batches based on character length.
 * Used to prevent LLM context overflow.
 */
export function splitTranscript(transcript: any[], maxLengthChars: number) {
    const parts: typeof transcript[] = [];
    let currentPart: typeof transcript = [];
    let currentPartLength = 0;

    for (const item of transcript) {
        const itemLength = JSON.stringify(item).length;
        // Only push current batch if it has items (prevents empty batches when first item exceeds limit)
        if (currentPartLength + itemLength > maxLengthChars && currentPart.length > 0) {
            parts.push(currentPart);
            currentPart = [];
            currentPartLength = 0;
        }
        currentPart.push(item);
        currentPartLength += itemLength;
    }
    if (currentPart.length > 0) {
        parts.push(currentPart);
    }
    return parts;
}

/**
 * Initialize subjects from existing ones (for incremental processing).
 * Converts existing subjects to SubjectInProgress format.
 */
export function initializeSubjectsFromExisting(existingSubjects: any[]): SubjectInProgress[] {
    return existingSubjects.map(s => ({
        id: s.id, // Already compressed
        type: typeof s.agendaItemIndex === 'number' ? 'IN_AGENDA' as const :
            s.agendaItemIndex === 'BEFORE_AGENDA' ? 'BEFORE_AGENDA' as const : 'OUT_OF_AGENDA' as const,
        agendaItemIndex: s.agendaItemIndex, // Keep as-is (number | "BEFORE_AGENDA" | "OUT_OF_AGENDA")
        name: s.name,
        description: s.description,
        topicImportance: s.topicImportance || 'normal',
        proximityImportance: s.proximityImportance || 'none',
        introducedByPersonId: s.introducedByPersonId,
        locationText: s.locationText,
        topicLabel: s.topicLabel,
        ...(s.withdrawn ? { withdrawn: true } : {}),
        discussedIn: s.discussedIn || null,  // Preserve if set, otherwise null
        speakerContributions: []
    }));
}

/**
 * The subjects a batch's response left out, to carry into the next batch.
 *
 * A batch returns only the subjects its part of the transcript touches, so a
 * subject it leaves out may well have been discussed in an earlier batch. A
 * subject that some batch returned keeps the importance that the model gave
 * it: the after-meeting notification reads that importance, and resetting it
 * here dropped discussed subjects from it. A subject that no batch has
 * returned so far gets no notification, whatever the agenda gave it.
 */
export function subjectsOmittedFromBatch(
    previous: SubjectInProgress[],
    returned: SubjectInProgress[],
    returnedByModel: ReadonlySet<string>
): SubjectInProgress[] {
    const returnedIds = new Set(returned.map(s => s.id));
    return previous
        .filter(s => !returnedIds.has(s.id))
        .map(s => ({
            ...s,
            discussedIn: s.discussedIn || null,
            speakerContributions: [],
            ...(returnedByModel.has(s.id) ? {} : {
                topicImportance: 'doNotNotify' as const,
                proximityImportance: 'none' as const
            })
        }));
}

// convertRangesToUtteranceStatuses function has been DELETED
// Utterance statuses are now generated directly by the LLM in batch processing
// No conversion from ranges is needed anymore
