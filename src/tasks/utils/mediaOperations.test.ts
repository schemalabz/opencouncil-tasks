import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  normalizeUtteranceTimestamps,
  escapeTextForFFmpeg,
  wrapTextByPixelWidth,
  calculateOptimalFontSizeWithStartAndCap,
  getPresetConfig,
  generateSocialFilter,
  generateBlurredMarginFilter,
  generateSolidMarginFilter,
  calculateSpeakerDisplaySegments,
  wrapSpeakerText,
  formatSpeakerInfo,
} from './mediaOperations.js';

describe('normalizeUtteranceTimestamps', () => {
  it('produces sequential timeline from non-sequential sources', () => {
    const utterances = [
      { text: 'a', startTimestamp: 100, endTimestamp: 105 },
      { text: 'b', startTimestamp: 200, endTimestamp: 203 },
      { text: 'c', startTimestamp: 300, endTimestamp: 310 },
    ];
    const result = normalizeUtteranceTimestamps(utterances);

    expect(result[0].normalizedStart).toBe(0);
    expect(result[0].normalizedEnd).toBe(5);
    expect(result[1].normalizedStart).toBe(5);
    expect(result[1].normalizedEnd).toBe(8);
    expect(result[2].normalizedStart).toBe(8);
    expect(result[2].normalizedEnd).toBe(18);
  });

  it('preserves original timestamps', () => {
    const utterances = [{ text: 'x', startTimestamp: 50, endTimestamp: 60 }];
    const result = normalizeUtteranceTimestamps(utterances);
    expect(result[0].originalStart).toBe(50);
    expect(result[0].originalEnd).toBe(60);
  });

  it('returns empty array for empty input', () => {
    expect(normalizeUtteranceTimestamps([])).toEqual([]);
  });
});

describe('escapeTextForFFmpeg', () => {
  it('escapes square brackets', () => {
    expect(escapeTextForFFmpeg('[test]')).toBe('\\[test\\]');
  });

  it('escapes colons', () => {
    expect(escapeTextForFFmpeg('time: 3:00')).toBe('time\\: 3\\:00');
  });

  it('escapes semicolons', () => {
    expect(escapeTextForFFmpeg('a;b')).toBe('a\\;b');
  });

  it('replaces apostrophes with curly quote', () => {
    expect(escapeTextForFFmpeg("it's")).toBe('it\u2019s');
  });

  it('escapes percent signs', () => {
    expect(escapeTextForFFmpeg('100%')).toBe('100\\%');
  });

  it('escapes backslashes before other escapes', () => {
    expect(escapeTextForFFmpeg('a\\b')).toBe('a\\\\b');
  });

  it('escapes commas', () => {
    expect(escapeTextForFFmpeg('a,b')).toBe('a\\,b');
  });
});

describe('wrapTextByPixelWidth', () => {
  it('keeps single short word on one line', () => {
    // fontSize=20, charWidth=12, availableWidth=200 → ~16 chars per line
    const result = wrapTextByPixelWidth('hello', 20, 200);
    expect(result).toBe('hello');
  });

  it('wraps text that exceeds available width', () => {
    // fontSize=20, charWidth=12, availableWidth=120 → ~10 chars per line
    const result = wrapTextByPixelWidth('hello world foo', 20, 120);
    const lines = result.split('\n');
    expect(lines.length).toBeGreaterThan(1);
  });

  it('handles a single word longer than the line width', () => {
    const result = wrapTextByPixelWidth('supercalifragilistic', 20, 60);
    // Should still produce output (word forced onto line)
    expect(result).toContain('supercalifragilistic');
  });
});

describe('calculateOptimalFontSizeWithStartAndCap', () => {
  it('returns start font size when text fits', () => {
    const { fontSize } = calculateOptimalFontSizeWithStartAndCap(
      'short', 'default', 32, 36, 30, 1280,
    );
    expect(fontSize).toBe(32);
  });

  it('shrinks font to fit long text', () => {
    const longText = 'This is a very long text that will definitely need to wrap across multiple lines and probably require a smaller font size to fit within the available space constraints of this narrow frame';
    const { fontSize } = calculateOptimalFontSizeWithStartAndCap(
      longText, 'default', 32, 36, 30, 400, 3,
    );
    expect(fontSize).toBeLessThan(32);
  });

  it('truncates with "..." when text cannot fit even at min font', () => {
    const veryLongText = Array(200).fill('word').join(' ');
    const { wrappedText } = calculateOptimalFontSizeWithStartAndCap(
      veryLongText, 'default', 32, 36, 30, 300, 2,
    );
    expect(wrappedText).toContain('...');
  });
});

describe('getPresetConfig', () => {
  it('returns config for known resolution', () => {
    const { config, dimensions } = getPresetConfig('1280x720', 'default');
    expect(dimensions).toEqual({ width: 1280, height: 720 });
    expect(config.caption['default'].startFont).toBe(32);
  });

  it('falls back to first preset for unknown resolution', () => {
    const { config } = getPresetConfig('9999x9999', 'default');
    expect(config.caption['default']).toBeDefined();
  });

  it('swaps dimensions for social-9x16', () => {
    const { dimensions } = getPresetConfig('1280x720', 'social-9x16');
    // 720p landscape source → 720x1280 portrait canvas
    expect(dimensions.width).toBe(720);
    expect(dimensions.height).toBe(1280);
  });

  it('produces a 1080x1920 portrait canvas from a 1080p source', () => {
    const { dimensions, config } = getPresetConfig('1920x1080', 'social-9x16');
    expect(dimensions.width).toBe(1080);
    expect(dimensions.height).toBe(1920);
    // config comes from the matched 1080p preset, so it carries a social config
    expect(config.caption['social-9x16']).toBeDefined();
  });

  it('caps social output at 1080p for larger-than-1080p sources', () => {
    const { dimensions } = getPresetConfig('3840x2160', 'social-9x16');
    expect(dimensions.width).toBe(1080);
    expect(dimensions.height).toBe(1920);
  });

  it('borrows a social-capable preset for default-only resolutions (no throw)', () => {
    // 640x360 has no social config; nearest social-capable preset is 1280x720
    const { dimensions, config } = getPresetConfig('640x360', 'social-9x16');
    expect(dimensions.width).toBe(720);
    expect(dimensions.height).toBe(1280);
    expect(config.caption['social-9x16']).toBeDefined();
  });
});

describe('generateSocialFilter', () => {
  it('generates blur filter chain', () => {
    const filter = generateSocialFilter(
      { marginType: 'blur', backgroundColor: '#000000', zoomFactor: 1.0 },
      1280, 720,
    );
    expect(filter).toContain('split=2[bg][video]');
    expect(filter).toContain('gblur');
    expect(filter).toContain('overlay');
    expect(filter).toContain('setdar=9/16');
  });

  it('generates solid margin filter chain', () => {
    const filter = generateSocialFilter(
      { marginType: 'solid', backgroundColor: '#ff0000', zoomFactor: 0.8 },
      1280, 720,
    );
    expect(filter).toContain('pad=');
    expect(filter).toContain('0xff0000');
    expect(filter).toContain('setdar=9/16');
  });
});

describe('generateBlurredMarginFilter', () => {
  it('produces filter with split, blur, scale, and overlay', () => {
    const filter = generateBlurredMarginFilter(0.9, 1280, 720);
    expect(filter).toContain('split=2[bg][video]');
    expect(filter).toContain('gblur=sigma=20');
    expect(filter).toContain('0.9');
    expect(filter).toContain('overlay=(W-w)/2:(H-h)/2');
  });
});

describe('generateSolidMarginFilter', () => {
  it('produces filter with scale, pad, and format', () => {
    const filter = generateSolidMarginFilter(1.0, '#00ff00', 1280, 720);
    expect(filter).toContain('scale=');
    expect(filter).toContain('pad=');
    expect(filter).toContain('0x00ff00');
    expect(filter).toContain('format=yuv420p');
  });
});

describe('calculateSpeakerDisplaySegments', () => {
  const utterances = [
    { text: 'a', startTimestamp: 0, endTimestamp: 5, speaker: { id: 's1', name: 'Alice' } },
    { text: 'b', startTimestamp: 5, endTimestamp: 10, speaker: { id: 's1', name: 'Alice' } },
    { text: 'c', startTimestamp: 10, endTimestamp: 15, speaker: { id: 's2', name: 'Bob' } },
  ];

  it('"always" mode shows overlay for all segments', () => {
    const segments = calculateSpeakerDisplaySegments(utterances, 'always');
    expect(segments.every(s => s.showOverlay)).toBe(true);
    expect(segments).toHaveLength(3);
  });

  it('"on_speaker_change" mode shows only on change', () => {
    const segments = calculateSpeakerDisplaySegments(utterances, 'on_speaker_change');
    // First utterance (s1) → show, second (s1 same) → hide, third (s2 different) → show
    expect(segments[0].showOverlay).toBe(true);
    expect(segments[1].showOverlay).toBe(false);
    expect(segments[2].showOverlay).toBe(true);
  });

  it('returns empty for empty input', () => {
    expect(calculateSpeakerDisplaySegments([], 'always')).toEqual([]);
  });
});

describe('wrapSpeakerText', () => {
  it('returns text unchanged when within limit', () => {
    expect(wrapSpeakerText('Short text', false)).toBe('Short text');
  });

  it('wraps long text across lines', () => {
    const long = 'This is a very long role description that should wrap';
    const result = wrapSpeakerText(long, false);
    expect(result).toContain('\n');
  });

  it('forces single long word onto a line', () => {
    const word = 'Superlongwordthatexceedslimit';
    const result = wrapSpeakerText(word, true);
    // Should contain the word even though it exceeds max chars
    expect(result).toContain(word);
  });
});

describe('formatSpeakerInfo', () => {
  it('returns "Unknown Speaker" when no speaker provided', () => {
    expect(formatSpeakerInfo(undefined).name).toBe('Unknown Speaker');
  });

  it('extracts name, role, party, and color', () => {
    const info = formatSpeakerInfo({
      id: '1',
      name: 'Alice',
      roleLabel: 'Minister',
      partyLabel: 'Party A',
      partyColorHex: '#ff0000',
    });
    expect(info.name).toBe('Alice');
    expect(info.role).toBe('Minister');
    expect(info.party).toBe('Party A');
    expect(info.partyColor).toBe('#ff0000');
  });
});

describe('downloadFile', () => {
  let tmpDir: string;
  let downloadFile: (url: string) => Promise<string>;

  const bodyOf = (content: string): ReadableStream<Uint8Array> =>
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(content));
        controller.close();
      },
    });

  const respondWith = (
    content: string,
    { status = 200, contentLength }: { status?: number; contentLength?: string | null } = {},
  ) => {
    const declared = contentLength === undefined ? String(Buffer.byteLength(content)) : contentLength;
    const headers = new Headers();
    if (declared !== null) headers.set('content-length', declared);
    return vi.fn(async (_url: string, init?: { method?: string }) => ({
      ok: status >= 200 && status < 300,
      status,
      statusText: 'test',
      headers,
      body: init?.method === 'HEAD' ? null : bodyOf(content),
    }));
  };

  /**
   * An origin that answers HEAD, ranged GET and full GET independently, so the size-probe
   * fallbacks can be driven one at a time.
   */
  // Stands in for a gzipped Content-Length: smaller than the decoded body, so trusting it
  // would produce a size mismatch on every call
  const COMPRESSED_LENGTH = 4;

  const mockOrigin = (
    content: string,
    { head = 'ok', range = 'ok' }: {
      head?: 'ok' | 'no-length' | 'reject';
      range?: 'ok' | 'ignored' | 'ignored-gzip' | 'reject';
    } = {},
  ) => {
    const total = Buffer.byteLength(content);
    return vi.fn(async (_url: string, init: { method?: string; headers?: Record<string, string> } = {}) => {
      if (init.method === 'HEAD') {
        if (head === 'reject') {
          return { ok: false, status: 405, statusText: 'Method Not Allowed', headers: new Headers(), body: null };
        }
        const headers = new Headers();
        if (head === 'ok') headers.set('content-length', String(total));
        return { ok: true, status: 200, statusText: 'OK', headers, body: null };
      }
      if (init.headers?.Range !== undefined) {
        if (range === 'reject') {
          return { ok: false, status: 416, statusText: 'Range Not Satisfiable', headers: new Headers(), body: null };
        }
        if (range === 'ignored' || range === 'ignored-gzip') {
          // Origin ignores Range and offers the whole file — must not be read for its size
          const headers = new Headers();
          if (range === 'ignored-gzip') {
            // A compressed body declares the compressed length, which is not the size the
            // file takes on disk once undici has decoded it
            headers.set('content-encoding', 'gzip');
            headers.set('content-length', String(COMPRESSED_LENGTH));
          } else {
            headers.set('content-length', String(total));
          }
          return { ok: true, status: 200, statusText: 'OK', headers, body: trackedBody(content) };
        }
        const headers = new Headers({ 'content-range': `bytes 0-0/${total}` });
        return { ok: true, status: 206, statusText: 'Partial Content', headers, body: bodyOf(content.slice(0, 1)) };
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-length': String(total) }),
        body: bodyOf(content),
      };
    });
  };

  // Records whether a response body was cancelled rather than drained, so tests can pin
  // down that a size probe never streams the whole file
  let bodyCancelled = false;
  const trackedBody = (content: string): ReadableStream<Uint8Array> =>
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(content));
        controller.close();
      },
      cancel() {
        bodyCancelled = true;
      },
    });

  const partFiles = async () => (await fsp.readdir(tmpDir)).filter(f => f.includes('.part-'));

  beforeEach(async () => {
    bodyCancelled = false;
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mediaops-download-'));
    process.env.DATA_DIR = tmpDir;
    vi.resetModules();
    ({ downloadFile } = await import('./mediaOperations.js'));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.DATA_DIR;
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes the body to the final path and leaves no .part file', async () => {
    vi.stubGlobal('fetch', respondWith('video-bytes'));

    const result = await downloadFile('https://example.com/clip.mp4');

    expect(result).toBe(path.join(tmpDir, 'clip.mp4'));
    expect(await fsp.readFile(result, 'utf8')).toBe('video-bytes');
    expect(await partFiles()).toEqual([]);
  });

  it('reuses a cached file whose size matches the origin', async () => {
    const cached = path.join(tmpDir, 'clip.mp4');
    await fsp.writeFile(cached, 'video-bytes');
    const fetchMock = respondWith('video-bytes');
    vi.stubGlobal('fetch', fetchMock);

    expect(await downloadFile('https://example.com/clip.mp4')).toBe(cached);
    // Only the HEAD size check should have gone out, no re-download
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toEqual({ method: 'HEAD' });
  });

  it('re-downloads a truncated cached file instead of trusting it', async () => {
    // Regression: an OOM-killed download left a 170 MiB stub of a 2.6 GB video that every
    // later highlight reused, so ffmpeg failed with "moov atom not found" forever.
    const cached = path.join(tmpDir, 'clip.mp4');
    await fsp.writeFile(cached, 'trunc');
    vi.stubGlobal('fetch', respondWith('the-complete-video-bytes'));

    const result = await downloadFile('https://example.com/clip.mp4');

    expect(await fsp.readFile(result, 'utf8')).toBe('the-complete-video-bytes');
    expect(await partFiles()).toEqual([]);
  });

  it('keeps the cached file when the origin reports no size', async () => {
    const cached = path.join(tmpDir, 'clip.mp4');
    await fsp.writeFile(cached, 'whatever');
    vi.stubGlobal('fetch', respondWith('whatever', { contentLength: null }));

    expect(await downloadFile('https://example.com/clip.mp4')).toBe(cached);
    expect(await fsp.readFile(cached, 'utf8')).toBe('whatever');
  });

  it('downloads normally when Content-Length is blank rather than reading it as 0', async () => {
    // Number('') is 0, so a blank header must not be treated as a declared length of zero
    vi.stubGlobal('fetch', respondWith('video-bytes', { contentLength: '' }));

    const result = await downloadFile('https://example.com/clip.mp4');

    expect(await fsp.readFile(result, 'utf8')).toBe('video-bytes');
    expect(await partFiles()).toEqual([]);
  });

  it('keeps a cached file when Content-Length is blank', async () => {
    const cached = path.join(tmpDir, 'clip.mp4');
    await fsp.writeFile(cached, 'video-bytes');
    const fetchMock = respondWith('video-bytes', { contentLength: '   ' });
    vi.stubGlobal('fetch', fetchMock);

    expect(await downloadFile('https://example.com/clip.mp4')).toBe(cached);
    // A blank length is unknown rather than 0, so the range probe is tried before giving up
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws and writes nothing when the response is an error', async () => {
    vi.stubGlobal('fetch', respondWith('<html>not found</html>', { status: 404 }));

    await expect(downloadFile('https://example.com/clip.mp4')).rejects.toThrow(/Failed to download/);
    expect(await fsp.readdir(tmpDir)).toEqual([]);
  });

  it('throws and writes nothing when the body is shorter than Content-Length', async () => {
    vi.stubGlobal('fetch', respondWith('short', { contentLength: '99999' }));

    await expect(downloadFile('https://example.com/clip.mp4')).rejects.toThrow(/incomplete download/);
    expect(await fsp.readdir(tmpDir)).toEqual([]);
  });
  it('falls back to a ranged GET for the size when HEAD is rejected', async () => {
    const cached = path.join(tmpDir, 'clip.mp4');
    await fsp.writeFile(cached, 'trunc');
    vi.stubGlobal('fetch', mockOrigin('the-complete-video-bytes', { head: 'reject' }));

    const result = await downloadFile('https://example.com/clip.mp4');

    // Without the range probe the truncated cache would have been trusted forever
    expect(await fsp.readFile(result, 'utf8')).toBe('the-complete-video-bytes');
    expect(await partFiles()).toEqual([]);
  });

  it('falls back to a ranged GET when HEAD omits Content-Length', async () => {
    const cached = path.join(tmpDir, 'clip.mp4');
    await fsp.writeFile(cached, 'trunc');
    vi.stubGlobal('fetch', mockOrigin('the-complete-video-bytes', { head: 'no-length' }));

    expect(await fsp.readFile(await downloadFile('https://example.com/clip.mp4'), 'utf8')).toBe(
      'the-complete-video-bytes',
    );
  });

  it('keeps the cached file when neither HEAD nor the ranged GET reports a size', async () => {
    const cached = path.join(tmpDir, 'clip.mp4');
    await fsp.writeFile(cached, 'trunc');
    vi.stubGlobal('fetch', mockOrigin('the-complete-video-bytes', { head: 'reject', range: 'reject' }));

    // Nothing to validate against, so re-downloading every multi-GB source on every call
    // would cost far more than trusting what is on disk
    expect(await downloadFile('https://example.com/clip.mp4')).toBe(cached);
    expect(await fsp.readFile(cached, 'utf8')).toBe('trunc');
  });

  it('uses the length from a 200 when the origin ignores the range, without reading the body', async () => {
    const cached = path.join(tmpDir, 'clip.mp4');
    await fsp.writeFile(cached, 'trunc');
    vi.stubGlobal('fetch', mockOrigin('the-complete-video-bytes', { head: 'reject', range: 'ignored' }));

    const result = await downloadFile('https://example.com/clip.mp4');

    // The size was there in the headers, so the truncated cache still gets caught
    expect(await fsp.readFile(result, 'utf8')).toBe('the-complete-video-bytes');
    // ...and the probe dropped the full body instead of streaming it to learn that size
    expect(bodyCancelled).toBe(true);
  });

  it('ignores a content-encoded length from the range probe', async () => {
    const cached = path.join(tmpDir, 'clip.mp4');
    await fsp.writeFile(cached, 'video-bytes');
    const fetchMock = mockOrigin('video-bytes', { head: 'reject', range: 'ignored-gzip' });
    vi.stubGlobal('fetch', fetchMock);

    expect(await downloadFile('https://example.com/clip.mp4')).toBe(cached);
    expect(await fsp.readFile(cached, 'utf8')).toBe('video-bytes');
    // Content-Length describes the compressed bytes. Trusting it would read this intact
    // cache as a size mismatch and pull the whole source again — on every single call —
    // so the tell is that no third request went out to re-download it.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
