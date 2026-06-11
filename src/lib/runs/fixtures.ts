import { Subject, SummarizeResult } from '../../types.js';
import { RunWithResult } from './types.js';

export function makeSubject(overrides: Partial<Subject> & { id: string; name: string }): Subject {
    return {
        description: 'Περιγραφή θέματος.',
        agendaItemIndex: 1,
        introducedByPersonId: null,
        speakerContributions: [],
        topicImportance: 'normal',
        proximityImportance: 'none',
        location: null,
        topicLabel: 'Διοίκηση',
        context: null,
        discussedIn: null,
        ...overrides,
    };
}

export function makeRun(traceId: string, subjects: Subject[], extras?: Partial<SummarizeResult>): RunWithResult {
    return {
        info: {
            traceId,
            timestamp: '2026-06-10T12:00:00Z',
            name: 'summarize',
            meeting: 'dev/test',
            version: 'test',
            env: 'development',
            promptsHash: null,
            isError: false,
            totalCost: null,
            latencySeconds: null,
        },
        result: {
            speakerSegmentSummaries: [],
            subjects,
            utteranceDiscussionStatuses: [],
            ...extras,
        },
    };
}
