import { describe, it, expect } from 'vitest';
import { assertFetchableUrl } from './fetchableUrl.js';

describe('assertFetchableUrl', () => {
  it.each([
    'https://example.com/video.mp4',
    'http://localhost:3000/clip.mp4?token=1',
  ])('returns the parsed URL for %s', (value) => {
    expect(assertFetchableUrl(value).href).toBe(new URL(value).href);
  });

  it.each([
    ['a local path', '/etc/passwd'],
    ['a relative path', '../data/captions.json'],
    ['a file URL', 'file:///etc/passwd'],
    ['a data URL', 'data:text/plain,hello'],
    ['an ftp URL', 'ftp://example.com/a'],
    ['an option-like string', '--exec touch /tmp/x youtu.be/dQw4w9WgXcQ'],
    ['an empty string', ''],
  ])('rejects %s', (_label, value) => {
    expect(() => assertFetchableUrl(value, 'videoUrl')).toThrow(/^videoUrl /);
  });

  it('rejects a non-string', () => {
    expect(() => assertFetchableUrl(42)).toThrow('url must be a string');
  });
});
