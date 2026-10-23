import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IdCompressor } from '../../utils.js';
import type { BatchProcessingResult, CompressedTranscript, SubjectInProgress } from './types.js';

/**
 * Mock aiChat with scripted batch responses; the batch loop around it
 * (state carried across batches, id registration, left-out subjects) is
 * the real code.
 */
vi.mock('../../lib/ai.js', () => {
    const NO_USAGE = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null, server_tool_use: null, service_tier: null, inference_geo: null, output_tokens_details: null };
    return {
        aiChat: vi.fn(),
        addUsage: vi.fn((a) => a),
        NO_USAGE,
        classifyTransientError: vi.fn(() => null),
        logToFile: vi.fn(async () => undefined),
    };
});

import { aiChat } from '../../lib/ai.js';
import { processBatchesWithState } from './batchProcessing.js';

const mockAiChat = vi.mocked(aiChat);

// Each segment is ~70K chars and a batch holds 120K, so three segments make three batches.
function transcript(): CompressedTranscript {
    return [1, 2, 3].map(n => ({
        speakerSegmentId: `seg-${n}`,
        speakerId: null,
        speakerName: `Speaker ${n}`,
        speakerParty: null,
        speakerRole: null,
        text: 'x'.repeat(70_000),
        utterances: [{ utteranceId: `utt-${n}`, text: 'x', startTimestamp: n, endTimestamp: n + 1 }],
    })) as unknown as CompressedTranscript;
}

function returned(id: string, name: string, topicImportance: SubjectInProgress['topicImportance'], proximityImportance: SubjectInProgress['proximityImportance'], type: SubjectInProgress['type'] = 'IN_AGENDA'): SubjectInProgress {
    return {
        id, name, type,
        agendaItemIndex: type === 'IN_AGENDA' ? 1 : type,
        description: `Description for ${name}`,
        topicImportance, proximityImportance,
        introducedByPersonId: null, locationText: null, topicLabel: null,
        speakerContributions: [], discussedIn: null,
    };
}

function batchResponse(subjects: SubjectInProgress[]) {
    const result: BatchProcessingResult = { segmentSummaries: [], subjects, utteranceStatuses: [], meetingProgressSummary: 'progress' } as BatchProcessingResult;
    return { result, usage: {}, maxTokens: 128000, resolvedModel: 'test-model', batchMode: false } as never;
}

describe('processBatchesWithState importance across batches', () => {
    beforeEach(() => mockAiChat.mockReset());

    it('keeps the importance the model gave a subject that a later batch leaves out', async () => {
        const ids = new IdCompressor();
        const a = ids.addLongId('subject-a');
        const b = ids.addLongId('subject-b');
        const c = ids.addLongId('subject-c');
        const d = ids.addLongId('subject-d');
        const e = ids.addLongId('subject-e');
        const existing = [
            { id: a, name: 'A', description: 'A', agendaItemIndex: 1, introducedByPersonId: null, locationText: null, topicLabel: null, topicImportance: 'normal', proximityImportance: 'none' },
            { id: b, name: 'B', description: 'B', agendaItemIndex: 2, introducedByPersonId: null, locationText: null, topicLabel: null, topicImportance: 'normal', proximityImportance: 'none' },
            { id: c, name: 'C', description: 'C', agendaItemIndex: 3, introducedByPersonId: null, locationText: null, topicLabel: null, topicImportance: 'normal', proximityImportance: 'none' },
            { id: d, name: 'D', description: 'D', agendaItemIndex: 4, introducedByPersonId: null, locationText: null, topicLabel: null, topicImportance: 'high', proximityImportance: 'wide' },
            { id: e, name: 'E', description: 'E', agendaItemIndex: 5, introducedByPersonId: null, locationText: null, topicLabel: null, topicImportance: 'normal', proximityImportance: 'none' },
        ];

        mockAiChat
            // Batch 1: A, E, plus a subject the model creates with a temporary id
            .mockResolvedValueOnce(batchResponse([
                returned(a, 'A', 'high', 'wide'),
                returned(e, 'E', 'high', 'none'),
                returned('new-001', 'Announcements', 'normal', 'none', 'BEFORE_AGENDA'),
            ]))
            // Batch 2: A again (new value) and B
            .mockResolvedValueOnce(batchResponse([
                returned(a, 'A', 'normal', 'near'),
                returned(b, 'B', 'high', 'none'),
            ]))
            // Batch 3: C, and E again after batch 2 left it out
            .mockResolvedValueOnce(batchResponse([
                returned(c, 'C', 'normal', 'none'),
                returned(e, 'E', 'normal', 'near'),
            ]));

        const { subjects } = await processBatchesWithState(
            { transcript: transcript(), existingSubjects: existing, cityName: 'City', date: '2026-10-21', topicLabels: [] },
            ids,
            () => {},
        );

        expect(mockAiChat).toHaveBeenCalledTimes(3);
        const importance = Object.fromEntries(subjects.map(s => [s.name, [s.topicImportance, s.proximityImportance]]));
        expect(importance).toEqual({
            A: ['normal', 'near'],                      // last value the model gave, in batch 2
            B: ['high', 'none'],                        // returned in batch 2 only
            C: ['normal', 'none'],                      // returned in the last batch
            D: ['doNotNotify', 'none'],                 // never returned: the agenda value does not carry through
            E: ['normal', 'near'],                      // kept through batch 2, then the model's batch-3 value
            Announcements: ['normal', 'none'],          // created in batch 1 under a temporary id
        });
    });
});
