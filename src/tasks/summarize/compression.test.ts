import { describe, it, expect } from 'vitest';
import { IdCompressor } from '../../utils.js';
import { compressIds, decompressIds, decompressReferencesInMarkdown } from './compression.js';
import { DiscussionStatus } from '../../types.js';

describe('compressIds', () => {
  it('compresses speakerSegmentId in transcript', () => {
    const idCompressor = new IdCompressor();
    const request = {
      transcript: [{
        speakerSegmentId: 'long-segment-id-123',
        speakerId: null,
        speakerName: 'Alice',
        speakerParty: null,
        speakerRole: null,
        text: 'Hello',
        utterances: []
      }],
      existingSubjects: [],
      cityName: 'Athens',
      date: '2024-01-01',
      topicLabels: [],
      administrativeBodyName: 'Council',
      partiesWithPeople: [],
      requestedSubjects: [],
      callbackUrl: 'http://example.com'
    };

    const result = compressIds(request, idCompressor);

    expect(result.transcript[0].speakerSegmentId).toHaveLength(8);
    expect(idCompressor.getLongId(result.transcript[0].speakerSegmentId)).toBe('long-segment-id-123');
  });

  it('compresses speakerId when present', () => {
    const idCompressor = new IdCompressor();
    const request = {
      transcript: [{
        speakerSegmentId: 'seg-1',
        speakerId: 'long-speaker-id-456',
        speakerName: 'Bob',
        speakerParty: null,
        speakerRole: null,
        text: 'Hi',
        utterances: []
      }],
      existingSubjects: [],
      cityName: 'Athens',
      date: '2024-01-01',
      topicLabels: [],
      administrativeBodyName: 'Council',
      partiesWithPeople: [],
      requestedSubjects: [],
      callbackUrl: 'http://example.com'
    };

    const result = compressIds(request, idCompressor);

    expect(result.transcript[0].speakerId).toHaveLength(8);
    expect(idCompressor.getLongId(result.transcript[0].speakerId!)).toBe('long-speaker-id-456');
  });

  it('keeps speakerId null when null', () => {
    const idCompressor = new IdCompressor();
    const request = {
      transcript: [{
        speakerSegmentId: 'seg-1',
        speakerId: null,
        speakerName: 'Anonymous',
        speakerParty: null,
        speakerRole: null,
        text: 'Hi',
        utterances: []
      }],
      existingSubjects: [],
      cityName: 'Athens',
      date: '2024-01-01',
      topicLabels: [],
      administrativeBodyName: 'Council',
      partiesWithPeople: [],
      requestedSubjects: [],
      callbackUrl: 'http://example.com'
    };

    const result = compressIds(request, idCompressor);

    expect(result.transcript[0].speakerId).toBeNull();
  });

  it('compresses utteranceId in utterances', () => {
    const idCompressor = new IdCompressor();
    const request = {
      transcript: [{
        speakerSegmentId: 'seg-1',
        speakerId: null,
        speakerName: 'Alice',
        speakerParty: null,
        speakerRole: null,
        text: 'Hello world',
        utterances: [
          { utteranceId: 'long-utterance-id-789', text: 'Hello', startTimestamp: 0, endTimestamp: 1 },
          { utteranceId: 'long-utterance-id-012', text: 'World', startTimestamp: 1, endTimestamp: 2 },
        ]
      }],
      existingSubjects: [],
      cityName: 'Athens',
      date: '2024-01-01',
      topicLabels: [],
      administrativeBodyName: 'Council',
      partiesWithPeople: [],
      requestedSubjects: [],
      callbackUrl: 'http://example.com'
    };

    const result = compressIds(request, idCompressor);

    expect(result.transcript[0].utterances[0].utteranceId).toHaveLength(8);
    expect(result.transcript[0].utterances[1].utteranceId).toHaveLength(8);
    expect(idCompressor.getLongId(result.transcript[0].utterances[0].utteranceId)).toBe('long-utterance-id-789');
  });

  it('compresses existing subject IDs', () => {
    const idCompressor = new IdCompressor();
    const request = {
      transcript: [],
      existingSubjects: [{
        id: 'will-be-regenerated',
        name: 'Budget',
        description: 'Annual budget discussion',
        agendaItemIndex: 1,
        introducedByPersonId: 'person-long-id',
        speakerContributions: [],
        topicImportance: 'normal' as const,
        proximityImportance: 'none' as const,
        location: null,
        topicLabel: null,
        context: null,
        discussedIn: null
      }],
      cityName: 'Athens',
      date: '2024-01-01',
      topicLabels: [],
      administrativeBodyName: 'Council',
      partiesWithPeople: [],
      requestedSubjects: [],
      callbackUrl: 'http://example.com'
    };

    const result = compressIds(request, idCompressor);

    expect(result.existingSubjects[0].id).toHaveLength(8);
    expect(result.existingSubjects[0].introducedByPersonId).toHaveLength(8);
  });
});

describe('decompressIds', () => {
  it('decompresses speakerSegmentId in summaries', () => {
    const idCompressor = new IdCompressor();
    const longId = 'original-long-segment-id';
    const shortId = idCompressor.addLongId(longId);

    const result = {
      speakerSegmentSummaries: [{
        id: shortId,
        summary: 'A summary',
        labels: ['topic'],
        type: 'SUBSTANTIAL' as const
      }],
      subjects: [],
      utteranceDiscussionStatuses: []
    };

    const decompressed = decompressIds(result, idCompressor);

    expect(decompressed.speakerSegmentSummaries[0].speakerSegmentId).toBe(longId);
  });

  it('decompresses subject ID', () => {
    const idCompressor = new IdCompressor();
    const longSubjectId = 'original-subject-uuid';
    const shortSubjectId = idCompressor.addLongId(longSubjectId);

    const result = {
      speakerSegmentSummaries: [],
      subjects: [{
        id: shortSubjectId,
        name: 'Test',
        description: 'Description',
        agendaItemIndex: 1,
        introducedByPersonId: null,
        speakerContributions: [],
        topicImportance: 'normal' as const,
        proximityImportance: 'none' as const,
        location: null,
        topicLabel: null,
        context: null,
        discussedIn: null
      }],
      utteranceDiscussionStatuses: []
    };

    const decompressed = decompressIds(result, idCompressor);

    expect(decompressed.subjects[0].id).toBe(longSubjectId);
  });

  it('decompresses introducedByPersonId in subjects', () => {
    const idCompressor = new IdCompressor();
    const longSubjectId = 'subject-id';
    const longPersonId = 'person-uuid-12345';
    const shortSubjectId = idCompressor.addLongId(longSubjectId);
    const shortPersonId = idCompressor.addLongId(longPersonId);

    const result = {
      speakerSegmentSummaries: [],
      subjects: [{
        id: shortSubjectId,
        name: 'Test',
        description: 'Desc',
        agendaItemIndex: 1,
        introducedByPersonId: shortPersonId,
        speakerContributions: [],
        topicImportance: 'normal' as const,
        proximityImportance: 'none' as const,
        location: null,
        topicLabel: null,
        context: null,
        discussedIn: null
      }],
      utteranceDiscussionStatuses: []
    };

    const decompressed = decompressIds(result, idCompressor);

    expect(decompressed.subjects[0].introducedByPersonId).toBe(longPersonId);
  });

  it('decompresses utteranceId in utteranceDiscussionStatuses', () => {
    const idCompressor = new IdCompressor();
    const longUtteranceId = 'utterance-uuid-long';
    const shortUtteranceId = idCompressor.addLongId(longUtteranceId);

    const result = {
      speakerSegmentSummaries: [],
      subjects: [],
      utteranceDiscussionStatuses: [{
        utteranceId: shortUtteranceId,
        status: DiscussionStatus.ATTENDANCE,
        subjectId: null
      }]
    };

    const decompressed = decompressIds(result, idCompressor);

    expect(decompressed.utteranceDiscussionStatuses[0].utteranceId).toBe(longUtteranceId);
  });

  it('decompresses subjectId in utteranceDiscussionStatuses', () => {
    const idCompressor = new IdCompressor();
    const longUtteranceId = 'utt-long';
    const longSubjectId = 'subj-long';
    const shortUtteranceId = idCompressor.addLongId(longUtteranceId);
    const shortSubjectId = idCompressor.addLongId(longSubjectId);

    const result = {
      speakerSegmentSummaries: [],
      subjects: [],
      utteranceDiscussionStatuses: [{
        utteranceId: shortUtteranceId,
        status: DiscussionStatus.SUBJECT_DISCUSSION,
        subjectId: shortSubjectId
      }]
    };

    const decompressed = decompressIds(result, idCompressor);

    expect(decompressed.utteranceDiscussionStatuses[0].subjectId).toBe(longSubjectId);
  });

  it('filters out contributions with undefined text', () => {
    const idCompressor = new IdCompressor();
    const longSubjectId = 'subj-id';
    const shortSubjectId = idCompressor.addLongId(longSubjectId);

    const result = {
      speakerSegmentSummaries: [],
      subjects: [{
        id: shortSubjectId,
        name: 'Test',
        description: 'Desc',
        agendaItemIndex: 1,
        introducedByPersonId: null,
        speakerContributions: [
          { speakerId: null, speakerName: 'Alice', text: 'Valid contribution' },
          { speakerId: null, speakerName: 'Bob', text: undefined as any },
        ],
        topicImportance: 'normal' as const,
        proximityImportance: 'none' as const,
        location: null,
        topicLabel: null,
        context: null,
        discussedIn: null
      }],
      utteranceDiscussionStatuses: []
    };

    const decompressed = decompressIds(result, idCompressor);

    expect(decompressed.subjects[0].speakerContributions).toHaveLength(1);
    expect(decompressed.subjects[0].speakerContributions[0].speakerName).toBe('Alice');
  });
});

describe('decompressReferencesInMarkdown', () => {
  it('decompresses UTTERANCE references', () => {
    const idCompressor = new IdCompressor();
    const longId = 'utterance-uuid-12345';
    const shortId = idCompressor.addLongId(longId);

    const markdown = `See [this point](REF:UTTERANCE:${shortId}) for details.`;
    const result = decompressReferencesInMarkdown(markdown, idCompressor);

    expect(result).toBe(`See [this point](REF:UTTERANCE:${longId}) for details.`);
  });

  it('decompresses PERSON references', () => {
    const idCompressor = new IdCompressor();
    const longId = 'person-uuid-67890';
    const shortId = idCompressor.addLongId(longId);

    const markdown = `Proposed by [the mayor](REF:PERSON:${shortId}).`;
    const result = decompressReferencesInMarkdown(markdown, idCompressor);

    expect(result).toBe(`Proposed by [the mayor](REF:PERSON:${longId}).`);
  });

  it('decompresses PARTY references', () => {
    const idCompressor = new IdCompressor();
    const longId = 'party-uuid-abcde';
    const shortId = idCompressor.addLongId(longId);

    const markdown = `The [opposition](REF:PARTY:${shortId}) disagreed.`;
    const result = decompressReferencesInMarkdown(markdown, idCompressor);

    expect(result).toBe(`The [opposition](REF:PARTY:${longId}) disagreed.`);
  });

  it('decompresses multiple references in same text', () => {
    const idCompressor = new IdCompressor();
    const uttLong = 'utt-long-1';
    const personLong = 'person-long-2';
    const uttShort = idCompressor.addLongId(uttLong);
    const personShort = idCompressor.addLongId(personLong);

    const markdown = `[Quote](REF:UTTERANCE:${uttShort}) by [Alice](REF:PERSON:${personShort}).`;
    const result = decompressReferencesInMarkdown(markdown, idCompressor);

    expect(result).toContain(`REF:UTTERANCE:${uttLong}`);
    expect(result).toContain(`REF:PERSON:${personLong}`);
  });

  it('returns empty string for null input', () => {
    const idCompressor = new IdCompressor();
    const result = decompressReferencesInMarkdown(null, idCompressor);
    expect(result).toBe('');
  });

  it('returns empty string for undefined input', () => {
    const idCompressor = new IdCompressor();
    const result = decompressReferencesInMarkdown(undefined, idCompressor);
    expect(result).toBe('');
  });

  it('preserves text without references', () => {
    const idCompressor = new IdCompressor();
    const markdown = 'This is plain text without any references.';
    const result = decompressReferencesInMarkdown(markdown, idCompressor);
    expect(result).toBe(markdown);
  });

  it('preserves malformed references (not matching pattern)', () => {
    const idCompressor = new IdCompressor();
    const markdown = 'See (REF:INVALID:xyz) and [link](http://example.com).';
    const result = decompressReferencesInMarkdown(markdown, idCompressor);
    expect(result).toBe(markdown);
  });
});

describe('compressIds → decompressIds round-trip', () => {
  it('preserves all IDs through compression and decompression', () => {
    const idCompressor = new IdCompressor();

    // Create a request with various IDs
    const originalRequest = {
      transcript: [{
        speakerSegmentId: 'segment-uuid-original',
        speakerId: 'speaker-uuid-original',
        speakerName: 'Test Speaker',
        speakerParty: 'Test Party',
        speakerRole: 'Council Member',
        text: 'Test utterance text',
        utterances: [
          { utteranceId: 'utterance-uuid-1', text: 'First', startTimestamp: 0, endTimestamp: 5 },
          { utteranceId: 'utterance-uuid-2', text: 'Second', startTimestamp: 5, endTimestamp: 10 },
        ]
      }],
      existingSubjects: [],
      cityName: 'Athens',
      date: '2024-01-01',
      topicLabels: ['Environment'],
      administrativeBodyName: 'City Council',
      partiesWithPeople: [],
      requestedSubjects: [],
      callbackUrl: 'http://callback.example.com'
    };

    // Compress
    const compressed = compressIds(originalRequest, idCompressor);

    // Simulate LLM output using compressed IDs
    const llmResult = {
      speakerSegmentSummaries: [{
        id: compressed.transcript[0].speakerSegmentId,
        summary: 'Speaker discussed environmental issues.',
        labels: ['Environment'],
        type: 'SUBSTANTIAL' as const
      }],
      subjects: [],
      utteranceDiscussionStatuses: [
        {
          utteranceId: compressed.transcript[0].utterances[0].utteranceId,
          status: DiscussionStatus.SUBJECT_DISCUSSION,
          subjectId: null
        },
        {
          utteranceId: compressed.transcript[0].utterances[1].utteranceId,
          status: DiscussionStatus.VOTE,
          subjectId: null
        }
      ]
    };

    // Decompress
    const decompressed = decompressIds(llmResult, idCompressor);

    // Verify round-trip
    expect(decompressed.speakerSegmentSummaries[0].speakerSegmentId).toBe('segment-uuid-original');
    expect(decompressed.utteranceDiscussionStatuses[0].utteranceId).toBe('utterance-uuid-1');
    expect(decompressed.utteranceDiscussionStatuses[1].utteranceId).toBe('utterance-uuid-2');
  });
});
