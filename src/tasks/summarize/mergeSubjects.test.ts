import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiscussionStatus } from '../../types.js';
import { SubjectInProgress, UtteranceStatus } from './types.js';

/**
 * Mock aiChat — mergeSubjects delegates merge *decisions* to the LLM,
 * but all merge *application* logic (safety checks, remapping, filtering)
 * is deterministic code that these tests exercise.
 */
vi.mock('../../lib/ai.js', () => ({
    aiChat: vi.fn(),
    addUsage: vi.fn((a, b) => a),
    NO_USAGE: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null, server_tool_use: null, service_tier: null },
}));

import { aiChat } from '../../lib/ai.js';
import { mergeSubjects } from './mergeSubjects.js';

const mockAiChat = vi.mocked(aiChat);
const noUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null, server_tool_use: null, service_tier: null };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a SubjectInProgress with sensible defaults. */
function makeSubject(overrides: Partial<SubjectInProgress> & { id: string; name: string; type: SubjectInProgress['type'] }): SubjectInProgress {
    return {
        description: `Description for ${overrides.name}`,
        agendaItemIndex: overrides.type === 'IN_AGENDA' ? 1 : overrides.type,
        topicImportance: 'normal',
        proximityImportance: 'none',
        introducedByPersonId: null,
        locationText: null,
        topicLabel: null,
        speakerContributions: [],
        discussedIn: null,
        ...overrides,
    };
}

/** Create an utterance status tagged to a subject. */
function makeUtteranceStatus(utteranceId: string, subjectId: string | null, status = DiscussionStatus.SUBJECT_DISCUSSION): UtteranceStatus {
    return { utteranceId, status, subjectId };
}

/** Configure the AI mock to return a specific set of merge operations. */
function mockMergeResponse(merges: Array<{ keepId: string; removeIds: string[]; newName: string; newDescription: string }>) {
    mockAiChat.mockResolvedValueOnce({
        result: { merges },
        usage: noUsage,
    });
}

beforeEach(() => {
    vi.clearAllMocks();
});

// ===========================================================================
// mergeSubjects — Post-batch subject deduplication
//
// After batch processing, the same real-world topic may appear as multiple
// SubjectInProgress entries because batches are processed independently.
// mergeSubjects asks the LLM which subjects should be combined, then applies
// the merges with strict safety rules enforced in code (not the LLM).
// ===========================================================================

describe('mergeSubjects', () => {

    // -----------------------------------------------------------------------
    // Early exits — conditions where no AI call is needed
    // -----------------------------------------------------------------------

    describe('skips AI call entirely when merge is impossible', () => {

        it('returns immediately when fewer than 2 subjects exist', async () => {
            const subjects = [makeSubject({ id: 's1', name: 'Only subject', type: 'IN_AGENDA' })];

            const result = await mergeSubjects(subjects, []);

            expect(mockAiChat).not.toHaveBeenCalled();
            expect(result.subjects).toHaveLength(1);
            expect(result.mergeCount).toBe(0);
        });

        it('returns immediately when no BEFORE_AGENDA subjects exist (nothing can be removed)', async () => {
            // Merge rules: only BEFORE_AGENDA subjects can be removed.
            // If there are none, no merge is possible, so skip the AI call entirely.
            const subjects = [
                makeSubject({ id: 's1', name: 'Agenda item 1', type: 'IN_AGENDA' }),
                makeSubject({ id: 's2', name: 'Out of agenda item', type: 'OUT_OF_AGENDA' }),
            ];

            const result = await mergeSubjects(subjects, []);

            expect(mockAiChat).not.toHaveBeenCalled();
            expect(result.subjects).toHaveLength(2);
            expect(result.mergeCount).toBe(0);
        });
    });

    // -----------------------------------------------------------------------
    // AI says "no merges needed"
    // -----------------------------------------------------------------------

    it('preserves all subjects when AI determines no merges are needed', async () => {
        const subjects = [
            makeSubject({ id: 's1', name: 'Budget discussion', type: 'IN_AGENDA' }),
            makeSubject({ id: 's2', name: 'Unrelated procedural topic', type: 'BEFORE_AGENDA' }),
        ];
        const statuses = [
            makeUtteranceStatus('u1', 's1'),
            makeUtteranceStatus('u2', 's2'),
        ];

        mockMergeResponse([]);

        const result = await mergeSubjects(subjects, statuses);

        expect(result.subjects).toHaveLength(2);
        expect(result.allUtteranceStatuses).toHaveLength(2);
        expect(result.mergeCount).toBe(0);
    });

    // -----------------------------------------------------------------------
    // Core merge behavior — the happy path
    // -----------------------------------------------------------------------

    describe('applying a valid merge', () => {

        it('removes the merged-away subject and updates the kept subject name/description', async () => {
            const subjects = [
                makeSubject({ id: 'keep', name: 'Parking regulation', type: 'IN_AGENDA', agendaItemIndex: 3 }),
                makeSubject({ id: 'remove', name: 'Parking fees discussion', type: 'BEFORE_AGENDA' }),
            ];

            mockMergeResponse([{
                keepId: 'keep',
                removeIds: ['remove'],
                newName: 'Parking regulation and fees',
                newDescription: 'Combined discussion of parking rules and associated fees.',
            }]);

            const result = await mergeSubjects(subjects, []);

            expect(result.subjects).toHaveLength(1);
            expect(result.subjects[0].id).toBe('keep');
            expect(result.subjects[0].name).toBe('Parking regulation and fees');
            expect(result.subjects[0].description).toBe('Combined discussion of parking rules and associated fees.');
            expect(result.mergeCount).toBe(1);
        });

        it('preserves the kept subject structural fields (type, agendaItemIndex, introducedByPersonId)', async () => {
            // Merging should only update name/description — structural fields
            // come from the original subject and must not change.
            const subjects = [
                makeSubject({
                    id: 'keep', name: 'Original', type: 'IN_AGENDA',
                    agendaItemIndex: 5,
                    introducedByPersonId: 'person-123',
                    topicImportance: 'high',
                }),
                makeSubject({ id: 'remove', name: 'Fragment', type: 'BEFORE_AGENDA' }),
            ];

            mockMergeResponse([{
                keepId: 'keep', removeIds: ['remove'],
                newName: 'Updated name', newDescription: 'Updated desc',
            }]);

            const result = await mergeSubjects(subjects, []);
            const kept = result.subjects[0];

            expect(kept.type).toBe('IN_AGENDA');
            expect(kept.agendaItemIndex).toBe(5);
            expect(kept.introducedByPersonId).toBe('person-123');
            expect(kept.topicImportance).toBe('high');
        });

        it('remaps utterance statuses from removed subject to the kept subject', async () => {
            // When a subject is merged away, all utterances that pointed to it
            // must now point to the kept subject.
            const subjects = [
                makeSubject({ id: 'keep', name: 'Main topic', type: 'IN_AGENDA' }),
                makeSubject({ id: 'remove', name: 'Duplicate topic', type: 'BEFORE_AGENDA' }),
            ];
            const statuses = [
                makeUtteranceStatus('u1', 'keep'),
                makeUtteranceStatus('u2', 'remove'),
                makeUtteranceStatus('u3', 'remove'),
                makeUtteranceStatus('u4', null, DiscussionStatus.ATTENDANCE),
            ];

            mockMergeResponse([{
                keepId: 'keep', removeIds: ['remove'],
                newName: 'Main topic', newDescription: 'desc',
            }]);

            const result = await mergeSubjects(subjects, statuses);

            // All subject-discussion utterances now point to 'keep'
            const subjectStatuses = result.allUtteranceStatuses.filter(s => s.subjectId !== null);
            expect(subjectStatuses.every(s => s.subjectId === 'keep')).toBe(true);
            // Non-subject statuses (ATTENDANCE) are untouched
            expect(result.allUtteranceStatuses.find(s => s.utteranceId === 'u4')?.subjectId).toBeNull();
        });

        it('updates discussedIn references when a removed subject was a primary', async () => {
            // If subject C has discussedIn pointing to subject B (secondary → primary),
            // and B gets merged into A, then C.discussedIn must update to A.
            const subjects = [
                makeSubject({ id: 'A', name: 'Main', type: 'IN_AGENDA' }),
                makeSubject({ id: 'B', name: 'Fragment', type: 'BEFORE_AGENDA' }),
                makeSubject({ id: 'C', name: 'Joint topic', type: 'BEFORE_AGENDA', discussedIn: 'B' }),
            ];

            mockMergeResponse([{
                keepId: 'A', removeIds: ['B'],
                newName: 'Main expanded', newDescription: 'desc',
            }]);

            const result = await mergeSubjects(subjects, []);

            const subjectC = result.subjects.find(s => s.id === 'C');
            expect(subjectC?.discussedIn).toBe('A');
        });

        it('handles merging multiple BEFORE_AGENDA subjects into one kept subject', async () => {
            const subjects = [
                makeSubject({ id: 'keep', name: 'Core topic', type: 'IN_AGENDA' }),
                makeSubject({ id: 'frag1', name: 'Fragment 1', type: 'BEFORE_AGENDA' }),
                makeSubject({ id: 'frag2', name: 'Fragment 2', type: 'BEFORE_AGENDA' }),
                makeSubject({ id: 'frag3', name: 'Fragment 3', type: 'BEFORE_AGENDA' }),
            ];
            const statuses = [
                makeUtteranceStatus('u1', 'keep'),
                makeUtteranceStatus('u2', 'frag1'),
                makeUtteranceStatus('u3', 'frag2'),
                makeUtteranceStatus('u4', 'frag3'),
            ];

            mockMergeResponse([{
                keepId: 'keep', removeIds: ['frag1', 'frag2', 'frag3'],
                newName: 'Complete topic', newDescription: 'All fragments merged',
            }]);

            const result = await mergeSubjects(subjects, statuses);

            expect(result.subjects).toHaveLength(1);
            expect(result.mergeCount).toBe(3);
            expect(result.allUtteranceStatuses.every(s => s.subjectId === 'keep')).toBe(true);
        });
    });

    // -----------------------------------------------------------------------
    // Safety checks — code overrides LLM when it violates merge rules
    //
    // The LLM proposes merges, but the code enforces invariants. These tests
    // verify that invalid LLM suggestions are rejected gracefully rather than
    // corrupting the data.
    // -----------------------------------------------------------------------

    describe('safety checks override invalid LLM merge proposals', () => {

        it('refuses to remove an IN_AGENDA subject even if the LLM says to', async () => {
            // IN_AGENDA subjects correspond to officially scheduled agenda items.
            // Removing them would lose structured meeting data.
            const subjects = [
                makeSubject({ id: 'agenda-1', name: 'Budget vote', type: 'IN_AGENDA', agendaItemIndex: 1 }),
                makeSubject({ id: 'agenda-2', name: 'Similar budget item', type: 'IN_AGENDA', agendaItemIndex: 2 }),
                makeSubject({ id: 'before', name: 'Pre-meeting chat', type: 'BEFORE_AGENDA' }),
            ];

            // LLM incorrectly suggests removing an IN_AGENDA subject
            mockMergeResponse([{
                keepId: 'agenda-1', removeIds: ['agenda-2'],
                newName: 'Combined budget', newDescription: 'desc',
            }]);

            const result = await mergeSubjects(subjects, []);

            // agenda-2 must survive — safety check prevents removal
            expect(result.subjects.find(s => s.id === 'agenda-2')).toBeDefined();
            expect(result.subjects).toHaveLength(3);
            expect(result.mergeCount).toBe(0);
        });

        it('refuses to remove an OUT_OF_AGENDA subject even if the LLM says to', async () => {
            // OUT_OF_AGENDA subjects are topics raised outside the official agenda.
            // They are first-class subjects and must not be removed.
            const subjects = [
                makeSubject({ id: 'keep', name: 'Main', type: 'IN_AGENDA' }),
                makeSubject({ id: 'out', name: 'Citizen complaint', type: 'OUT_OF_AGENDA' }),
                makeSubject({ id: 'before', name: 'Related chat', type: 'BEFORE_AGENDA' }),
            ];

            mockMergeResponse([{
                keepId: 'keep', removeIds: ['out'],
                newName: 'Combined', newDescription: 'desc',
            }]);

            const result = await mergeSubjects(subjects, []);

            expect(result.subjects.find(s => s.id === 'out')).toBeDefined();
            expect(result.subjects).toHaveLength(3);
            expect(result.mergeCount).toBe(0);
        });

        it('skips merge when keepId does not exist (LLM hallucinated an ID)', async () => {
            const subjects = [
                makeSubject({ id: 's1', name: 'Topic 1', type: 'IN_AGENDA' }),
                makeSubject({ id: 's2', name: 'Topic 2', type: 'BEFORE_AGENDA' }),
            ];

            mockMergeResponse([{
                keepId: 'nonexistent', removeIds: ['s2'],
                newName: 'Merged', newDescription: 'desc',
            }]);

            const result = await mergeSubjects(subjects, []);

            expect(result.subjects).toHaveLength(2);
            expect(result.mergeCount).toBe(0);
        });

        it('skips individual removal when removeId does not exist', async () => {
            const subjects = [
                makeSubject({ id: 's1', name: 'Topic 1', type: 'IN_AGENDA' }),
                makeSubject({ id: 's2', name: 'Topic 2', type: 'BEFORE_AGENDA' }),
            ];

            mockMergeResponse([{
                keepId: 's1', removeIds: ['nonexistent'],
                newName: 'Updated', newDescription: 'desc',
            }]);

            const result = await mergeSubjects(subjects, []);

            // s2 is untouched, nothing was actually removed
            expect(result.subjects).toHaveLength(2);
            // But name/description of s1 still gets updated since keepId was valid
            expect(result.subjects.find(s => s.id === 's1')?.name).toBe('Updated');
            expect(result.mergeCount).toBe(0);
        });

        it('applies only the valid removals in a mixed valid/invalid merge proposal', async () => {
            // LLM proposes removing both a BEFORE_AGENDA (valid) and an IN_AGENDA (invalid).
            // Only the valid removal should be applied.
            const subjects = [
                makeSubject({ id: 'keep', name: 'Main', type: 'IN_AGENDA' }),
                makeSubject({ id: 'valid-remove', name: 'Fragment', type: 'BEFORE_AGENDA' }),
                makeSubject({ id: 'invalid-remove', name: 'Agenda item 2', type: 'IN_AGENDA' }),
            ];
            const statuses = [
                makeUtteranceStatus('u1', 'valid-remove'),
                makeUtteranceStatus('u2', 'invalid-remove'),
            ];

            mockMergeResponse([{
                keepId: 'keep',
                removeIds: ['valid-remove', 'invalid-remove'],
                newName: 'Combined', newDescription: 'desc',
            }]);

            const result = await mergeSubjects(subjects, statuses);

            // valid-remove is gone, invalid-remove survives
            expect(result.subjects.find(s => s.id === 'valid-remove')).toBeUndefined();
            expect(result.subjects.find(s => s.id === 'invalid-remove')).toBeDefined();
            expect(result.subjects).toHaveLength(2);
            expect(result.mergeCount).toBe(1);
            // u1 was remapped, u2 stays pointing to invalid-remove
            expect(result.allUtteranceStatuses.find(s => s.utteranceId === 'u1')?.subjectId).toBe('keep');
            expect(result.allUtteranceStatuses.find(s => s.utteranceId === 'u2')?.subjectId).toBe('invalid-remove');
        });
    });

    // -----------------------------------------------------------------------
    // Multiple independent merge operations in a single response
    // -----------------------------------------------------------------------

    describe('multiple merge operations', () => {

        it('applies multiple independent merges from a single AI response', async () => {
            const subjects = [
                makeSubject({ id: 'agenda-1', name: 'Roads', type: 'IN_AGENDA' }),
                makeSubject({ id: 'agenda-2', name: 'Schools', type: 'IN_AGENDA' }),
                makeSubject({ id: 'frag-roads', name: 'Road repairs chat', type: 'BEFORE_AGENDA' }),
                makeSubject({ id: 'frag-schools', name: 'School budget chat', type: 'BEFORE_AGENDA' }),
            ];
            const statuses = [
                makeUtteranceStatus('u1', 'frag-roads'),
                makeUtteranceStatus('u2', 'frag-schools'),
            ];

            mockMergeResponse([
                {
                    keepId: 'agenda-1', removeIds: ['frag-roads'],
                    newName: 'Roads and repairs', newDescription: 'desc1',
                },
                {
                    keepId: 'agenda-2', removeIds: ['frag-schools'],
                    newName: 'Schools and budget', newDescription: 'desc2',
                },
            ]);

            const result = await mergeSubjects(subjects, statuses);

            expect(result.subjects).toHaveLength(2);
            expect(result.mergeCount).toBe(2);
            expect(result.allUtteranceStatuses.find(s => s.utteranceId === 'u1')?.subjectId).toBe('agenda-1');
            expect(result.allUtteranceStatuses.find(s => s.utteranceId === 'u2')?.subjectId).toBe('agenda-2');
        });
    });
});
