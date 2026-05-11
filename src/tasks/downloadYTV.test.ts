import { describe, it, expect } from 'vitest';
import { getVideoIdAndUrl, formatBytes, parseLoudnormStats } from './downloadYTV.js';

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

describe('parseLoudnormStats', () => {
  const sampleStderr = `
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'input.mp4':
  Duration: 01:23:45.67, start: 0.000000
Stream mapping:
  Stream #0:1 -> #0:0 (aac (native) -> pcm_s16le (native))
[Parsed_loudnorm_0 @ 0x5555555]
{
	"input_i" : "-27.10",
	"input_tp" : "-8.34",
	"input_lra" : "14.20",
	"input_thresh" : "-37.65",
	"output_i" : "-14.02",
	"output_tp" : "-1.50",
	"output_lra" : "11.00",
	"output_thresh" : "-24.57",
	"normalization_type" : "dynamic",
	"target_offset" : "0.02"
}
size=N/A time=01:23:45.67 bitrate=N/A speed= 125x
`;

  it('extracts loudnorm stats from ffmpeg stderr', () => {
    const stats = parseLoudnormStats(sampleStderr);
    expect(stats).toEqual({
      input_i: '-27.10',
      input_tp: '-8.34',
      input_lra: '14.20',
      input_thresh: '-37.65',
    });
  });

  it('throws when no JSON block is found', () => {
    expect(() => parseLoudnormStats('no json here')).toThrow(
      'Could not find loudnorm JSON',
    );
  });

  it('throws when required fields are missing', () => {
    const incomplete = '{ "input_i" : "-14.0", "input_tp" : "-1.5" }';
    expect(() => parseLoudnormStats(incomplete)).toThrow(
      'Missing loudnorm field',
    );
  });
});
