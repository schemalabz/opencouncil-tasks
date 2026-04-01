import { describe, it, expect } from 'vitest';
import { DiscussionStatus } from '../../types.js';
import { extractAndGroupUtterances } from './speakerContributions.js';
import { UtteranceStatus } from './types.js';

describe('extractAndGroupUtterances', () => {
  const createTranscript = (segments: Array<{
    speakerId: string | null;
    speakerName: string | null;
    utterances: Array<{ utteranceId: string; text: string; startTimestamp: number }>;
  }>) => segments.map((seg, i) => ({
    speakerSegmentId: `seg-${i}`,
    speakerId: seg.speakerId,
    speakerName: seg.speakerName,
    speakerParty: null,
    speakerRole: null,
    text: seg.utterances.map(u => u.text).join(' '),
    utterances: seg.utterances.map(u => ({
      ...u,
      endTimestamp: u.startTimestamp + 1
    }))
  }));

  it('groups utterances by speakerId', () => {
    const transcript = createTranscript([
      {
        speakerId: 'speaker-a',
        speakerName: 'Alice',
        utterances: [
          { utteranceId: 'utt-1', text: 'Hello', startTimestamp: 0 },
          { utteranceId: 'utt-2', text: 'World', startTimestamp: 1 },
        ]
      },
      {
        speakerId: 'speaker-b',
        speakerName: 'Bob',
        utterances: [
          { utteranceId: 'utt-3', text: 'Hi', startTimestamp: 2 },
        ]
      }
    ]);

    const utteranceStatuses: UtteranceStatus[] = [
      { utteranceId: 'utt-1', status: DiscussionStatus.SUBJECT_DISCUSSION, subjectId: 'subj-1' },
      { utteranceId: 'utt-2', status: DiscussionStatus.SUBJECT_DISCUSSION, subjectId: 'subj-1' },
      { utteranceId: 'utt-3', status: DiscussionStatus.SUBJECT_DISCUSSION, subjectId: 'subj-1' },
    ];

    const result = extractAndGroupUtterances(utteranceStatuses, transcript);

    expect(Object.keys(result.utterancesBySpeaker)).toContain('speaker-a');
    expect(Object.keys(result.utterancesBySpeaker)).toContain('speaker-b');
    expect(result.utterancesBySpeaker['speaker-a']).toHaveLength(2);
    expect(result.utterancesBySpeaker['speaker-b']).toHaveLength(1);
  });

  it('uses name-prefixed key for speakers without speakerId', () => {
    const transcript = createTranscript([
      {
        speakerId: null,
        speakerName: 'Unknown Speaker',
        utterances: [
          { utteranceId: 'utt-1', text: 'Hello', startTimestamp: 0 },
        ]
      }
    ]);

    const utteranceStatuses: UtteranceStatus[] = [
      { utteranceId: 'utt-1', status: DiscussionStatus.SUBJECT_DISCUSSION, subjectId: 'subj-1' },
    ];

    const result = extractAndGroupUtterances(utteranceStatuses, transcript);

    expect(Object.keys(result.utterancesBySpeaker)).toContain('name:Unknown Speaker');
    expect(result.utterancesBySpeaker['name:Unknown Speaker']).toHaveLength(1);
  });

  it('filters utterances by provided status list', () => {
    const transcript = createTranscript([
      {
        speakerId: 'speaker-a',
        speakerName: 'Alice',
        utterances: [
          { utteranceId: 'utt-1', text: 'Relevant', startTimestamp: 0 },
          { utteranceId: 'utt-2', text: 'Irrelevant', startTimestamp: 1 },
          { utteranceId: 'utt-3', text: 'Also relevant', startTimestamp: 2 },
        ]
      }
    ]);

    // Only include utt-1 and utt-3 in the status list
    const utteranceStatuses: UtteranceStatus[] = [
      { utteranceId: 'utt-1', status: DiscussionStatus.SUBJECT_DISCUSSION, subjectId: 'subj-1' },
      { utteranceId: 'utt-3', status: DiscussionStatus.SUBJECT_DISCUSSION, subjectId: 'subj-1' },
    ];

    const result = extractAndGroupUtterances(utteranceStatuses, transcript);

    expect(result.utterancesBySpeaker['speaker-a']).toHaveLength(2);
    expect(result.utterancesBySpeaker['speaker-a'].map(u => u.utteranceId)).toEqual(['utt-1', 'utt-3']);
  });

  it('returns all utterances in chronological order', () => {
    const transcript = createTranscript([
      {
        speakerId: 'speaker-a',
        speakerName: 'Alice',
        utterances: [
          { utteranceId: 'utt-1', text: 'First', startTimestamp: 0 },
        ]
      },
      {
        speakerId: 'speaker-b',
        speakerName: 'Bob',
        utterances: [
          { utteranceId: 'utt-2', text: 'Second', startTimestamp: 5 },
        ]
      },
      {
        speakerId: 'speaker-a',
        speakerName: 'Alice',
        utterances: [
          { utteranceId: 'utt-3', text: 'Third', startTimestamp: 10 },
        ]
      }
    ]);

    const utteranceStatuses: UtteranceStatus[] = [
      { utteranceId: 'utt-1', status: DiscussionStatus.SUBJECT_DISCUSSION, subjectId: 'subj-1' },
      { utteranceId: 'utt-2', status: DiscussionStatus.SUBJECT_DISCUSSION, subjectId: 'subj-1' },
      { utteranceId: 'utt-3', status: DiscussionStatus.SUBJECT_DISCUSSION, subjectId: 'subj-1' },
    ];

    const result = extractAndGroupUtterances(utteranceStatuses, transcript);

    expect(result.allSubjectUtterances.map(u => u.utteranceId)).toEqual(['utt-1', 'utt-2', 'utt-3']);
    expect(result.allSubjectUtterances.map(u => u.timestamp)).toEqual([0, 5, 10]);
  });

  it('includes speaker metadata in allSubjectUtterances', () => {
    const transcript = createTranscript([
      {
        speakerId: 'speaker-a',
        speakerName: 'Alice',
        utterances: [
          { utteranceId: 'utt-1', text: 'Hello', startTimestamp: 0 },
        ]
      }
    ]);

    const utteranceStatuses: UtteranceStatus[] = [
      { utteranceId: 'utt-1', status: DiscussionStatus.SUBJECT_DISCUSSION, subjectId: 'subj-1' },
    ];

    const result = extractAndGroupUtterances(utteranceStatuses, transcript);

    expect(result.allSubjectUtterances[0]).toMatchObject({
      utteranceId: 'utt-1',
      text: 'Hello',
      speakerId: 'speaker-a',
      speakerName: 'Alice',
      timestamp: 0
    });
  });

  it('handles empty utterance status list', () => {
    const transcript = createTranscript([
      {
        speakerId: 'speaker-a',
        speakerName: 'Alice',
        utterances: [
          { utteranceId: 'utt-1', text: 'Hello', startTimestamp: 0 },
        ]
      }
    ]);

    const utteranceStatuses: UtteranceStatus[] = [];

    const result = extractAndGroupUtterances(utteranceStatuses, transcript);

    expect(Object.keys(result.utterancesBySpeaker)).toHaveLength(0);
    expect(result.allSubjectUtterances).toHaveLength(0);
  });

  it('handles empty transcript', () => {
    const transcript = createTranscript([]);

    const utteranceStatuses: UtteranceStatus[] = [
      { utteranceId: 'utt-1', status: DiscussionStatus.SUBJECT_DISCUSSION, subjectId: 'subj-1' },
    ];

    const result = extractAndGroupUtterances(utteranceStatuses, transcript);

    expect(Object.keys(result.utterancesBySpeaker)).toHaveLength(0);
    expect(result.allSubjectUtterances).toHaveLength(0);
  });

  it('skips duplicate utterances (same ID appearing twice)', () => {
    // This can happen if transcript has overlapping segments
    const transcript = createTranscript([
      {
        speakerId: 'speaker-a',
        speakerName: 'Alice',
        utterances: [
          { utteranceId: 'utt-1', text: 'Hello', startTimestamp: 0 },
        ]
      },
      {
        speakerId: 'speaker-a',
        speakerName: 'Alice',
        utterances: [
          { utteranceId: 'utt-1', text: 'Hello', startTimestamp: 0 }, // Duplicate
        ]
      }
    ]);

    const utteranceStatuses: UtteranceStatus[] = [
      { utteranceId: 'utt-1', status: DiscussionStatus.SUBJECT_DISCUSSION, subjectId: 'subj-1' },
    ];

    const result = extractAndGroupUtterances(utteranceStatuses, transcript);

    // Should only include once
    expect(result.utterancesBySpeaker['speaker-a']).toHaveLength(1);
    expect(result.allSubjectUtterances).toHaveLength(1);
  });

  it('skips utterances without speaker identification', () => {
    const transcript = createTranscript([
      {
        speakerId: null,
        speakerName: null,  // No speaker info at all
        utterances: [
          { utteranceId: 'utt-1', text: 'Anonymous', startTimestamp: 0 },
        ]
      }
    ]);

    const utteranceStatuses: UtteranceStatus[] = [
      { utteranceId: 'utt-1', status: DiscussionStatus.SUBJECT_DISCUSSION, subjectId: 'subj-1' },
    ];

    const result = extractAndGroupUtterances(utteranceStatuses, transcript);

    // No speaker key should be created for null/null speaker
    expect(Object.keys(result.utterancesBySpeaker)).toHaveLength(0);
    // But it should still be in allSubjectUtterances for context
    expect(result.allSubjectUtterances).toHaveLength(1);
  });

  it('handles mixed speakers with and without IDs', () => {
    const transcript = createTranscript([
      {
        speakerId: 'speaker-a',
        speakerName: 'Alice',
        utterances: [
          { utteranceId: 'utt-1', text: 'From Alice', startTimestamp: 0 },
        ]
      },
      {
        speakerId: null,
        speakerName: 'Bob (unregistered)',
        utterances: [
          { utteranceId: 'utt-2', text: 'From Bob', startTimestamp: 1 },
        ]
      }
    ]);

    const utteranceStatuses: UtteranceStatus[] = [
      { utteranceId: 'utt-1', status: DiscussionStatus.SUBJECT_DISCUSSION, subjectId: 'subj-1' },
      { utteranceId: 'utt-2', status: DiscussionStatus.SUBJECT_DISCUSSION, subjectId: 'subj-1' },
    ];

    const result = extractAndGroupUtterances(utteranceStatuses, transcript);

    expect(Object.keys(result.utterancesBySpeaker)).toContain('speaker-a');
    expect(Object.keys(result.utterancesBySpeaker)).toContain('name:Bob (unregistered)');
  });
});
