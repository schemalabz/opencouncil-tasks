import { describe, it, expect } from 'vitest';
import { IdCompressor, validateUrl, validateYoutubeUrl, formatTime } from './utils.js';

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
