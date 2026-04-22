import { describe, it, expect } from 'vitest';
import { DiscussionStatus } from '../../types.js';
import {
  buildUtteranceIndexMap,
  getStatusEmoji,
  splitTranscript,
  initializeSubjectsFromExisting
} from './utils.js';

describe('buildUtteranceIndexMap', () => {
  it('builds chronological index from transcript segments', () => {
    const transcript = [
      {
        speakerSegmentId: 'seg-1',
        speakerId: 'speaker-1',
        speakerName: 'Alice',
        speakerParty: null,
        speakerRole: null,
        text: 'Hello',
        utterances: [
          { utteranceId: 'utt-1', text: 'Hello', startTimestamp: 0, endTimestamp: 1 },
          { utteranceId: 'utt-2', text: 'World', startTimestamp: 1, endTimestamp: 2 },
        ]
      },
      {
        speakerSegmentId: 'seg-2',
        speakerId: 'speaker-2',
        speakerName: 'Bob',
        speakerParty: null,
        speakerRole: null,
        text: 'Hi',
        utterances: [
          { utteranceId: 'utt-3', text: 'Hi', startTimestamp: 2, endTimestamp: 3 },
        ]
      }
    ];

    const indexMap = buildUtteranceIndexMap(transcript);

    expect(indexMap.get('utt-1')).toBe(0);
    expect(indexMap.get('utt-2')).toBe(1);
    expect(indexMap.get('utt-3')).toBe(2);
    expect(indexMap.size).toBe(3);
  });

  it('returns empty map for empty transcript', () => {
    const indexMap = buildUtteranceIndexMap([]);
    expect(indexMap.size).toBe(0);
  });
});

describe('getStatusEmoji', () => {
  it.each([
    [DiscussionStatus.ATTENDANCE, '📋'],
    [DiscussionStatus.SUBJECT_DISCUSSION, '💬'],
    [DiscussionStatus.PROCEDURAL_VOTE, '⚖️'],
    [DiscussionStatus.VOTE, '🗳️'],
    [DiscussionStatus.OTHER, '📝'],
  ])('returns correct emoji for %s', (status, expected) => {
    expect(getStatusEmoji(status)).toBe(expected);
  });
});

describe('splitTranscript', () => {
  it('keeps all items in one batch when under limit', () => {
    const items = [
      { id: 1, text: 'short' },
      { id: 2, text: 'also short' },
    ];
    const batches = splitTranscript(items, 1000);

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
  });

  it('splits items into multiple batches when exceeding limit', () => {
    const items = [
      { id: 1, text: 'a'.repeat(100) },
      { id: 2, text: 'b'.repeat(100) },
      { id: 3, text: 'c'.repeat(100) },
    ];
    // Each item is ~110 chars when stringified, limit of 250 should force splits
    const batches = splitTranscript(items, 250);

    expect(batches.length).toBeGreaterThan(1);
    // All items should be present across batches
    const allItems = batches.flat();
    expect(allItems).toHaveLength(3);
  });

  it('handles single item exceeding limit', () => {
    const items = [
      { id: 1, text: 'a'.repeat(500) },
    ];
    const batches = splitTranscript(items, 100);

    // Should still include the item even if it exceeds limit
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
  });

  it('returns empty array for empty input', () => {
    const batches = splitTranscript([], 1000);
    expect(batches).toHaveLength(0);
  });

  it('does not create empty batches', () => {
    const items = [
      { id: 1, text: 'a'.repeat(200) },
      { id: 2, text: 'b'.repeat(200) },
    ];
    const batches = splitTranscript(items, 250);

    // No batch should be empty
    for (const batch of batches) {
      expect(batch.length).toBeGreaterThan(0);
    }
  });
});

describe('initializeSubjectsFromExisting', () => {
  it('converts numeric agendaItemIndex to IN_AGENDA type', () => {
    const existing = [{
      id: 'subj-1',
      name: 'Budget',
      description: 'Annual budget',
      agendaItemIndex: 1,
      introducedByPersonId: 'person-1',
      locationText: null,
      topicLabel: 'Finance',
      topicImportance: 'high',
      proximityImportance: 'wide',
    }];

    const result = initializeSubjectsFromExisting(existing);

    expect(result[0].type).toBe('IN_AGENDA');
    expect(result[0].agendaItemIndex).toBe(1);
  });

  it('converts BEFORE_AGENDA string to BEFORE_AGENDA type', () => {
    const existing = [{
      id: 'subj-2',
      name: 'Announcement',
      description: 'Pre-meeting',
      agendaItemIndex: 'BEFORE_AGENDA',
      introducedByPersonId: null,
      locationText: null,
      topicLabel: null,
    }];

    const result = initializeSubjectsFromExisting(existing);

    expect(result[0].type).toBe('BEFORE_AGENDA');
    expect(result[0].agendaItemIndex).toBe('BEFORE_AGENDA');
  });

  it('converts OUT_OF_AGENDA string to OUT_OF_AGENDA type', () => {
    const existing = [{
      id: 'subj-3',
      name: 'Urgent matter',
      description: 'Emergency',
      agendaItemIndex: 'OUT_OF_AGENDA',
      introducedByPersonId: null,
      locationText: null,
      topicLabel: null,
    }];

    const result = initializeSubjectsFromExisting(existing);

    expect(result[0].type).toBe('OUT_OF_AGENDA');
    expect(result[0].agendaItemIndex).toBe('OUT_OF_AGENDA');
  });

  it('defaults topicImportance to normal when missing', () => {
    const existing = [{
      id: 'subj-4',
      name: 'Test',
      description: 'Test',
      agendaItemIndex: 1,
      introducedByPersonId: null,
      locationText: null,
      topicLabel: null,
    }];

    const result = initializeSubjectsFromExisting(existing);

    expect(result[0].topicImportance).toBe('normal');
  });

  it('defaults proximityImportance to none when missing', () => {
    const existing = [{
      id: 'subj-5',
      name: 'Test',
      description: 'Test',
      agendaItemIndex: 1,
      introducedByPersonId: null,
      locationText: null,
      topicLabel: null,
    }];

    const result = initializeSubjectsFromExisting(existing);

    expect(result[0].proximityImportance).toBe('none');
  });

  it('preserves discussedIn when set', () => {
    const existing = [{
      id: 'subj-6',
      name: 'Secondary',
      description: 'Discussed with primary',
      agendaItemIndex: 2,
      introducedByPersonId: null,
      locationText: null,
      topicLabel: null,
      discussedIn: 'subj-1',
    }];

    const result = initializeSubjectsFromExisting(existing);

    expect(result[0].discussedIn).toBe('subj-1');
  });

  it('sets discussedIn to null when not provided', () => {
    const existing = [{
      id: 'subj-7',
      name: 'Independent',
      description: 'On its own',
      agendaItemIndex: 1,
      introducedByPersonId: null,
      locationText: null,
      topicLabel: null,
    }];

    const result = initializeSubjectsFromExisting(existing);

    expect(result[0].discussedIn).toBeNull();
  });

  it('initializes speakerContributions as empty array', () => {
    const existing = [{
      id: 'subj-8',
      name: 'Test',
      description: 'Test',
      agendaItemIndex: 1,
      introducedByPersonId: null,
      locationText: null,
      topicLabel: null,
    }];

    const result = initializeSubjectsFromExisting(existing);

    expect(result[0].speakerContributions).toEqual([]);
  });
});
