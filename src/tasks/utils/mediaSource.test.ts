import { describe, it, expect } from 'vitest';
import { parseMediaInfo, toSourceInfo, cacheKeyFor, classifyMediaError, mediaErrorMessage, type MediaInfo } from './mediaSource.js';

// Real `yt-dlp -O MEDIA_INFO_TEMPLATE` output for the KEX TV page of Raseborg's 12.10.2026 council
const KEXTV = JSON.stringify({
  extractor_key: 'VimeoEvent', id: '1234971994', title: 'Fullmäktige', duration: 2392, live_status: 'was_live',
  release_timestamp: 1791817200, timestamp: null, uploader: 'KEXTV', channel: null,
  webpage_url: 'https://vimeo.com/event/6265464/embed?wmode=transparent#__youtubedl_smuggle=%7B%22referer%22%3A+%22https%3A%2F%2Fwww.kextv.fi%2F%22%7D',
  thumbnail: 'https://i.vimeocdn.com/video/2211103685-05be5ca1c0d9020fc89103b2823d401686fdd36b734c', chapters: null, direct: null,
});

const info = (over: Partial<MediaInfo>): MediaInfo => ({ extractor: 'Youtube', id: 'dQw4w9WgXcQ', direct: false, ...over });

describe('parseMediaInfo', () => {
  it('maps a looked-up page to source metadata, the start time from release_timestamp', () => {
    expect(parseMediaInfo(KEXTV)).toEqual({
      extractor: 'VimeoEvent',
      id: '1234971994',
      direct: false,
      title: 'Fullmäktige',
      durationSec: 2392,
      liveStatus: 'was_live',
      startedAt: '2026-10-12T15:00:00.000Z',
      uploader: 'KEXTV',
      // the referer yt-dlp smuggles in the fragment is not part of the page's address
      webpageUrl: 'https://vimeo.com/event/6265464/embed?wmode=transparent',
      thumbnailUrl: 'https://i.vimeocdn.com/video/2211103685-05be5ca1c0d9020fc89103b2823d401686fdd36b734c',
      chapters: undefined,
    });
  });

  it('marks a plain media file as direct, with nothing the file does not report', () => {
    const parsed = parseMediaInfo('{"extractor_key": "Generic", "id": "20261021_RMK__LXIII_CZ4_720", ' +
      '"title": "20261021_RMK__LXIII_CZ4_720", "duration": null, "live_status": null, "direct": true}');
    expect(parsed).toMatchObject({ extractor: 'Generic', direct: true, durationSec: undefined, liveStatus: undefined });
    expect(toSourceInfo(parsed).kind).toBe('file');
  });

  it('reads the last line when yt-dlp prints a warning first, and keeps chapters', () => {
    const parsed = parseMediaInfo('WARNING: falling back\n{"extractor_key": "Youtube", "id": "dQw4w9WgXcQ", ' +
      '"timestamp": 1700000000, "chapters": [{"title": "Item 1", "start_time": 0, "end_time": 95.5}]}');
    expect(parsed.startedAt).toBe('2023-11-14T22:13:20.000Z');
    expect(parsed.chapters).toEqual([{ title: 'Item 1', startSeconds: 0, endSeconds: 95.5 }]);
  });

  // yt-dlp exits 0 with no output on a page where it finds nothing (Kraków's RSS feed)
  it('reports no video as unsupported, a failure waiting cannot fix', () => {
    const err = (() => { try { parseMediaInfo(''); } catch (e) { return e; } })();
    expect(classifyMediaError(err)).toMatchObject({ reason: 'unsupported', permanent: true });
  });

  // A channel URL prints a line per entry, each with the channel's id as playlist_id; the
  // last line would be some arbitrary video of the channel.
  it.each([
    ['a channel entry', '{"extractor_key": "Youtube", "id": "cdPyuLr_rI0", "playlist_id": "UCBR8-60-B28hp2BmDPdntcQ"}'],
    ['several entries', '{"extractor_key": "Youtube", "id": "a"}\n{"extractor_key": "Youtube", "id": "b"}'],
  ])('refuses %s as a playlist rather than downloading one of its videos', (_case, stdout) => {
    const err = (() => { try { parseMediaInfo(stdout); } catch (e) { return e; } })();
    expect(classifyMediaError(err)).toMatchObject({ reason: 'playlist', permanent: true });
  });

  it('throws when the media info lacks an extractor or id', () => {
    expect(() => parseMediaInfo('{"title": "x"}')).toThrow(/lacks an extractor or id/);
  });
});

describe('cacheKeyFor', () => {
  it('keeps the keys existing YouTube and Facebook media already carries', () => {
    expect(cacheKeyFor(info({}), 'https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(cacheKeyFor(info({ extractor: 'Facebook', id: '985543467438673' }), 'https://fb.watch/x')).toBe('fb-985543467438673');
  });

  it('prefixes other extractors, so ids from different sites cannot collide', () => {
    expect(cacheKeyFor(info({ extractor: 'VimeoEvent', id: '1234971994' }), 'https://www.kextv.fi/sv/programarkiv/524')).toMatch(/^vimeoevent-1234971994-[a-f0-9]{16}$/);
  });

  it('keeps only file-name-safe characters', () => {
    expect(cacheKeyFor(info({ extractor: 'Viidea', id: '../x y' }), 'https://edemokracija.viidea.com/x')).toMatch(/^viidea-___x_y-[a-f0-9]{16}$/);
  });

  it('keeps HTML5 videos on different pages out of each others cache', () => {
    const media = info({ extractor: 'HTML5MediaEmbed', id: 'index-1' });
    expect(cacheKeyFor(media, 'https://city-a.example/index')).not.toBe(cacheKeyFor(media, 'https://city-b.example/index'));
  });

  it('does not collide when unsafe ids normalize to the same filename', () => {
    expect(cacheKeyFor(info({ extractor: 'Viidea', id: 'a/b' }), 'https://example.org/x'))
      .not.toBe(cacheKeyFor(info({ extractor: 'Viidea', id: 'a_b' }), 'https://example.org/x'));
  });

  it('keys a Generic source by its URL: its id is a file or page name that repeats across sites', () => {
    const a = cacheKeyFor(info({ extractor: 'Generic', id: 'video', direct: true }), 'https://a.example/video.mp4');
    const b = cacheKeyFor(info({ extractor: 'Generic', id: 'video', direct: true }), 'https://b.example/video.mp4');
    expect(a).toMatch(/^url-[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
    expect(cacheKeyFor(info({ extractor: 'Generic', id: 'video', direct: true }), 'https://a.example/video.mp4')).toBe(a);
  });
});

describe('classifyMediaError', () => {
  // Messages as yt-dlp 2026.10 prints them
  it.each([
    ['ERROR: Unsupported URL: https://www.krakow.pl/', 'unsupported'],
    ['Invalid YouTube video ID', 'unsupported'],
    ['ERROR: [vimeo:event] 6265464: Cannot download embed-only video without embedding URL. Please call yt-dlp with the URL of the page that embeds this video.', 'embed_only'],
    ['ERROR: [vimeo] 1234971994: The web client only works when logged-in. Use --cookies', 'login_required'],
    ['ERROR: [facebook] 985543467438673: This video is only available for registered users. Use --cookies for the authentication.', 'login_required'],
    ['ERROR: This format is DRM protected; Try selecting another format with --format', 'drm'],
    ['ERROR: [youtube] x: Video unavailable', 'unavailable'],
    ['ERROR: [generic] does-not-exist: Unable to download webpage: HTTP Error 404: Not Found (caused by <HTTPError 404: Not Found>)', 'not_found'],
  ])('classifies %s as permanent: %s', (message, reason) => {
    expect(classifyMediaError(new Error(message))).toMatchObject({ reason, permanent: true });
  });

  // Transient conditions, including ones that read like a dead end, must stay retryable:
  // they clear once a post-live VOD finishes processing.
  it.each([
    'ERROR: [facebook] 985543467438673: The video is not available, Facebook said: "This content isn\'t available right now"',
    'ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm you\'re not a bot',
    'ERROR: fragment 12 not found, unable to continue: HTTP Error 404: Not Found',
    'yt-dlp: HTTP Error 403',
  ])('keeps %s retryable', (message) => {
    expect(classifyMediaError(new Error(message))).toEqual({ reason: 'error', permanent: false });
  });

  it('tells the caller what URL to send instead of an embed-only video', () => {
    expect(classifyMediaError(new Error('Cannot download embed-only video')).hint).toMatch(/page that embeds it/);
  });
});

describe('mediaErrorMessage', () => {
  it('keeps the ERROR lines of an exec failure, without its argv and warnings', () => {
    const err = new Error('Command failed: yt-dlp -O ... https://vimeo.com/1\nWARNING: [vimeo] impersonation\n' +
      'ERROR: This format is DRM protected\nERROR: This format is DRM protected\n');
    expect(mediaErrorMessage(err)).toBe('ERROR: This format is DRM protected');
  });
});
