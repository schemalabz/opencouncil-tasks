import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockAiChat } = vi.hoisted(() => ({ mockAiChat: vi.fn() }));
vi.mock('../../lib/ai.js', () => ({
    aiChat: mockAiChat,
    addUsage: (a: Record<string, number>, b: Record<string, number>) => ({
        input_tokens: (a.input_tokens || 0) + (b.input_tokens || 0),
        output_tokens: (a.output_tokens || 0) + (b.output_tokens || 0),
    }),
    NO_USAGE: { input_tokens: 0, output_tokens: 0 },
    classifyTransientError: () => null,
    logToFile: vi.fn().mockResolvedValue(undefined),
}));

import { processSingleBatch, processBatchesWithState } from './batchProcessing.js';
import { IdCompressor } from '../../utils.js';
import type { CompressedTranscript, SubjectInProgress } from './types.js';

const meta = { cityName: 'Αθήνα', date: '2026-01-01', topicLabels: [] };
const reply = (subjects: SubjectInProgress[]) => ({
    result: { segmentSummaries: [], subjects, utteranceStatuses: [] },
    usage: { input_tokens: 1, output_tokens: 1 },
    maxTokens: 128000,
});
const subject = (over: Partial<SubjectInProgress> = {}): SubjectInProgress => ({
    id: 's1', type: 'IN_AGENDA', agendaItemIndex: 1, name: 'Προϋπολογισμός', description: 'd',
    topicImportance: 'normal', proximityImportance: 'none', introducedByPersonId: null,
    locationText: null, topicLabel: null, discussedIn: null, speakerContributions: [], ...over,
});

describe('processSingleBatch — outcome', () => {
    beforeEach(() => { mockAiChat.mockReset(); });

    it('makes the model fill outcome for every subject, as a string or null', async () => {
        mockAiChat.mockResolvedValueOnce(reply([]));

        await processSingleBatch([], 0, 1, { subjects: [] }, meta);

        const items = mockAiChat.mock.calls[0][0].outputFormat.schema.properties.subjects.items;
        expect(items.properties.outcome).toEqual({ type: ['string', 'null'] });
        expect(items.required).toContain('outcome');
    });
});

describe('processBatchesWithState — outcome across batches', () => {
    beforeEach(() => { mockAiChat.mockReset(); });

    // Two segments of 70K characters: the 120K batch limit puts them in two batches.
    const segment = (n: number): CompressedTranscript[number] => ({
        speakerName: 'A', speakerParty: null, speakerRole: null, speakerId: null,
        speakerSegmentId: `seg${n}`, text: 'x'.repeat(70_000), utterances: [],
    });
    const run = (batch1: (id: string) => SubjectInProgress[], batch2: (id: string) => SubjectInProgress[]) => {
        const idCompressor = new IdCompressor();
        const id = idCompressor.addLongId('subject-long-id');
        mockAiChat.mockResolvedValueOnce(reply(batch1(id))).mockResolvedValueOnce(reply(batch2(id)));
        const existingSubjects = [{ id, name: 'Προϋπολογισμός', description: 'd', agendaItemIndex: 1, introducedByPersonId: null, locationText: null, topicLabel: null }];
        return processBatchesWithState({ transcript: [segment(1), segment(2)], existingSubjects, ...meta }, idCompressor, () => {})
            .then(out => ({ out, outcome: out.subjects.find(s => s.id === id)?.outcome }));
    };

    it('keeps the outcome of batch 1 when batch 2 returns the subject with null', async () => {
        const { outcome } = await run(
            id => [subject({ id, outcome: 'Εγκρίθηκε ο προϋπολογισμός.' })],
            id => [subject({ id, outcome: null })],
        );

        expect(mockAiChat).toHaveBeenCalledTimes(2);
        expect(outcome).toBe('Εγκρίθηκε ο προϋπολογισμός.');
    });

    it('keeps the outcome of batch 1 when batch 2 does not return the subject', async () => {
        const { outcome } = await run(id => [subject({ id, outcome: 'Εγκρίθηκε ο προϋπολογισμός.' })], () => []);

        expect(outcome).toBe('Εγκρίθηκε ο προϋπολογισμός.');
    });

    it('takes the outcome a later batch writes', async () => {
        const { outcome } = await run(
            id => [subject({ id, outcome: null })],
            id => [subject({ id, outcome: 'Εγκρίθηκε κατά πλειοψηφία ο προϋπολογισμός.' })],
        );

        expect(outcome).toBe('Εγκρίθηκε κατά πλειοψηφία ο προϋπολογισμός.');
    });
});
