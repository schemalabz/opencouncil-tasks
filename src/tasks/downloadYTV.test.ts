import { describe, it, expect, vi } from 'vitest';
import {
  getVideoIdAndUrl, formatBytes, parseLoudnormStats, needsLoudnormCorrection,
  downloadUntilComplete, parseVideoInfoOutput,
  type CompleteDownloadDeps, type CompleteDownloadConfig, type RawVideo,
} from './downloadYTV.js';

describe('parseVideoInfoOutput', () => {
  it('parses live_status and duration from the --print line', () => {
    expect(parseVideoInfoOutput('was_live|537\n')).toEqual({ liveStatus: 'was_live', durationSec: 537 });
  });

  it('maps NA fields to undefined (a still-live stream has no duration)', () => {
    expect(parseVideoInfoOutput('is_live|NA')).toEqual({ liveStatus: 'is_live', durationSec: undefined });
  });

  it('uses the last line when yt-dlp prints extra output before the template', () => {
    expect(parseVideoInfoOutput('some stray warning\npost_live|19116')).toEqual({ liveStatus: 'post_live', durationSec: 19116 });
  });
});

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

  it('corrects when measurements are not parseable numbers', () => {
    expect(needsLoudnormCorrection(stats('-inf', '-inf'))).toBe(true);
  });
});

describe('downloadUntilComplete', () => {
  const CONFIG: CompleteDownloadConfig = {
    maxWaitMs: 90 * 60_000,
    pollIntervalMs: 3 * 60_000,
    completenessRatio: 0.98,
    minShortfallSeconds: 120,
  };

  const RAW: RawVideo = { combined: 'v.mp4', sourceType: 'YouTube' };

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
      sleep: clock.sleep,
      now: clock.now,
      ...overrides,
    };
  }

  it('returns the raw download immediately when it is already complete (D ≈ M)', async () => {
    const deps = makeDeps();

    const result = await downloadUntilComplete('https://youtu.be/x', deps, CONFIG, () => {});

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

    const result = await downloadUntilComplete('https://youtu.be/x', deps, CONFIG, () => {});

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

    const result = await downloadUntilComplete('https://youtu.be/x', deps, CONFIG, () => {});

    expect(result).toEqual(RAW);
    expect(deps.download).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-YouTube download errors (no processing window — fail fast like a plain download)', async () => {
    const download = vi.fn().mockRejectedValue(new Error('HTTP error getting url: status: 404 Not Found'));
    const deps = makeDeps({ download, getInfo: vi.fn().mockResolvedValue({}) });

    const err = await downloadUntilComplete('https://cdn.example.com/v.mp4', deps, CONFIG, () => {})
      .catch((e) => e as Error) as Error;

    expect(err.message).toContain('404');
    expect(download).toHaveBeenCalledTimes(1);
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it('fails fast on a permanently-gone YouTube video instead of burning the full wait', async () => {
    const download = vi.fn().mockRejectedValue(new Error('yt-dlp download failed: ERROR: [youtube] x: Video unavailable'));
    const deps = makeDeps({ download });

    const err = await downloadUntilComplete('https://youtu.be/x', deps, CONFIG, () => {})
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

    const result = await downloadUntilComplete('https://youtu.be/x', deps, CONFIG, () => {});

    expect(result).toEqual(RAW);
    expect(download).toHaveBeenCalledTimes(2);
    expect(deps.dropCachedMedia).toHaveBeenCalledTimes(1);
    expect(deps.sleep).toHaveBeenCalledTimes(1);
  });

  it('gives up with an informative error after the max wait', async () => {
    const deps = makeDeps({ probeDurationSeconds: vi.fn().mockResolvedValue(600) }); // never completes
    const onProgress = vi.fn();

    const err = await downloadUntilComplete('https://youtu.be/x', deps, CONFIG, onProgress)
      .catch((e) => e as Error) as Error;

    expect(err.message).toMatch(/not downloadable within \d+min/);
    expect(err.message).toContain('got 600s of ~7200s'); // the shortfall is surfaced
    expect((deps.download as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);
    // reported the wait to the caller (existing callback mechanism) rather than looking hung
    expect(onProgress).toHaveBeenCalledWith('waiting-for-vod', expect.any(Number));
  });

  it('accepts the first download when there is no reported duration (non-YouTube source)', async () => {
    const deps = makeDeps({
      download: vi.fn().mockResolvedValue({ combined: 'v.mp4', sourceType: 'CDN' }),
      getInfo: vi.fn().mockResolvedValue({}), // non-YouTube: nothing to verify against
      probeDurationSeconds: vi.fn().mockResolvedValue(123),
    });

    const result = await downloadUntilComplete('https://cdn.example.com/v.mp4', deps, CONFIG, () => {});

    expect(result.sourceType).toBe('CDN');
    expect(deps.download).toHaveBeenCalledTimes(1);
    expect(deps.sleep).not.toHaveBeenCalled();
    // With no M there is nothing to verify, so the file must not be probed at all —
    // a valid recording whose container reports no duration would otherwise fail the task.
    expect(deps.probeDurationSeconds).not.toHaveBeenCalled();
  });

  it('accepts the download when fetching video info fails (no M to verify against)', async () => {
    // A metadata fetch hiccup must not fail or stall an otherwise good download —
    // same behavior as sources with no reported duration.
    const deps = makeDeps({
      getInfo: vi.fn().mockRejectedValue(new Error('yt-dlp: network unreachable')),
      probeDurationSeconds: vi.fn().mockResolvedValue(600),
    });

    const result = await downloadUntilComplete('https://youtu.be/x', deps, CONFIG, () => {});

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

    const result = await downloadUntilComplete('https://youtu.be/x', deps, CONFIG, () => {});

    expect(result).toEqual(RAW);
    expect(deps.download).toHaveBeenCalledTimes(3); // attempt 2 was rejected, not accepted
  });

  it('accepts a download that is short only within the absolute tolerance (trimmed pre-roll / gaps)', async () => {
    const deps = makeDeps({
      getInfo: vi.fn().mockResolvedValue({ liveStatus: 'was_live', durationSec: 1000 }),
      probeDurationSeconds: vi.fn().mockResolvedValue(900), // 100s short, below the 120s floor
    });

    const result = await downloadUntilComplete('https://youtu.be/x', deps, CONFIG, () => {});

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

    await downloadUntilComplete('https://youtu.be/x', deps, CONFIG, () => {});

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

      const result = downloadUntilComplete('https://youtu.be/x', deps, CONFIG, () => {});
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

      const result = downloadUntilComplete('https://youtu.be/x', deps, CONFIG, () => {});
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

      const result = downloadUntilComplete('https://youtu.be/x', deps, CONFIG, () => {});
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

      await downloadUntilComplete('https://youtu.be/x', deps, CONFIG, () => {});

      const logged = logSpy.mock.calls.map((args) => args.join(' ')).join('\n');
      expect(logged).toContain('live_status=post_live');
      expect(logged).toContain('live_status=was_live');
    } finally {
      logSpy.mockRestore();
    }
  });
});
