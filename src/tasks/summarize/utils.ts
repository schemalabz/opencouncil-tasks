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
        if (currentPartLength + itemLength > maxLengthChars) {
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
        speakerContributions: []
    }));
}

/**
 * Convert discussion ranges to per-utterance status mapping.
 * Note: If ranges overlap, first matching range (by chronological order) wins.
 */
export function convertRangesToUtteranceStatuses(
    ranges: DiscussionRange[],
    transcript: CompressedTranscript
): Array<{ utteranceId: string; status: DiscussionStatus; subjectId: string | null }> {
    const utteranceStatuses: Array<{ utteranceId: string; status: DiscussionStatus; subjectId: string | null }> = [];

    // Build chronological index map for utterances
    const utteranceIndex = buildUtteranceIndexMap(transcript);

    const allUtterances: Array<{ utteranceId: string; segmentIndex: number; utteranceIndex: number }> = [];
    transcript.forEach((segment, segmentIndex) => {
        segment.utterances.forEach((utterance, utteranceIdx) => {
            allUtterances.push({
                utteranceId: utterance.utteranceId,
                segmentIndex,
                utteranceIndex: utteranceIdx
            });
        });
    });

    // Convert ranges to use indices and sort by start index
    const rangesWithIndices = ranges.map(range => ({
        range,
        startIndex: range.startUtteranceId
            ? utteranceIndex.get(range.startUtteranceId) ?? 0
            : 0,
        endIndex: range.endUtteranceId
            ? utteranceIndex.get(range.endUtteranceId) ?? Infinity
            : Infinity
    }));

    const sortedRanges = rangesWithIndices.sort((a, b) => a.startIndex - b.startIndex);

    // Assign status to each utterance
    for (const utterance of allUtterances) {
        // Find the range this utterance belongs to
        let assignedRange: DiscussionRange | null = null;
        const currentIndex = utteranceIndex.get(utterance.utteranceId);

        if (currentIndex !== undefined) {
            for (const { range, startIndex, endIndex } of sortedRanges) {
                // Use numerical comparison on indices instead of string comparison on IDs
                const inRange = currentIndex >= startIndex && currentIndex <= endIndex;

                if (inRange) {
                    assignedRange = range;
                    break; // First match wins (ranges should not overlap)
                }
            }
        }

        // Assign status (default to OTHER if no range found)
        utteranceStatuses.push({
            utteranceId: utterance.utteranceId,
            status: assignedRange?.status ?? DiscussionStatus.OTHER,
            subjectId: assignedRange?.subjectId ?? null
        });
    }

    return utteranceStatuses;
}
