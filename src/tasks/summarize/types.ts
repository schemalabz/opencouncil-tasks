/**
 * Type definitions for the summarize task.
 * Internal types used during batch processing and speaker contribution generation.
 */

import { SummarizeRequest, SpeakerContribution, DiscussionStatus } from "../../types.js";
import { compressIds } from "./compression.js";

/**
 * SpeakerSegment type (transcript segment without utterances)
 */
export type SpeakerSegment = Omit<SummarizeRequest['transcript'][number], 'utterances'>;

/**
 * CompressedTranscript type (result of ID compression)
 */
export type CompressedTranscript = ReturnType<typeof compressIds>['transcript'];

/**
 * Subject in progress during batch processing.
 * This is an intermediate representation before enrichment.
 */
export interface SubjectInProgress {
    id: string;  // UUID
    type: 'IN_AGENDA' | 'BEFORE_AGENDA' | 'OUT_OF_AGENDA';
    agendaItemIndex: number | "BEFORE_AGENDA" | "OUT_OF_AGENDA";  // Matches Subject type
    name: string;  // LLM can update
    description: string;  // LLM can update
    topicImportance: 'doNotNotify' | 'normal' | 'high';
    proximityImportance: 'none' | 'near' | 'wide';
    introducedByPersonId: string | null;
    locationText: string | null;
    topicLabel: string | null;
    speakerContributions: SpeakerContribution[];  // Will be populated after batch processing
}

/**
 * Result from batch processing a transcript chunk.
 */
export interface BatchProcessingResult {
    segmentSummaries: {
        id: string;  // compressed speakerSegmentId
        summary: string;
        labels: string[];
        type: "SUBSTANTIAL" | "PROCEDURAL";
    }[];
    ranges: {
        id: string;  // UUID for range
        start: string | null;  // compressed utteranceId
        end: string | null;    // null = range is "open" (continues beyond batch)
        status: DiscussionStatus;
        subjectId: string | null;  // compressed subject UUID
    }[];
    subjects: SubjectInProgress[];
    discussionSummary?: string;  // 3-4 sentence summary of where the discussion is now
}

/**
 * Utterances grouped by speaker for a specific subject.
 */
export interface ExtractedUtterances {
    utterancesBySpeaker: Record<string, Array<{
        utteranceId: string;
        text: string;
    }>>;
    allSubjectUtterances: Array<{
        utteranceId: string;
        text: string;
        speakerId: string | null;
        speakerName: string | null;
        timestamp: number;
    }>;
}
