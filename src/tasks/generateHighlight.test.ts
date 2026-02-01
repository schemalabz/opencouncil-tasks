import { describe, it, expect } from 'vitest';
import { mergeConsecutiveSegments, bridgeUtteranceGaps } from './generateHighlight.js';

describe('mergeConsecutiveSegments', () => {
  it('returns empty array for no segments', () => {
    expect(mergeConsecutiveSegments([])).toEqual([]);
  });

  it('returns single segment unchanged', () => {
    const segments = [{ startTimestamp: 0, endTimestamp: 5 }];
    expect(mergeConsecutiveSegments(segments)).toEqual(segments);
  });

  it('merges consecutive segments (end === start)', () => {
    const segments = [
      { startTimestamp: 0, endTimestamp: 5 },
      { startTimestamp: 5, endTimestamp: 10 },
      { startTimestamp: 10, endTimestamp: 15 },
    ];
    expect(mergeConsecutiveSegments(segments)).toEqual([
      { startTimestamp: 0, endTimestamp: 15 },
    ]);
  });

  it('preserves gaps between non-consecutive segments', () => {
    const segments = [
      { startTimestamp: 0, endTimestamp: 5 },
      { startTimestamp: 8, endTimestamp: 12 },
    ];
    expect(mergeConsecutiveSegments(segments)).toEqual(segments);
  });

  it('handles mix of consecutive and gapped segments', () => {
    const segments = [
      { startTimestamp: 0, endTimestamp: 5 },
      { startTimestamp: 5, endTimestamp: 10 },
      { startTimestamp: 20, endTimestamp: 25 },
      { startTimestamp: 25, endTimestamp: 30 },
    ];
    expect(mergeConsecutiveSegments(segments)).toEqual([
      { startTimestamp: 0, endTimestamp: 10 },
      { startTimestamp: 20, endTimestamp: 30 },
    ]);
  });
});

describe('bridgeUtteranceGaps', () => {
  it('returns empty result for no utterances', () => {
    const result = bridgeUtteranceGaps([]);
    expect(result.segments).toEqual([]);
    expect(result.adjustedUtterances).toEqual([]);
  });

  it('bridges small gaps within threshold', () => {
    const utterances = [
      { utteranceId: '1', text: 'hello', startTimestamp: 0, endTimestamp: 3 },
      { utteranceId: '2', text: 'world', startTimestamp: 4, endTimestamp: 7 },
    ];
    const result = bridgeUtteranceGaps(utterances, 2.0);

    // First utterance should be extended to meet the second
    expect(result.adjustedUtterances[0].endTimestamp).toBe(4);
  });

  it('preserves gaps larger than threshold', () => {
    const utterances = [
      { utteranceId: '1', text: 'hello', startTimestamp: 0, endTimestamp: 3 },
      { utteranceId: '2', text: 'world', startTimestamp: 10, endTimestamp: 13 },
    ];
    const result = bridgeUtteranceGaps(utterances, 2.0);

    // First utterance should NOT be extended (gap = 7s > 2s threshold)
    expect(result.adjustedUtterances[0].endTimestamp).toBe(3);
    expect(result.segments.length).toBe(2);
  });

  it('merges resulting consecutive segments', () => {
    const utterances = [
      { utteranceId: '1', text: 'a', startTimestamp: 0, endTimestamp: 3 },
      { utteranceId: '2', text: 'b', startTimestamp: 4, endTimestamp: 7 },
      { utteranceId: '3', text: 'c', startTimestamp: 8, endTimestamp: 11 },
    ];
    // Gaps are 1s each, both within 2s threshold → bridging creates consecutive segments → merged
    const result = bridgeUtteranceGaps(utterances, 2.0);
    expect(result.segments.length).toBe(1);
    expect(result.segments[0].startTimestamp).toBe(0);
    expect(result.segments[0].endTimestamp).toBe(11);
  });
});
