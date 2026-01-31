import { describe, it, expect } from 'vitest';
import { getVideoIdAndUrl, formatBytes } from './downloadYTV.js';

describe('getVideoIdAndUrl', () => {
  it('extracts ID from youtube.com/watch?v=...', () => {
    const result = getVideoIdAndUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(result.videoId).toBe('dQw4w9WgXcQ');
    expect(result.sourceType).toBe('YouTube');
  });

  it('extracts ID from youtu.be/ short links', () => {
    const result = getVideoIdAndUrl('https://youtu.be/dQw4w9WgXcQ');
    expect(result.videoId).toBe('dQw4w9WgXcQ');
    expect(result.sourceType).toBe('YouTube');
  });

  it('extracts ID from youtube.com/embed/', () => {
    const result = getVideoIdAndUrl('https://www.youtube.com/embed/dQw4w9WgXcQ');
    expect(result.videoId).toBe('dQw4w9WgXcQ');
    expect(result.sourceType).toBe('YouTube');
  });

  it('strips query params from youtu.be links', () => {
    const result = getVideoIdAndUrl('https://youtu.be/abc123?t=42');
    expect(result.videoId).toBe('abc123');
  });

  it('throws on malformed YouTube URL with no video ID', () => {
    expect(() => getVideoIdAndUrl('https://youtube.com/watch')).toThrow(
      'Could not extract video ID',
    );
  });

  it('falls back to Direct URL for non-YouTube, non-CDN URLs', () => {
    const result = getVideoIdAndUrl('https://example.com/video.mp4');
    expect(result.sourceType).toBe('Direct URL');
    expect(result.videoId).toBeTruthy();
    expect(result.videoUrl).toBe('https://example.com/video.mp4');
  });
});

describe('formatBytes', () => {
  it('formats bytes under 1 KB', () => {
    expect(formatBytes(500)).toBe('500 B');
  });

  it('formats kilobytes', () => {
    expect(formatBytes(1024)).toBe('1 KB');
  });

  it('formats megabytes', () => {
    expect(formatBytes(1048576)).toBe('1 MB');
  });

  it('formats with decimal precision', () => {
    expect(formatBytes(1536)).toBe('1.5 KB');
  });

  it('formats gigabytes', () => {
    expect(formatBytes(1073741824)).toBe('1 GB');
  });
});
