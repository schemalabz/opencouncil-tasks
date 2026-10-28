import { describe, it, expect, vi } from 'vitest';
import {
  offlineSource, formatBytes, parseLoudnormStats, needsLoudnormCorrection, isSilentAudio,
  downloadUntilComplete, isCachedMediaFor, parseVideoStartShift, buildRewriteArgs,
  parseFrameSeconds, isVideoStartShifted,
  type CompleteDownloadDeps, type CompleteDownloadConfig, type RawVideo,
} from './downloadYTV.js';
import { isPermanentMediaError } from './utils/mediaSource.js';

describe('offlineSource', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?t=42'],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ'],
    ['https://www.youtube.com/live/dQw4w9WgXcQ?si=abc'],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ'],
  ])('keys the YouTube URL %s by its video id', (url) => {
    expect(offlineSource(url)).toMatchObject({ kind: 'yt-dlp', cacheKey: 'dQw4w9WgXcQ', sourceType: 'YouTube' });
  });

  // The id becomes a file name in the data dir, so only the 11 url-safe
  // characters of a real YouTube id pass.
  it.each([
    'https://www.youtube.com/watch?v=..%2F..%2Fetc%2Fcron.d%2Fx',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ;rm',
    'https://youtu.be/short',
    'https://www.youtube.com/embed/dQw4w9WgXcQdQw4w9WgXcQ',
  ])('rejects a YouTube id that is not 11 url-safe characters: %s', (url) => {
    expect(() => offlineSource(url)).toThrow('Invalid YouTube video ID');
  });

  // yt-dlp gets the string as an argument, so a value that is not a URL
  // (an option, a path, a data: URL) is refused before it gets there.
  it.each([
    '--exec "id" https://youtu.be/dQw4w9WgXcQ',
    '-o /tmp/x youtube.com/watch?v=dQw4w9WgXcQ',
    'file:///etc/passwd',
    'data:text/plain,youtu.be/dQw4w9WgXcQ',
    '/data/other-task.mp4',
  ])('rejects a value that is not an http(s) URL: %s', (url) => {
    expect(() => offlineSource(url)).toThrow(/^youtubeUrl /);
  });

  it.each([
    ['https://www.facebook.com/100064500710523/videos/985543467438673', 'fb-985543467438673'],
    ['https://m.facebook.com/somepage/videos/meeting-24-06/985543467438673/', 'fb-985543467438673'],
    ['https://mbasic.facebook.com/100064500710523/videos/985543467438673', 'fb-985543467438673'],
    ['https://www.facebook.com/watch/?v=985543467438673', 'fb-985543467438673'],
    // An opaque share code, not the numeric id: yt-dlp follows Facebook's redirect to the
    // canonical video URL. It is stable, so it works as a cache key.
    ['https://www.facebook.com/share/v/1JGm6KHxyJ/', 'fb-1JGm6KHxyJ'],
    ['https://fb.watch/aBcD3fGh1/', 'fb-aBcD3fGh1'],
  ])('keys the Facebook URL %s as %s', (url, cacheKey) => {
    expect(offlineSource(url)).toMatchObject({ kind: 'yt-dlp', cacheKey, sourceType: 'Facebook' });
  });

  it('keys our own Spaces object by its name, so it never reaches yt-dlp', () => {
    vi.stubEnv('DO_SPACES_BUCKET', 'opencouncil');
    vi.stubEnv('DO_SPACES_ENDPOINT', 'https://fra1.digitaloceanspaces.com');
    try {
      expect(offlineSource('https://opencouncil.fra1.digitaloceanspaces.com/council-meeting-videos/athens-2026-10-01_v3.mp4'))
        .toEqual({ kind: 'spaces', cacheKey: 'athens-2026-10-01_v3', sourceType: 'Spaces' });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // A lookup resolves these: yt-dlp knows more URL forms than we parse, and a page
  // that is not a video fails there as unsupported.
  it.each([
    'https://youtube.com/watch',
    'https://www.youtube.com/@somecity/streams',
    'https://www.facebook.com/somepage',
    'https://www.facebook.com/somepage/videos/123abc',
    'https://youtube.com.example.org/watch?v=dQw4w9WgXcQ',
    'https://vimeo.com/event/6265464',
    'https://mediampi.krakow.pl/mktv/2026/10/20261021_RMK__LXIII_CZ4_720.mp4',
  ])('leaves %s to the lookup', (url) => {
    expect(offlineSource(url)).toBeUndefined();
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

describe('needsLoudnormCorrection', () => {
  const stats = (input_i: string, input_tp: string) => ({
    input_i,
    input_tp,
    input_lra: '11.00',
    input_thresh: '-25.00',
  });

  it('skips correction when loudness is within tolerance', () => {
    expect(needsLoudnormCorrection(stats('-14.46', '-2.10'))).toBe(false);
  });

  it('skips correction for an already-normalized file measuring at the target', () => {
    expect(needsLoudnormCorrection(stats('-14.00', '-1.50'))).toBe(false);
  });

  // The AAC re-encode overshoots the true-peak limiter (observed: TP went
  // +0.69 → +1.98 dBTP through one normalize cycle), so TP alone must not
  // trigger normalization — it would re-normalize the same file on every
  // rerun without ever converging.
  it('does not re-normalize for true-peak overshoot when loudness is on target', () => {
    expect(needsLoudnormCorrection(stats('-14.64', '1.98'))).toBe(false);
  });

  it('corrects when the audio is too quiet', () => {
    expect(needsLoudnormCorrection(stats('-27.10', '-8.34'))).toBe(true);
  });

  it('corrects when the audio is too loud', () => {
    expect(needsLoudnormCorrection(stats('-11.20', '-3.00'))).toBe(true);
  });

  // Silent audio measures -inf, which ffmpeg's pass 2 rejects outright
  // (`measured_I` must be in [-99, 0]) — normalizing it is never the answer.
  it('does not correct when the measurement is not a parseable number', () => {
    expect(needsLoudnormCorrection(stats('-inf', '-inf'))).toBe(false);
  });
});

describe('isSilentAudio', () => {
  const stats = (input_i: string) => ({
    input_i,
    input_tp: '-1.50',
    input_lra: '11.00',
    input_thresh: '-25.00',
  });

  // Both production occurrences (chania 10/08, chalandri 29/07) measured -inf
  it('treats digital silence as silent', () => {
    expect(isSilentAudio(stats('-inf'))).toBe(true);
  });

  it('treats a measurable but sub-floor level as silent', () => {
    expect(isSilentAudio(stats('-72.53'))).toBe(true);
  });

  it('accepts badly under-recorded but usable audio', () => {
    expect(isSilentAudio(stats('-45.00'))).toBe(false);
  });

  it('accepts normal audio', () => {
    expect(isSilentAudio(stats('-27.10'))).toBe(false);
  });
});

describe('parseVideoStartShift', () => {
  // Facebook download (samothraki oct26_2026): edit list media time 10640/16000
  it('measures the shift that the edit list hides', () => {
    expect(parseVideoStartShift('0.000000', '0.665000')).toBeCloseTo(0.665);
  });

  it('is zero when the edit list does not move the first frame', () => {
    expect(parseVideoStartShift('0.000000', '0.000000')).toBe(0);
  });

  it('is zero for a file with no video stream (ffprobe prints nothing)', () => {
    expect(parseVideoStartShift('', '')).toBe(0);
  });

  it('is zero when ffprobe prints N/A', () => {
    expect(parseVideoStartShift('N/A', 'N/A')).toBe(0);
  });
});

describe('buildRewriteArgs', () => {
  const FILTER = 'loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=-27.1:linear=true';

  it('normalizes loudness: re-encodes the audio, copies the video, keeps the timestamps', () => {
    expect(buildRewriteArgs('in.mp4', 'out.mp4', { loudnormFilter: FILTER, rebuildVideoDts: false })).toEqual([
      '-i', 'in.mp4', '-c:v', 'copy', '-af', FILTER, '-c:a', 'aac', '-b:a', '128k', '-y', 'out.mp4',
    ]);
  });

  it('rebuilds the video decode timestamps in the same pass as loudness normalization', () => {
    expect(buildRewriteArgs('in.mp4', 'out.mp4', { loudnormFilter: FILTER, rebuildVideoDts: true })).toEqual([
      '-fflags', '+igndts', '-i', 'in.mp4', '-c:v', 'copy', '-af', FILTER, '-c:a', 'aac', '-b:a', '128k', '-y', 'out.mp4',
    ]);
  });

  // The SKIP_LOUDNORM and within-tolerance cases: a remux only, both streams copied
  it('rebuilds the video decode timestamps without touching the audio', () => {
    expect(buildRewriteArgs('in.mp4', 'out.mp4', { loudnormFilter: null, rebuildVideoDts: true })).toEqual([
      '-fflags', '+igndts', '-i', 'in.mp4', '-c:v', 'copy', '-c:a', 'copy', '-y', 'out.mp4',
    ]);
  });
});

describe('parseFrameSeconds', () => {
  it('reads a rational frame rate', () => {
    expect(parseFrameSeconds('30000/1001')).toBeCloseTo(1001 / 30000);
  });

  // Facebook's variable frame rate (samothraki oct26_2026)
  it('reads an uneven average frame rate', () => {
    expect(parseFrameSeconds('14111400/526567')).toBeCloseTo(526567 / 14111400);
  });

  it('is null for an unknown rate (ffprobe prints 0/0, or nothing without a video stream)', () => {
    expect(parseFrameSeconds('0/0')).toBeNull();
    expect(parseFrameSeconds('')).toBeNull();
  });
});

describe('isVideoStartShifted', () => {
  const FPS30 = 1 / 30;

  it('flags the Facebook decode delay (samothraki: 0.665 s at ~27 fps, 2.938 s at ~15 fps)', () => {
    expect(isVideoStartShifted(0.665, 1 / 26.8)).toBe(true);
    expect(isVideoStartShifted(2.938, 1 / 15)).toBe(true);
  });

  it('leaves a normal one- or two-frame delay alone', () => {
    expect(isVideoStartShifted(0.033, FPS30)).toBe(false);
    expect(isVideoStartShifted(0.067, FPS30)).toBe(false);
  });

  // A rebuilt low-frame-rate file still starts two frames in; it must not be rebuilt on every run
  it('leaves a two-frame delay alone at a low frame rate, even above 0.1 s', () => {
    expect(isVideoStartShifted(0.267, 1 / 7.5)).toBe(false);
  });

  it('uses the time bound alone when the frame rate is unknown', () => {
    expect(isVideoStartShifted(0.665, null)).toBe(true);
    expect(isVideoStartShifted(0.08, null)).toBe(false);
  });
});

describe('downloadUntilComplete', () => {
  const CONFIG: CompleteDownloadConfig = {
    maxWaitMs: 90 * 60_000,
    pollIntervalMs: 3 * 60_000,
    completenessRatio: 0.98,
    minShortfallSeconds: 120,
  };

  const RAW: RawVideo = { combined: 'v.mp4' };

  // A fake clock that `sleep` advances, so timeout logic runs without real waiting.
  function makeClock() {
    let t = 0;
    return { now: () => t, sleep: vi.fn(async (ms: number) => { t += ms; }) };
  }

  function makeDeps(overrides: Partial<CompleteDownloadDeps> = {}): CompleteDownloadDeps {
    const clock = makeClock();
    return {
      download: vi.fn().mockResolvedValue(RAW),
      getInfo: vi.fn().mockResolvedValue({ liveStatus: 'was_live', durationSec: 7200 }),
      probeDurationSeconds: vi.fn().mockResolvedValue(7200),
      dropCachedMedia: vi.fn(),
      downloadedBytes: vi.fn().mockReturnValue(0),
      isRetryable: (err) => !isPermanentMediaError(err),
      sleep: clock.sleep,
      now: clock.now,
      ...overrides,
    };
  }

  it('returns the raw download immediately when it is already complete (D ≈ M)', async () => {
    const deps = makeDeps();

    const result = await downloadUntilComplete('https://youtu.be/dQw4w9WgXcQ', deps, CONFIG, () => {});

    expect(result).toEqual(RAW);
    expect(deps.download).toHaveBeenCalledTimes(1);
    expect(deps.sleep).not.toHaveBeenCalled();
    expect(deps.dropCachedMedia).not.toHaveBeenCalled();
  });

  it('retries a short (still-processing) download until it becomes complete', async () => {
    // VOD still processing → first download is truncated, later one is full.
    const probeDurationSeconds = vi.fn()
      .mockResolvedValueOnce(600)   // 600s of a ~7200s recording
      .mockResolvedValueOnce(7200); // now complete
    const deps = makeDeps({ probeDurationSeconds });

    const result = await downloadUntilComplete('https://youtu.be/dQw4w9WgXcQ', deps, CONFIG, () => {});

    expect(result).toEqual(RAW);
    expect(deps.download).toHaveBeenCalledTimes(2);
    expect(deps.dropCachedMedia).toHaveBeenCalledTimes(1); // partial dropped before retry
    expect(deps.sleep).toHaveBeenCalledTimes(1);
  });

  it('accepts against a fresh, smaller M that the stale first M would reject (M shrinks toward truth)', async () => {
    // M over-reports while the VOD processes; a frozen first M would retry a genuinely
    // complete shorter recording until maxWait. The fresh per-attempt fetch must win.
    const getInfo = vi.fn()
      .mockResolvedValueOnce({ liveStatus: 'post_live', durationSec: 7200 })
      .mockResolvedValueOnce({ liveStatus: 'was_live', durationSec: 650 });
    const probeDurationSeconds = vi.fn()
      .mockResolvedValueOnce(600)
      .mockResolvedValueOnce(645); // complete vs fresh M=650; hopeless vs stale M=7200
    const deps = makeDeps({ getInfo, probeDurationSeconds });

    const result = await downloadUntilComplete('https://youtu.be/dQw4w9WgXcQ', deps, CONFIG, () => {});

    expect(result).toEqual(RAW);
    expect(deps.download).toHaveBeenCalledTimes(2);
  });

  it('does not retry a download its source says is not retryable (a file or Spaces object fails the same way again)', async () => {
    const download = vi.fn().mockRejectedValue(new Error('HTTP error getting url: status: 404 Not Found'));
    const deps = makeDeps({ download, getInfo: vi.fn().mockResolvedValue({}), isRetryable: () => false });

    const err = await downloadUntilComplete('https://cdn.example.com/v.mp4', deps, CONFIG, () => {})
      .catch((e) => e as Error) as Error;

    expect(err.message).toContain('404');
    expect(download).toHaveBeenCalledTimes(1);
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it('fails fast on a permanently-gone YouTube video instead of burning the full wait', async () => {
    const download = vi.fn().mockRejectedValue(new Error('yt-dlp download failed: ERROR: [youtube] x: Video unavailable'));
    const deps = makeDeps({ download });

    const err = await downloadUntilComplete('https://youtu.be/dQw4w9WgXcQ', deps, CONFIG, () => {})
      .catch((e) => e as Error) as Error;

    expect(err.message).toContain('Video unavailable');
    expect(download).toHaveBeenCalledTimes(1);
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it('retries when the download itself throws (still-processing VOD), then succeeds', async () => {
    const download = vi.fn()
      .mockRejectedValueOnce(new Error('yt-dlp: HTTP Error 403')) // fails while still processing
      .mockResolvedValueOnce(RAW);
    const deps = makeDeps({ download });

    const result = await downloadUntilComplete('https://youtu.be/dQw4w9WgXcQ', deps, CONFIG, () => {});

    expect(result).toEqual(RAW);
    expect(download).toHaveBeenCalledTimes(2);
    expect(deps.dropCachedMedia).toHaveBeenCalledTimes(1);
    expect(deps.sleep).toHaveBeenCalledTimes(1);
  });

  it('gives up with an informative error after the max wait', async () => {
    const deps = makeDeps({ probeDurationSeconds: vi.fn().mockResolvedValue(600) }); // never completes
    const onProgress = vi.fn();

    const err = await downloadUntilComplete('https://youtu.be/dQw4w9WgXcQ', deps, CONFIG, onProgress)
      .catch((e) => e as Error) as Error;

    expect(err.message).toMatch(/not downloadable within \d+min/);
    expect(err.message).toContain('got 600s of ~7200s'); // the shortfall is surfaced
    expect((deps.download as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);
    // reported the wait to the caller (existing callback mechanism) rather than looking hung
    expect(onProgress).toHaveBeenCalledWith('waiting-for-vod', expect.any(Number));
  });

  it('accepts the first download when there is no reported duration (non-YouTube source)', async () => {
    const deps = makeDeps({
      download: vi.fn().mockResolvedValue(RAW),
      getInfo: vi.fn().mockResolvedValue({}), // non-YouTube: nothing to verify against
      probeDurationSeconds: vi.fn().mockResolvedValue(123),
    });

    const result = await downloadUntilComplete('https://cdn.example.com/v.mp4', deps, CONFIG, () => {});

    expect(result).toEqual(RAW);
    expect(deps.download).toHaveBeenCalledTimes(1);
    expect(deps.sleep).not.toHaveBeenCalled();
    // With no M there is nothing to verify, so the file must not be probed at all —
    // a valid recording whose container reports no duration would otherwise fail the task.
    expect(deps.probeDurationSeconds).not.toHaveBeenCalled();
  });

  it.each([
    'ERROR: Unsupported URL: https://www.krakow.pl/',
    'ERROR: [vimeo:event] 6265464: Cannot download embed-only video without embedding URL.',
  ])('fails at the lookup, before any download, when it says waiting cannot help: %s', async (message) => {
    const deps = makeDeps({ getInfo: vi.fn().mockRejectedValue(new Error(message)) });

    const err = await downloadUntilComplete('https://example.org/page', deps, CONFIG, () => {})
      .catch((e) => e as Error) as Error;

    expect(err.message).toBe(message);
    expect(deps.download).not.toHaveBeenCalled();
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it('accepts the download when fetching video info fails (no M to verify against)', async () => {
    // A metadata fetch hiccup must not fail or stall an otherwise good download —
    // same behavior as sources with no reported duration.
    const deps = makeDeps({
      getInfo: vi.fn().mockRejectedValue(new Error('yt-dlp: network unreachable')),
      probeDurationSeconds: vi.fn().mockResolvedValue(600),
    });

    const result = await downloadUntilComplete('https://youtu.be/dQw4w9WgXcQ', deps, CONFIG, () => {});

    expect(result).toEqual(RAW);
    expect(deps.download).toHaveBeenCalledTimes(1);
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it('falls back to the last known duration when getInfo fails mid-loop (a metadata blip must not accept a partial)', async () => {
    // Observed live: YouTube's "sign in to confirm you're not a bot" wave can break the
    // metadata fetch while a (partial) download still succeeds. Without a remembered M,
    // attempt 2 would be accepted unverified.
    const getInfo = vi.fn()
      .mockResolvedValueOnce({ liveStatus: 'post_live', durationSec: 7200 })
      .mockRejectedValueOnce(new Error('Sign in to confirm you are not a bot'))
      .mockResolvedValueOnce({ liveStatus: 'was_live', durationSec: 7200 });
    const probeDurationSeconds = vi.fn()
      .mockResolvedValueOnce(600)   // attempt 1: partial (M known: 7200)
      .mockResolvedValueOnce(650)   // attempt 2: still partial — must be judged against the remembered M
      .mockResolvedValueOnce(7200); // attempt 3: complete
    const deps = makeDeps({ getInfo, probeDurationSeconds });

    const result = await downloadUntilComplete('https://youtu.be/dQw4w9WgXcQ', deps, CONFIG, () => {});

    expect(result).toEqual(RAW);
    expect(deps.download).toHaveBeenCalledTimes(3); // attempt 2 was rejected, not accepted
  });

  it('accepts a download that is short only within the absolute tolerance (trimmed pre-roll / gaps)', async () => {
    const deps = makeDeps({
      getInfo: vi.fn().mockResolvedValue({ liveStatus: 'was_live', durationSec: 1000 }),
      probeDurationSeconds: vi.fn().mockResolvedValue(900), // 100s short, below the 120s floor
    });

    const result = await downloadUntilComplete('https://youtu.be/dQw4w9WgXcQ', deps, CONFIG, () => {});

    expect(deps.download).toHaveBeenCalledTimes(1);
    expect(result).toEqual(RAW);
  });

  it('drops the partial BEFORE the retry re-downloads (so it does not reuse the cached partial)', async () => {
    // downloadYTV reuses any non-empty cached .mp4, so a partial must be removed before the
    // next attempt — otherwise the retry re-grabs the same partial forever.
    const order: string[] = [];
    const download = vi.fn(async () => { order.push('download'); return RAW; });
    const dropCachedMedia = vi.fn(() => { order.push('drop'); });
    const probeDurationSeconds = vi.fn()
      .mockResolvedValueOnce(600)   // attempt 1: partial
      .mockResolvedValueOnce(7200); // attempt 2: complete
    const deps = makeDeps({ download, dropCachedMedia, probeDurationSeconds });

    await downloadUntilComplete('https://youtu.be/dQw4w9WgXcQ', deps, CONFIG, () => {});

    expect(order).toEqual(['download', 'drop', 'download']);
  });

  it('samples live_status on a timer DURING a long download, even when yt-dlp emits no progress ticks', async () => {
    // One throttled download attempt can span the whole post_live window; without
    // mid-download sampling the post_live→was_live flip time is never observed —
    // and that clear-time distribution is the data the next iteration decides on.
    // Observed in the wild: the DVR/fragmented downloader for a post_live VOD emits
    // almost no progress callbacks, so sampling must not depend on ticks.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const getInfo = vi.fn()
        .mockResolvedValueOnce({ liveStatus: 'post_live', durationSec: 7200 }) // attempt start
        .mockResolvedValue({ liveStatus: 'was_live', durationSec: 7200 });     // mid-download samples
      let finishDownload!: (v: RawVideo) => void;
      const download = vi.fn(() => new Promise<RawVideo>((resolve) => { finishDownload = resolve; }));
      const deps = makeDeps({ download, getInfo });

      const result = downloadUntilComplete('https://youtu.be/dQw4w9WgXcQ', deps, CONFIG, () => {});
      await vi.advanceTimersByTimeAsync(0);                      // attempt-start getInfo, download begins
      await vi.advanceTimersByTimeAsync(CONFIG.pollIntervalMs);  // 1st mid-download sample
      await vi.advanceTimersByTimeAsync(CONFIG.pollIntervalMs);  // 2nd mid-download sample
      finishDownload(RAW);
      await expect(result).resolves.toEqual(RAW);

      expect(getInfo).toHaveBeenCalledTimes(3); // attempt start + two timer samples, zero ticks needed
      const logged = logSpy.mock.calls.map((args) => args.join(' ')).join('\n');
      expect(logged).toContain('was post_live'); // the flip was captured DURING the download
    } finally {
      vi.useRealTimers();
      logSpy.mockRestore();
    }
  });

  it('logs a heartbeat with downloaded bytes when a sample shows no status change (no-flip must be derivable from the log)', async () => {
    // Absence of a transition line only proves "no flip" if the log also shows the
    // sampler was alive and checking — otherwise a dead sampler reads as a quiet VOD.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const getInfo = vi.fn().mockResolvedValue({ liveStatus: 'post_live', durationSec: 7200 });
      const downloadedBytes = vi.fn().mockReturnValue(87 * 1024 * 1024);
      let finishDownload!: (v: RawVideo) => void;
      const download = vi.fn(() => new Promise<RawVideo>((resolve) => { finishDownload = resolve; }));
      const deps = makeDeps({ download, getInfo, downloadedBytes });

      const result = downloadUntilComplete('https://youtu.be/dQw4w9WgXcQ', deps, CONFIG, () => {});
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(CONFIG.pollIntervalMs); // sample: unchanged → heartbeat
      finishDownload(RAW);
      await expect(result).resolves.toEqual(RAW);

      const logged = logSpy.mock.calls.map((args) => args.join(' ')).join('\n');
      expect(logged).toContain('still post_live');
      expect(logged).toContain('87 MB');

      // The sampler must die with the attempt — a leaked interval would poll yt-dlp
      // every few minutes forever in the long-lived server process.
      await vi.advanceTimersByTimeAsync(CONFIG.pollIntervalMs);
      expect(getInfo).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      logSpy.mockRestore();
    }
  });

  it('logs when a mid-download live_status check fails (a broken sampler must not read as "no flip")', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const getInfo = vi.fn()
        .mockResolvedValueOnce({ liveStatus: 'post_live', durationSec: 7200 }) // attempt start
        .mockRejectedValue(new Error('Sign in to confirm you are not a bot')); // samples fail
      let finishDownload!: (v: RawVideo) => void;
      const download = vi.fn(() => new Promise<RawVideo>((resolve) => { finishDownload = resolve; }));
      const deps = makeDeps({ download, getInfo });

      const result = downloadUntilComplete('https://youtu.be/dQw4w9WgXcQ', deps, CONFIG, () => {});
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(CONFIG.pollIntervalMs); // sample fails → must be visible
      finishDownload(RAW);
      await expect(result).resolves.toEqual(RAW);

      const warned = warnSpy.mock.calls.map((args) => args.join(' ')).join('\n');
      expect(warned).toContain('live_status check failed');
    } finally {
      vi.useRealTimers();
      warnSpy.mockRestore();
    }
  });

  it('fails fast on a Facebook login wall instead of burning the full wait (waiting cannot fix it)', async () => {
    // Exact message shape from yt-dlp: the facebook extractor calls raise_login_required()
    // on "You must log in to continue" pages, whose default message is below.
    const download = vi.fn().mockRejectedValue(new Error(
      'yt-dlp download failed: ERROR: [facebook] 985543467438673: This video is only available for registered users. Use --cookies for the authentication.'));
    const deps = makeDeps({ download });

    const err = await downloadUntilComplete(
      'https://www.facebook.com/somepage/videos/985543467438673', deps, CONFIG, () => {})
      .catch((e) => e as Error) as Error;

    expect(err.message).toContain('registered users');
    expect(download).toHaveBeenCalledTimes(1);
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  // Exact messages from yt-dlp 2026.08.19: KEX TV's domain-restricted videos, and a
  // Vimeo video served only as FairPlay-encrypted HLS.
  it.each([
    ['https://vimeo.com/event/6265464',
      'yt-dlp download failed: ERROR: [vimeo:event] 6265464: Cannot download embed-only video without embedding URL. Please call yt-dlp with the URL of the page that embeds this video.'],
    ['https://vimeo.com/1234971994',
      'yt-dlp download failed: ERROR: [vimeo] 1234971994: The web client only works when logged-in. Use --cookies, --cookies-from-browser, --username and --password, --netrc-cmd, or --netrc (vimeo) to provide account credentials.'],
    ['https://player.vimeo.com/video/76979871',
      'yt-dlp download failed: yt-dlp exited with code 1: ERROR: This format is DRM protected; Try selecting another format with --format or add --check-formats to automatically fallback to the next best format'],
  ])('fails fast on a Vimeo video waiting cannot fix (%s)', async (url, message) => {
    const download = vi.fn().mockRejectedValue(new Error(message));
    const deps = makeDeps({ download });

    const err = await downloadUntilComplete(url, deps, CONFIG, () => {}).catch((e) => e as Error) as Error;

    expect(err.message).toBe(message);
    expect(download).toHaveBeenCalledTimes(1);
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it('retries a Facebook download failure (post-live VOD may still be processing), then succeeds', async () => {
    // yt-dlp wraps ANY Facebook interstitial as 'The video is not available, Facebook
    // said: "..."' — including the transient page served while a post-live VOD is
    // processing — so that wrapper must stay retryable, not permanent.
    const download = vi.fn()
      .mockRejectedValueOnce(new Error(
        'yt-dlp download failed: ERROR: [facebook] 985543467438673: The video is not available, Facebook said: "This content isn\'t available right now"'))
      .mockRejectedValueOnce(new Error('yt-dlp download failed: ERROR: [facebook] Cannot parse data'))
      .mockResolvedValueOnce(RAW);
    const deps = makeDeps({ download });

    const result = await downloadUntilComplete(
      'https://www.facebook.com/somepage/videos/985543467438673', deps, CONFIG, () => {});

    expect(result).toEqual(RAW);
    expect(download).toHaveBeenCalledTimes(3);
    expect(deps.sleep).toHaveBeenCalledTimes(2);
  });

  it('logs live_status transitions across attempts (data-gathering, not gating)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const getInfo = vi.fn()
        .mockResolvedValueOnce({ liveStatus: 'post_live', durationSec: 7200 })
        .mockResolvedValueOnce({ liveStatus: 'was_live', durationSec: 7200 });
      const probeDurationSeconds = vi.fn()
        .mockResolvedValueOnce(600)
        .mockResolvedValueOnce(7200);
      const deps = makeDeps({ getInfo, probeDurationSeconds });

      await downloadUntilComplete('https://youtu.be/dQw4w9WgXcQ', deps, CONFIG, () => {});

      const logged = logSpy.mock.calls.map((args) => args.join(' ')).join('\n');
      expect(logged).toContain('live_status=post_live');
      expect(logged).toContain('live_status=was_live');
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('isCachedMediaFor', () => {
  const videoId = 'EcGyyyrLNhQ';

  it('matches the downloaded media and yt-dlp intermediates', () => {
    expect(isCachedMediaFor(videoId, videoId)).toBe(true);
    expect(isCachedMediaFor(videoId, `${videoId}.mp4`)).toBe(true);
    expect(isCachedMediaFor(videoId, `${videoId}.mp3`)).toBe(true);
    expect(isCachedMediaFor(videoId, `${videoId}.f399.mp4`)).toBe(true);
    expect(isCachedMediaFor(videoId, `${videoId}.mp4.part`)).toBe(true);
  });

  it('matches the split audio derived from it', () => {
    expect(isCachedMediaFor(videoId, `${videoId}_segment_0_0-620.mp3`)).toBe(true);
    expect(isCachedMediaFor(videoId, `${videoId}_full_0-880.mp3`)).toBe(true);
  });

  it('leaves a Spaces-sourced sibling task alone', () => {
    // A Spaces reprocess takes its videoId from the object basename, so `<id>_v1` is
    // another task's own media — not a variant of this video's.
    expect(isCachedMediaFor(videoId, `${videoId}_v1.mp3`)).toBe(false);
    expect(isCachedMediaFor(videoId, `${videoId}_v1.mp4`)).toBe(false);
    expect(isCachedMediaFor(videoId, `${videoId}_v1_full_0-880.mp3`)).toBe(false);
  });

  it('does not match a different video whose id merely shares the prefix', () => {
    expect(isCachedMediaFor(videoId, `${videoId}v1.mp3`)).toBe(false);
    expect(isCachedMediaFor(videoId, `${videoId}X.mp4`)).toBe(false);
    expect(isCachedMediaFor(videoId, 'otherId.mp4')).toBe(false);
  });
});
