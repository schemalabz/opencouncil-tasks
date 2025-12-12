/*
 * Generic task types
 */

import { z } from 'zod';

export interface TaskUpdate<T> {
    status: "processing" | "success" | "error";
    stage: string;
    progressPercent: number;
    result?: T;
    error?: string;
    version: number | undefined;
}

export interface TaskRequest {
    callbackUrl: string;
}

/*
 * System endpoints
 */

export interface HealthResponse {
    status: 'healthy' | 'unhealthy';
    timestamp: string;
    environment: string;
    version: string;
    name: string;
}

export type MediaType = "audio" | "video";

/*
 * Task: Transcribe
 */

export interface TranscribeRequest extends TaskRequest {
    youtubeUrl: string;
    customVocabulary?: string[];
    customPrompt?: string;
    voiceprints?: Voiceprint[];
}

export type TranscriptWithUtteranceDrifts = Transcript & {
    transcription: {
        utterances: (Utterance & { drift: number })[];
    };
};

// Processed speaker information in the final transcript
export interface SpeakerIdentificationResult extends DiarizationSpeakerMatch {
    speaker: number;  // Numeric speaker ID used in utterances
}

export type TranscriptWithSpeakerIdentification = TranscriptWithUtteranceDrifts & {
    transcription: {
        speakers: SpeakerIdentificationResult[];
    };
}

export interface TranscribeResult {
    videoUrl: string;
    audioUrl: string;
    muxPlaybackId: string;
    transcript: TranscriptWithSpeakerIdentification;
}

/*
 * Task: Diarize
 */

export interface DiarizeRequest extends TaskRequest {
    audioUrl: string;
    voiceprints?: Voiceprint[];
}

interface DiarizationSpeakerMatch {
    match: string | null;  // The identified personId if there's a match
    confidence: { [personId: string]: number; };
}

export interface DiarizationSpeaker extends DiarizationSpeakerMatch {
    speaker: string;  // The speaker ID from diarization (may include SEG prefix)
}

export type Diarization = {
    start: number;
    end: number;
    speaker: string;
}[];

export type DiarizeResult = {
    diarization: Diarization;
    speakers: DiarizationSpeaker[];
};

export type Voiceprint = {
    personId: string;
    voiceprint: string;
}

/*
 * Task: Process Agenda
 */

export interface ProcessAgendaRequest extends TaskRequest {
    agendaUrl: string;
    people: {
        id: string;
        name: string;
        role: string;
        party: string;
    }[];
    topicLabels: string[];
    cityName: string;
    date: string;
}

export interface SubjectContext {
    text: string;
    citationUrls: string[];
}

export interface SpeakerSegment {
    speakerSegmentId: string;
    summary: string | null;
}

export interface Location {
    type: "point" | "lineString" | "polygon";
    text: string; // e.g. an area, an address, a road name
    coordinates: number[][]; // a sequence of coordinates. just one coordinate for a point, more for a line or polygon
}

/**
 * Zod schema for extracted subjects (used in processAgenda and summarize tasks)
 * This is the source of truth for AI-extracted subject structure (before geocoding/enhancement)
 */
export const extractedSubjectSchema = z.object({
  name: z.string(),
  description: z.string(),
  agendaItemIndex: z.union([z.number(), z.literal("BEFORE_AGENDA"), z.literal("OUT_OF_AGENDA")]),
  introducedByPersonId: z.string().nullable(),
  speakerSegments: z.array(z.object({
    speakerSegmentId: z.string(),
    summary: z.string().nullable()
  })),
  highlightedUtteranceIds: z.array(z.string()),
  locationText: z.string().nullable().describe('Raw location text extracted by AI, e.g. "Πλατεία Συντάγματος"'),
  topicLabel: z.string().nullable()
});

/**
 * TypeScript type inferred from Zod schema
 * Represents the raw AI-extracted subject (before geocoding location or adding web context)
 */
export type ExtractedSubject = z.infer<typeof extractedSubjectSchema>;

/**
 * Subject: Final API type derived from ExtractedSubject
 * 
 * Transformation pipeline:
 *   ExtractedSubject → geocoding → web enhancement → Subject
 * 
 * Type-level transformation:
 *   - locationText (string) → location (Location with coordinates via Google Maps API)
 *   - Adds context (SubjectContext via Perplexity Sonar)
 */
export interface Subject extends Omit<ExtractedSubject, 'locationText'> {
    location: Location | null;
    context: SubjectContext | null;
}

export interface ProcessAgendaResult {
    subjects: Subject[];
}

/*
 * Transcript
 * see https://docs.gladia.io/api-reference/v2/transcription/get#response-result
 */

export interface Transcript {
    metadata: {
        audio_duration: number;
        number_of_distinct_channels: number;
        billing_time: number;
        transcription_time: number;
    };
    transcription: {
        languages: string[];
        full_transcript: string;
        utterances: Utterance[];
    };
}

export interface Utterance {
    text: string;
    language: string;
    start: number;
    end: number;
    confidence: number;
    channel: number;
    speaker: number;
    drift: number;
    words: Word[];
}

export interface Word {
    word: string;
    start: number;
    end: number;
    confidence: number;
}

/*
 * (Base) Request on Transcript
 */

// A generic type for requests that need a transcript as input
export interface RequestOnTranscript extends TaskRequest {
    transcript: {
        speakerName: string | null;
        speakerParty: string | null;
        speakerRole: string | null;
        speakerSegmentId: string;
        text: string;
        utterances: {
            text: string;
            utteranceId: string;
            startTimestamp: number;
            endTimestamp: number;
        }[];
    }[];
    topicLabels: string[];
    cityName: string;
    partiesWithPeople: {
        name: string;
        people: {
            name: string;
            role: string;
        }[];
    }[];
    date: string;
}

/*
 * Fix Transcript
 */

export interface FixTranscriptRequest extends RequestOnTranscript { }

export interface FixTranscriptResult {
    updateUtterances: {
        utteranceId: string;
        markUncertain: boolean;
        text: string;
    }[];
}

/*
 * Summarize
 */

export interface SummarizeRequest extends RequestOnTranscript {
    requestedSubjects: string[];
    existingSubjects: Subject[];
    additionalInstructions?: string;
}

/**
 * Zod schema for speaker segment summaries
 * This is the source of truth - TypeScript types are inferred from this
 */
export const speakerSegmentSummarySchema = z.object({
  speakerSegmentId: z.string(),
  topicLabels: z.array(z.string()),
  summary: z.string().nullable(),
  type: z.enum(["PROCEDURAL", "SUBSTANTIAL"]).describe(
    'PROCEDURAL: administrative/procedural discussion. SUBSTANTIAL: actual policy/topic discussion'
  )
});

/**
 * TypeScript type inferred from Zod schema
 */
export type SpeakerSegmentSummary = z.infer<typeof speakerSegmentSummarySchema>;

export interface SummarizeResult {
    speakerSegmentSummaries: SpeakerSegmentSummary[];
    subjects: Subject[];
}

/*
 * Produce Podcast
 */

export interface GeneratePodcastSpecRequest extends RequestOnTranscript {
    subjects: {
        name: string;
        description: string;
        speakerSegmentIds: string[];
        highlightedUtteranceIds: string[];
        allocation: "onlyMention" | "skip" | "full";
        allocatedMinutes: number;
    }[];

    audioUrl: string;
    additionalInstructions?: string;
}

export type PodcastPart =
    | {
        type: "host";
        text: string;
    }
    | {
        type: "audio";
        utteranceIds: string[];
    };

export interface GeneratePodcastSpecResult {
    parts: PodcastPart[];
}

/*
 * Split Media File
 */

export interface SplitMediaFileRequest extends TaskRequest {
    url: string; // an mp4 or mp3 url
    type: MediaType;
    parts: {
        // a part of the file, consisting of multiple contiguous segments
        id: string;
        segments: {
            // a contiguous segments of the media file
            startTimestamp: number;
            endTimestamp: number;
        }[];
    }[];
}

export interface SplitMediaFileResult {
    parts: {
        id: string;
        url: string;
        type: MediaType;
        duration: number;
        startTimestamp: number;
        endTimestamp: number;
        muxPlaybackId?: string;
    }[];
}

/*
 * Generate Highlight
 */
export interface GenerateHighlightRequest extends TaskRequest {
    media: {
        type: 'video';
        videoUrl: string;
    };
    parts: Array<{
        id: string; // highlightId
        utterances: Array<{
            utteranceId: string;
            startTimestamp: number;
            endTimestamp: number;
            text: string;
            speaker?: {
                id?: string;
                name?: string;
                partyColorHex?: string;
                partyLabel?: string;
                roleLabel?: string;
            };
        }>;
    }>;
    render: {
        includeCaptions?: boolean;
        includeSpeakerOverlay?: boolean;
        aspectRatio?: AspectRatio;
        
        // Social media formatting options (only used when aspectRatio is 'social-9x16')
        socialOptions?: {
            marginType?: 'blur' | 'solid';
            backgroundColor?: string;
            zoomFactor?: number;
        };
    };

    // Development options
    skipCapture?: boolean; // Set to true to prevent payload capture during testing
}
// Shared rendering types
export type AspectRatio = 'default' | 'social-9x16';

export interface GenerateHighlightResult {
    parts: Array<{
        id: string; // highlightId
        url: string;
        muxPlaybackId?: string;
        duration: number;
        startTimestamp: number;
        endTimestamp: number;
    }>;
}

/**
 * Generate Voiceprint Task Types
 */

export interface GenerateVoiceprintRequest extends TaskRequest {
    mediaUrl: string; // URL to audio or video source
    segmentId: string; // Speaker segment ID used for the voiceprint
    startTimestamp: number; // Start timestamp in the media file
    endTimestamp: number; // End timestamp in the media file
    // Used only for file naming in S3
    cityId: string;
    personId: string;
}

export interface GenerateVoiceprintResult {
    audioUrl: string; // URL to the extracted audio
    voiceprint: string; // Voiceprint embedding vector in base64
    duration: number; // Duration of the audio
}
