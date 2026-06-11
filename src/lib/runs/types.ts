import { SummarizeResult } from '../../types.js';

/** Metadata of a traced task run, derived from a Langfuse trace. */
export interface RunInfo {
    traceId: string;
    timestamp: string;
    name: string;
    meeting: string | null;     // "cityId/meetingId"
    version: string | null;     // task version tag
    env: string | null;
    promptsHash: string | null; // composite prompt fingerprint tag
    isError: boolean;
    totalCost: number | null;
    latencySeconds: number | null;
}

/** A run's metadata plus its full result payload (the trace output). */
export interface RunWithResult {
    info: RunInfo;
    result: SummarizeResult;
}

/** One side of a compared subject. */
export interface SubjectView {
    id: string;
    name: string;
    description: string;
    agendaItemIndex: number | null;
    nonAgendaReason: 'beforeAgenda' | 'outOfAgenda' | null;
    topic: string | null;
    withdrawn: boolean;
    context: string | null;
    contextCitationUrls: string[];
    discussedIn: string | null;
    topicImportance: string;
    proximityImportance: string;
    contributions: { speakerName: string; text: string; order: number }[];
    utteranceStatuses: Record<string, number>;
}

export type SubjectVerdict = 'identical' | 'cosmetic' | 'structural';

export interface MatchedSubject {
    agendaItemIndex: number | null;  // null when matched by name (e.g. agenda classification flipped between runs)
    matchedBy: 'index' | 'name';
    from: SubjectView;
    to: SubjectView;
    verdict: SubjectVerdict;
    changes: string[];
}

export interface SegmentSample {
    segmentId: string;
    index: number;  // position in transcript order (results carry no timestamps)
    from: { type: string | null; text: string | null };
    to: { type: string | null; text: string | null };
}

export interface SideStats {
    totalSubjects: number;
    agendaSubjects: number;
    beforeAgenda: number;
    outOfAgenda: number;
    totalContributions: number;
    totalUtterancesAssigned: number;
}

export interface ComparisonData {
    schemaVersion: 2;
    generatedAt: string;
    sources: { from: RunInfo; to: RunInfo };
    subjects: {
        matched: MatchedSubject[];
        fromOnly: SubjectView[];
        toOnly: SubjectView[];
    };
    segmentSamples: SegmentSample[];
    stats: { from: SideStats; to: SideStats };
    verdictSummary: Record<SubjectVerdict, number>;
}
