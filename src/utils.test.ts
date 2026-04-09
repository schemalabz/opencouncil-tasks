import { describe, it, expect } from 'vitest';
import { IdCompressor, validateUrl, validateYoutubeUrl, formatTime, generateSubjectUUID } from './utils.js';

describe('IdCompressor', () => {
  it('round-trips: add → getShort → getLong', () => {
    const c = new IdCompressor();
    const longId = 'abc-123-very-long-identifier';
    const shortId = c.addLongId(longId);

    expect(shortId).toHaveLength(8);
    expect(c.getShortId(longId)).toBe(shortId);
    expect(c.getLongId(shortId)).toBe(longId);
  });

  it('returns the same short ID when adding the same long ID twice', () => {
    const c = new IdCompressor();
    const longId = 'duplicate-test';
    const first = c.addLongId(longId);
    const second = c.addLongId(longId);

    expect(first).toBe(second);
  });

  it('generates distinct short IDs for distinct long IDs', () => {
    const c = new IdCompressor();
    const ids = Array.from({ length: 50 }, (_, i) => c.addLongId(`id-${i}`));
    const unique = new Set(ids);

    expect(unique.size).toBe(50);
  });

});

describe('validateUrl', () => {
  it.each([
    'https://example.com',
    'http://example.com/path',
    'https://sub.domain.co.uk/foo/bar',
    'http://localhost:3000',
    'http://localhost:3000/api/v1',
  ])('accepts valid URL: %s', (url) => {
    expect(validateUrl(url)).toBe(true);
  });

  it.each([
    '',
    'not-a-url',
    'ftp://example.com',
    'https://',
  ])('rejects invalid URL: %s', (url) => {
    expect(validateUrl(url)).toBe(false);
  });
});

describe('validateYoutubeUrl', () => {
  it.each([
    'https://www.youtube.com/watch?v=abc123',
    'https://youtube.com/watch?v=abc123',
    'https://youtu.be/abc123',
    'http://www.youtube.com/embed/abc123',
  ])('accepts valid YouTube URL: %s', (url) => {
    expect(validateYoutubeUrl(url)).toBe(true);
  });

  it.each([
    'https://vimeo.com/123',
    'https://example.com',
    '',
  ])('rejects non-YouTube URL: %s', (url) => {
    expect(validateYoutubeUrl(url)).toBe(false);
  });
});

describe('formatTime', () => {
  it('formats 0 seconds', () => {
    expect(formatTime(0)).toBe('00:00:00');
  });

  it('formats sub-minute values', () => {
    expect(formatTime(45)).toBe('00:00:45');
  });

  it('formats minutes and seconds', () => {
    expect(formatTime(125)).toBe('00:02:05');
  });

  it('formats multi-hour values', () => {
    expect(formatTime(7384)).toBe('02:03:04');
  });

  it('truncates fractional seconds', () => {
    expect(formatTime(61.9)).toBe('00:01:01');
  });
});

// ===========================================================================
// generateSubjectUUID — Deterministic hash-based ID for subjects
//
// Generates a stable SHA-256 hash from subject properties so the same
// subject always gets the same ID, regardless of when or where it's
// processed. The hash inputs are: name + description + agendaItemIndex.
// This means renaming a subject or changing its description will change
// its ID — which is intentional, as it's a different subject at that point.
// ===========================================================================

describe('generateSubjectUUID', () => {

  it('produces a 64-character hex string by default (full SHA-256)', () => {
    const uuid = generateSubjectUUID({ name: 'Test', description: 'Desc' });

    expect(uuid).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic — same inputs always produce same hash', () => {
    const subject = { name: 'Budget', description: 'Annual budget review', agendaItemIndex: 1 };

    const first = generateSubjectUUID(subject);
    const second = generateSubjectUUID(subject);

    expect(first).toBe(second);
  });

  it('truncates to requested length', () => {
    const full = generateSubjectUUID({ name: 'Test', description: 'Desc' });
    const truncated = generateSubjectUUID({ name: 'Test', description: 'Desc' }, 36);

    expect(truncated).toHaveLength(36);
    expect(full.startsWith(truncated)).toBe(true);
  });

  it('includes agendaItemIndex in the hash — different index means different ID', () => {
    const base = { name: 'Same name', description: 'Same desc' };

    const withIndex1 = generateSubjectUUID({ ...base, agendaItemIndex: 1 });
    const withIndex2 = generateSubjectUUID({ ...base, agendaItemIndex: 2 });

    expect(withIndex1).not.toBe(withIndex2);
  });

  it('uses "NO_AGENDA" as fallback when agendaItemIndex is undefined', () => {
    const withUndefined = generateSubjectUUID({ name: 'X', description: 'Y' });
    const withNoAgenda = generateSubjectUUID({ name: 'X', description: 'Y', agendaItemIndex: undefined });

    expect(withUndefined).toBe(withNoAgenda);
  });

  it('handles special string values for agendaItemIndex', () => {
    const base = { name: 'Topic', description: 'Desc' };

    const beforeAgenda = generateSubjectUUID({ ...base, agendaItemIndex: 'BEFORE_AGENDA' });
    const outOfAgenda = generateSubjectUUID({ ...base, agendaItemIndex: 'OUT_OF_AGENDA' });

    expect(beforeAgenda).not.toBe(outOfAgenda);
  });

  it('is sensitive to name changes', () => {
    const a = generateSubjectUUID({ name: 'Roads', description: 'Same' });
    const b = generateSubjectUUID({ name: 'Schools', description: 'Same' });

    expect(a).not.toBe(b);
  });

  it('is sensitive to description changes', () => {
    const a = generateSubjectUUID({ name: 'Same', description: 'Version 1' });
    const b = generateSubjectUUID({ name: 'Same', description: 'Version 2' });

    expect(a).not.toBe(b);
  });
});

