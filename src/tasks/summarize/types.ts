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

    // Reference to primary subject if discussed jointly with other subjects
    // null for primary subjects or independently-discussed subjects
    // ID of primary subject for secondary subjects in joint discussion
    discussedIn: string | null;
}

/**
 * Direct utterance-to-status mapping (replaces range boundaries).
 * Each utterance is explicitly tagged with its discussion status and subject.
 */
export interface UtteranceStatus {
    utteranceId: string;  // compressed utteranceId
    status: DiscussionStatus;
    subjectId: string | null;  // compressed subject UUID (null for ATTENDANCE/OTHER)
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
    subjects: SubjectInProgress[];
    utteranceStatuses: UtteranceStatus[];  // Direct utterance tagging (replaces ranges)
    meetingProgressSummary?: string;  // 2-4 sentence summary of meeting progress for next batch context
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
