import { Task } from "./pipeline.js";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import cp from "child_process";
import { promisify } from "util";
import { ffmpegPath } from '../lib/ffmpegPath.js';
import { YtDlp, type FormatOptions, type VideoProgress } from "ytdlp-nodejs";
import { getMediaDurationSeconds } from "./utils/mediaOperations.js";

dotenv.config();

const DEFAULT_VIDEO_QUALITY = "1080";
const YTDLP_BIN_PATH = process.env.YTDLP_BIN_PATH;

/**
 * A single raw video download attempt (no retry, no audio processing). Wrapped by
 * `downloadYTV` in `downloadUntilComplete`, which verifies completeness on the raw file —
 * so the expensive loudnorm/extract passes only run once, after the download is confirmed
 * complete.
 */
const downloadVideoOnce = async (youtubeUrl: string, onProgress: ProgressFn): Promise<RawVideo> => {
    const outputDir = process.env.DATA_DIR || "./data";
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
        console.log(`Created output directory: ${outputDir}`);
    }

    const { videoId, videoUrl, sourceType, usesYtDlp } = getVideoIdAndUrl(youtubeUrl);
    console.log(`Processing ${sourceType}: ${youtubeUrl}`);

    const videoOutputPath = path.join(outputDir, `${videoId}.mp4`);
    let finalVideoPath = videoOutputPath;

    // Check if video already exists and is valid
    if (fs.existsSync(videoOutputPath)) {
        const existingSize = fs.statSync(videoOutputPath).size;
        if (existingSize > 0) {
            console.log(`Using existing video file: ${formatBytes(existingSize)} -> ${path.basename(videoOutputPath)}`);
            finalVideoPath = videoOutputPath;
        } else {
            // Remove empty file and continue with download
            console.log(`Removing empty existing file and retrying download`);
            fs.unlinkSync(videoOutputPath);
        }
    }

    // Only download if we don't have a valid existing file
    const needsDownload = !fs.existsSync(videoOutputPath);

    if (needsDownload && usesYtDlp) {
        finalVideoPath = await downloadWithYtDlp(youtubeUrl, videoOutputPath, videoId, onProgress);
    } else if (needsDownload) {
        await downloadUrl(videoUrl, videoOutputPath);
        finalVideoPath = videoOutputPath;
    }

    const videoSize = fs.statSync(finalVideoPath).size;
    if (videoSize === 0) {
        throw new Error(`Download failed: video file is empty (0 bytes). URL: ${finalVideoPath}`);
    }

    console.log(`Video downloaded successfully: ${formatBytes(videoSize)}`);
    return { combined: finalVideoPath, sourceType };
}

type ProgressFn = (stage: string, progressPercent: number) => void;

/** A downloaded raw video file, before audio normalization/extraction. */
export interface RawVideo {
    combined: string;
    sourceType: string;
}

export interface DownloadedMedia {
    audioOnly: string;
    combined: string;
    sourceType: string;
}

/** What the source reports about a video, fetched independently of any download. */
export interface VideoInfo {
    /** yt-dlp `live_status` (e.g. `post_live`, `was_live`). Logged for data-gathering, never gated on. */
    liveStatus?: string;
    /**
     * The video's own reported duration, in seconds — the "M" that a downloaded file's
     * measured duration is verified against to detect a partial download of a
     * still-processing livestream VOD. Undefined when the source doesn't report one.
     */
    durationSec?: number;
}

export interface CompleteDownloadDeps {
    /** One raw video download attempt (no audio processing). */
    download: (url: string, onProgress: ProgressFn) => Promise<RawVideo>;
    /** The video's reported duration and live status; `{}` when the source reports nothing. */
    getInfo: (url: string) => Promise<VideoInfo>;
    /** Measured duration of a downloaded media file (ffprobe), in seconds. */
    probeDurationSeconds: (file: string) => Promise<number>;
    /** Removes any cached media for the url so the next attempt re-downloads fresh. */
    dropCachedMedia: (url: string) => void | Promise<void>;
    /** Bytes currently on disk for the url's download — heartbeat/speed data, works in every downloader mode. */
    downloadedBytes: (url: string) => number | Promise<number>;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
}

export interface CompleteDownloadConfig {
    maxWaitMs: number;
    pollIntervalMs: number;
    completenessRatio: number;
    minShortfallSeconds: number;
}

/**
 * A downloaded recording is complete when its measured duration is within tolerance of the
 * video's own reported duration. Absent an expected duration (sources that don't report
 * one), there's nothing to verify, so accept it.
 */
function isComplete(actualSeconds: number, expectedSeconds: number | undefined, config: CompleteDownloadConfig): boolean {
    if (expectedSeconds === undefined || expectedSeconds <= 0) return true;
    return actualSeconds >= expectedSeconds * config.completenessRatio
        || (expectedSeconds - actualSeconds) <= config.minShortfallSeconds;
}

/**
 * Downloads a recording, retrying while it comes back incomplete. Right after a YouTube
 * livestream ends its VOD is still processing, so a download can be truncated (or fail
 * outright); we compare the downloaded duration against the video's own reported duration
 * and retry — dropping the partial each time — until it's complete or we hit maxWait.
 */
export async function downloadUntilComplete(
    url: string,
    deps: CompleteDownloadDeps,
    config: CompleteDownloadConfig,
    onProgress: ProgressFn,
): Promise<RawVideo> {
    const start = deps.now();
    const deadline = start + config.maxWaitMs;
    const elapsedMin = () => ((deps.now() - start) / 60_000).toFixed(1);
    let attempt = 0;
    let lastReason = "";
    let lastLiveStatus: string | undefined;
    let lastKnownDurationSec: number | undefined;

    // live_status is recorded for data-gathering only (how long post_live throttling lasts
    // across real meetings — the input for deciding any future wait/optimization), never
    // gated on: post_live is sticky and unpredictable. M is remembered across fetches so a
    // metadata hiccup (observed live: YouTube's "sign in to confirm you're not a bot" wave)
    // can't silently disable the completeness check — a stale M only over-reports, so the
    // error direction is a harmless extra retry.
    const noteLiveStatus = (info: VideoInfo) => {
        if (info.durationSec !== undefined) lastKnownDurationSec = info.durationSec;
        if (info.liveStatus && info.liveStatus !== lastLiveStatus) {
            console.log(`[download-complete] ${url}: live_status=${info.liveStatus}` +
                (lastLiveStatus ? ` (was ${lastLiveStatus}, transitioned by ${elapsedMin()}min)` : ''));
            lastLiveStatus = info.liveStatus;
        }
    };

    // A per-attempt timeline in the task-server log (journal) is the main forensic trail:
    // it shows the convergence (D vs M) and timing even when no one is watching live.
    console.log(`[download-complete] ${url}: waiting up to ${Math.round(config.maxWaitMs / 60_000)}min for a complete recording ` +
        `(poll ${Math.round(config.pollIntervalMs / 1000)}s, ratio ${config.completenessRatio}, floor ${config.minShortfallSeconds}s)`);

    while (true) {
        attempt++;
        // Fetched fresh each attempt: M over-reports while the VOD is still processing and
        // shrinks toward the true length.
        const info = await Promise.resolve(deps.getInfo(url)).catch((err): VideoInfo => {
            console.warn(`[download-complete] ${url}: could not fetch video info (${(err as Error).message})` +
                (lastKnownDurationSec === undefined ? ' — completeness check skipped this attempt' : ` — using last known duration ${Math.round(lastKnownDurationSec)}s`));
            return {};
        });
        noteLiveStatus(info);
        // One throttled download can span the entire post_live window in a single attempt,
        // which would leave the flip time unobserved. Sample live_status at the poll cadence
        // DURING the download on a plain timer — the DVR/fragmented downloader for a
        // post_live VOD emits almost no progress callbacks (observed in the wild), so
        // sampling must not depend on ticks. Also refreshes M mid-download. unref keeps
        // the pending timer from holding the process open after the task finishes.
        let sampleInFlight = false;
        const sampler = setInterval(() => {
            if (sampleInFlight) return;
            sampleInFlight = true;
            (async () => {
                const bytes = await Promise.resolve(deps.downloadedBytes(url)).catch(() => 0);
                const statusBefore = lastLiveStatus;
                try {
                    noteLiveStatus(await deps.getInfo(url));
                    // A heartbeat when nothing changed makes "no flip" derivable from the log:
                    // absence of a transition line only proves anything if the log also shows
                    // the sampler was alive. Doubles as a byte curve (yt-dlp's own progress
                    // totals are garbage for a still-processing VOD's fragmented download).
                    if (lastLiveStatus === statusBefore) {
                        console.log(`[download-complete] ${url}: still ${lastLiveStatus ?? 'downloading'} at ${elapsedMin()}min — ${formatBytes(bytes)} downloaded`);
                    }
                } catch (err) {
                    console.warn(`[download-complete] ${url}: live_status check failed at ${elapsedMin()}min (${(err as Error).message}) — ${formatBytes(bytes)} downloaded`);
                }
            })().finally(() => { sampleInFlight = false; });
        }, config.pollIntervalMs);
        sampler.unref?.();
        try {
            const result = await deps.download(url, onProgress);
            const expected = lastKnownDurationSec;
            if (expected === undefined) {
                // Nothing to verify against — don't probe at all: a valid recording whose
                // container reports no duration must not fail the task (pre-retry behavior).
                console.log(`[download-complete] ${url}: accepted on attempt ${attempt} after ${elapsedMin()}min (no reported duration to verify against)`);
                return result;
            }
            const actual = await deps.probeDurationSeconds(result.combined);
            if (isComplete(actual, expected, config)) {
                console.log(`[download-complete] ${url}: complete on attempt ${attempt} after ${elapsedMin()}min ` +
                    `(got ${Math.round(actual)}s of ~${Math.round(expected)}s)`);
                return result;
            }
            lastReason = `incomplete recording: got ${Math.round(actual)}s of ~${Math.round(expected)}s` +
                ` (${Math.round((actual / expected) * 100)}%)`;
        } catch (err) {
            // A still-processing VOD can make yt-dlp fail outright — treat it the same as an
            // incomplete download: wait and retry rather than failing the whole task. But only
            // a yt-dlp source (YouTube/Facebook VOD) has a post-live processing window:
            // CDN/direct failures and permanently-gone videos would just burn the full wait,
            // so those fail fast with the original error.
            if (!getVideoIdAndUrl(url).usesYtDlp || isPermanentDownloadError(err)) throw err;
            lastReason = `download failed (VOD may still be processing): ${(err as Error).message}`;
        } finally {
            clearInterval(sampler);
        }

        console.warn(`[download-complete] ${url}: attempt ${attempt} at ${elapsedMin()}min — ${lastReason}`);
        // Drop any partial so the next attempt re-downloads instead of reusing it.
        await deps.dropCachedMedia(url);

        if (deps.now() + config.pollIntervalMs >= deadline) break;
        // Progress reflects how far into the wait we are (surfaces in the TaskStatus stage/percent).
        const waitProgress = Math.min(99, Math.round(((deps.now() - start) / config.maxWaitMs) * 100));
        onProgress("waiting-for-vod", waitProgress);
        await deps.sleep(config.pollIntervalMs);
    }

    throw new Error(
        `Livestream VOD not downloadable within ${Math.round(config.maxWaitMs / 60_000)}min ` +
        `(${attempt} attempts over ${elapsedMin()}min) — ${lastReason}. ` +
        `The recording likely hadn't finished processing at the source.`,
    );
}

const execFileAsync = promisify(cp.execFile);

// Errors that no amount of waiting can fix — retrying would burn the whole maxWait.
// Deliberately narrow: transient conditions (bot-check walls, network blips, 403s
// during processing) must stay retryable. Facebook's "The video is not available,
// Facebook said: ..." wrapper is deliberately NOT matched: yt-dlp emits it for ANY
// interstitial page, including the transient one served while a post-live VOD is
// still processing. The login wall (raise_login_required default message) is safe
// to match — it only fires on a real login form in the page, never on bot-checks.
const PERMANENT_DOWNLOAD_ERROR = /video unavailable|private video|has been removed|only available for registered users/i;

function isPermanentDownloadError(err: unknown): boolean {
    return PERMANENT_DOWNLOAD_ERROR.test((err as Error)?.message ?? '');
}

/** Parses the `--print "%(live_status)s|%(duration)s"` output line into a VideoInfo. */
export function parseVideoInfoOutput(stdout: string): VideoInfo {
    const [liveStatus, durationRaw] = (stdout.trim().split('\n').pop() ?? '').split('|');
    const duration = Number(durationRaw);
    return {
        liveStatus: liveStatus && liveStatus !== 'NA' ? liveStatus : undefined,
        durationSec: Number.isFinite(duration) && duration > 0 ? duration : undefined,
    };
}

/**
 * Fetches the video's reported live_status and duration via `yt-dlp --print` — a few bytes,
 * vs a --write-info-json sidecar that runs to tens of MB for a multi-hour VOD (and
 * --dump-single-json, which overflows the exec output buffer). Sources not handled by yt-dlp
 * report nothing → `{}` → the first download is accepted without a completeness check.
 * Facebook reports `duration`; `live_status` may print `NA`, which `parseVideoInfoOutput`
 * already maps to `undefined`.
 */
async function getInfo(url: string): Promise<VideoInfo> {
    if (!getVideoIdAndUrl(url).usesYtDlp) return {};

    // --no-playlist: a watch URL carrying &list= would otherwise print one line per playlist
    // entry, and the fetch would enumerate the whole playlist on every attempt.
    const args = ['--print', '%(live_status)s|%(duration)s', '--no-warnings', '--no-playlist'];
    // Same proxy as the download itself: the metadata fetch is throttled/blocked on the
    // datacenter IP just like the media fetch.
    const proxy = process.env.YTDLP_PROXY || process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
    if (proxy) {
        args.push('--proxy', proxy);
    }
    args.push(url);

    // Without a timeout a hung fetch (proxy blackhole) would stall the attempt loop forever
    // and wedge the sampler's in-flight guard.
    try {
        const { stdout } = await execFileAsync(YTDLP_BIN_PATH || 'yt-dlp', args, { timeout: 60_000 });
        return parseVideoInfoOutput(stdout);
    } catch (err) {
        // execFile errors embed the full argv; the proxy value may carry credentials and the
        // message gets logged by the callers, so redact it (mutate, don't wrap — the original
        // error object stays intact for anything that inspects it).
        if (proxy && err instanceof Error) err.message = err.message.split(proxy).join('<proxy>');
        throw err;
    }
}

/**
 * Removes ALL cached files for the video — the final mp4/mp3 AND yt-dlp's intermediates
 * (`.part`, `.ytdl`, per-format `.fNNN.*`) — so the next attempt re-downloads fresh against
 * the current manifest instead of resuming a stale/partial one (resume behaviour after a
 * manifestless→manifest transition is not something we want to rely on).
 */
function dropCachedMedia(youtubeUrl: string): void {
    const outputDir = process.env.DATA_DIR || "./data";
    const { videoId } = getVideoIdAndUrl(youtubeUrl);
    if (!fs.existsSync(outputDir)) return;
    for (const name of fs.readdirSync(outputDir)) {
        if (name === videoId || name.startsWith(`${videoId}.`)) {
            const file = path.join(outputDir, name);
            try { fs.unlinkSync(file); } catch (err) { console.warn(`Failed to remove ${file}:`, err); }
        }
    }
}

/** Total bytes on disk for the video's files (final mp4 plus yt-dlp intermediates). */
function downloadedBytes(youtubeUrl: string): number {
    const outputDir = process.env.DATA_DIR || "./data";
    const { videoId } = getVideoIdAndUrl(youtubeUrl);
    if (!fs.existsSync(outputDir)) return 0;
    let total = 0;
    for (const name of fs.readdirSync(outputDir)) {
        if (name === videoId || name.startsWith(`${videoId}.`)) {
            try { total += fs.statSync(path.join(outputDir, name)).size; } catch { /* file may vanish mid-scan */ }
        }
    }
    return total;
}

function envNumber(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function completeDownloadConfig(): CompleteDownloadConfig {
    return {
        // A just-ended livestream's VOD usually finishes processing within ~15-30 min, but
        // long/high-res streams can take longer; cap the wait and tune via env as needed.
        maxWaitMs: envNumber('LIVESTREAM_DOWNLOAD_MAX_WAIT_MS', 90 * 60_000),
        pollIntervalMs: envNumber('LIVESTREAM_DOWNLOAD_POLL_MS', 3 * 60_000),
        completenessRatio: envNumber('LIVESTREAM_DOWNLOAD_COMPLETENESS_RATIO', 0.98),
        minShortfallSeconds: envNumber('LIVESTREAM_DOWNLOAD_MIN_SHORTFALL_SEC', 120),
    };
}

/**
 * Downloads a YouTube/Facebook (or CDN/direct) recording, retrying while it comes back incomplete —
 * a just-ended livestream VOD is still processing and can download truncated. Audio
 * normalization/extraction runs once, only after a download is confirmed complete. Same
 * signature as a plain single download, so all callers (pipeline, CLI) are unchanged.
 */
export const downloadYTV: Task<string, DownloadedMedia> = async (youtubeUrl, onProgress) => {
    const { combined, sourceType } = await downloadUntilComplete(
        youtubeUrl,
        {
            download: downloadVideoOnce,
            getInfo,
            probeDurationSeconds: getMediaDurationSeconds,
            dropCachedMedia,
            downloadedBytes,
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            now: () => Date.now(),
        },
        completeDownloadConfig(),
        onProgress,
    );

    const audioOnly = path.join(path.dirname(combined), `${path.basename(combined, path.extname(combined))}.mp3`);
    await normalizeVideoAudio(combined);
    await extractSoundFromMP4(combined, audioOnly);
    return { audioOnly, combined, sourceType };
};

const randomId = () => Math.random().toString(36).substring(2, 15);

const facebookHost = (mediaUrl: string): string | undefined => {
    try {
        const host = new URL(mediaUrl).hostname;
        return host === 'fb.watch' || host === 'facebook.com' || host === 'fb.com'
            || host.endsWith('.facebook.com') || host.endsWith('.fb.com') ? host : undefined;
    } catch {
        return undefined;
    }
};

const extractFacebookVideoId = (url: URL, host: string): string | undefined => {
    if (host === 'fb.watch') {
        const seg = url.pathname.split('/').filter(Boolean)[0];
        // Validate the share code — an unexpected path segment would produce a bad filename.
        return seg && /^[\w-]+$/.test(seg) ? seg : undefined;
    }
    // watch/?v=<id> and video.php?v=<id>
    const v = url.searchParams.get('v');
    if (v && /^\d+$/.test(v)) return v;
    // /share/v/<code>, /share/r/<code> — opaque share codes (yt-dlp follows Facebook's
    // redirect to the canonical video URL), stable enough to serve as cache keys
    const share = url.pathname.match(/\/share\/[vr]\/([\w-]+)/);
    if (share) return share[1];
    // /<page>/videos/<id>, /<page>/videos/<title-slug>/<id>/, /reel/<id>
    return url.pathname.match(/\/(?:videos|reel)\/(?:[^/]+\/)?(\d+)(?=\/|$)/)?.[1];
};

export const getVideoIdAndUrl = (mediaUrl: string) => {
    if (mediaUrl.includes("youtube.com") || mediaUrl.includes("youtu.be")) {
        // Extract video ID from various YouTube URL formats
        let videoId: string | undefined;

        if (mediaUrl.includes("youtube.com/watch")) {
            const urlParams = new URL(mediaUrl).searchParams;
            videoId = urlParams.get('v') || undefined;
        } else if (mediaUrl.includes("youtu.be/")) {
            videoId = mediaUrl.split("youtu.be/")[1]?.split(/[?&#/]/)[0];
        } else if (mediaUrl.includes("youtube.com/embed/")) {
            videoId = mediaUrl.split("youtube.com/embed/")[1]?.split(/[?&#/]/)[0];
        }

        if (!videoId || videoId.length === 0) {
            throw new Error(`Could not extract video ID from YouTube URL: ${mediaUrl}`);
        }

        return { videoId, videoUrl: mediaUrl, sourceType: 'YouTube', usesYtDlp: true };
    }

    const fbHost = facebookHost(mediaUrl);
    if (fbHost) {
        const fbId = extractFacebookVideoId(new URL(mediaUrl), fbHost);
        if (!fbId) {
            throw new Error(`Could not extract video ID from Facebook URL: ${mediaUrl}`);
        }
        // fb- prefix namespaces the data-dir cache; dropCachedMedia/downloadedBytes prefix-match on videoId.
        return { videoId: `fb-${fbId}`, videoUrl: mediaUrl, sourceType: 'Facebook', usesYtDlp: true };
    }

    // Check if it's from our CDN
    const cdnBaseUrl = process.env.CDN_BASE_URL;
    if (cdnBaseUrl && mediaUrl.startsWith(cdnBaseUrl)) {
        const fileName = path.basename(mediaUrl, path.extname(mediaUrl));
        return { videoId: fileName, videoUrl: mediaUrl, sourceType: 'CDN', usesYtDlp: false };
    }

    return { videoId: randomId(), videoUrl: mediaUrl, sourceType: 'Direct URL', usesYtDlp: false };
}
type LoudnormStats = {
    input_i: string;
    input_tp: string;
    input_lra: string;
    input_thresh: string;
};

const LOUDNORM_TARGET = { I: -14, TP: -1.5, LRA: 11 };
// Within this distance of the integrated-loudness target, the correction is
// too small to justify re-encoding the audio and re-muxing the whole file.
// Files we already normalized measure at the target, so reprocessing a cached
// video skips the expensive pass entirely.
const LOUDNORM_TOLERANCE_LU = 1;
const AUDIO_BITRATE = '128k';

export function needsLoudnormCorrection(stats: LoudnormStats): boolean {
    const deltaI = Math.abs(LOUDNORM_TARGET.I - parseFloat(stats.input_i));
    // Non-finite measurements (ffmpeg emits "-inf" on silent audio) fall
    // through to normalization, preserving the old always-normalize behavior
    if (!Number.isFinite(deltaI)) {
        return true;
    }
    // Only loudness deviation triggers normalization. True peak deliberately
    // does NOT: the AAC re-encode in pass 2 overshoots the true-peak limiter
    // (observed in production: TP went +0.69 → +1.98 dBTP through one
    // normalize cycle while loudness stayed on target), so a TP-only trigger
    // re-normalizes the same file on every rerun, degrading audio each time
    // and never converging.
    return deltaI > LOUDNORM_TOLERANCE_LU;
}

export function parseLoudnormStats(stderr: string): LoudnormStats {
    // ffmpeg's loudnorm filter outputs a JSON block at the end of stderr
    const jsonMatch = stderr.match(/\{[^{}]*"input_i"\s*:\s*"[^"]*"[^{}]*\}/s);
    if (!jsonMatch) {
        throw new Error('Could not find loudnorm JSON in ffmpeg output');
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const required = ['input_i', 'input_tp', 'input_lra', 'input_thresh'] as const;
    for (const key of required) {
        if (typeof parsed[key] !== 'string') {
            throw new Error(`Missing loudnorm field: ${key}`);
        }
    }

    return {
        input_i: parsed.input_i,
        input_tp: parsed.input_tp,
        input_lra: parsed.input_lra,
        input_thresh: parsed.input_thresh,
    };
}

function runFfmpeg(args: string[]): Promise<{ stderr: string }> {
    const ffmpegBin = ffmpegPath();
    return new Promise((resolve, reject) => {
        const proc = cp.spawn(ffmpegBin, args, {
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stderr = '';
        proc.stderr.on('data', (data) => { stderr += data.toString(); });

        proc.on('close', (code) => {
            if (code === 0) resolve({ stderr });
            else reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-500)}`));
        });
        proc.on('error', reject);
    });
}

async function normalizeVideoAudio(filePath: string): Promise<void> {
    const { I, TP, LRA } = LOUDNORM_TARGET;
    const loudnormFilter = `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}`;
    const filename = path.basename(filePath);

    // Pass 1: measure loudness. Input-side -vn keeps ffmpeg from decoding
    // the video stream, which would otherwise dominate the runtime of a
    // measurement that only reads audio (~35 minutes of video decode for a
    // 6.5h meeting).
    console.log(`[loudnorm] ${filename}: measuring loudness...`);
    const pass1Start = Date.now();
    const { stderr } = await runFfmpeg([
        '-vn',
        '-i', filePath,
        '-af', `${loudnormFilter}:print_format=json`,
        '-f', 'null', '-',
    ]);
    const pass1Duration = ((Date.now() - pass1Start) / 1000).toFixed(1);

    const stats = parseLoudnormStats(stderr);
    const deltaI = (I - parseFloat(stats.input_i)).toFixed(1);
    console.log(`[loudnorm] ${filename}: I=${stats.input_i} LUFS (target ${I}, Δ${parseFloat(deltaI) >= 0 ? '+' : ''}${deltaI}) | TP=${stats.input_tp} dBTP (ceiling ${TP}) | LRA=${stats.input_lra} (target ${LRA}) | thresh=${stats.input_thresh} | measure=${pass1Duration}s`);

    if (!needsLoudnormCorrection(stats)) {
        console.log(`[loudnorm] ${filename}: within ${LOUDNORM_TOLERANCE_LU} LU of the ${I} LUFS target, skipping normalization`);
        return;
    }

    // Pass 2: apply normalization with linear mode
    const tempPath = filePath + '.normalized.mp4';
    const pass2Start = Date.now();
    await runFfmpeg([
        '-i', filePath,
        '-c:v', 'copy',
        '-af', `${loudnormFilter}:measured_I=${stats.input_i}:measured_TP=${stats.input_tp}:measured_LRA=${stats.input_lra}:measured_thresh=${stats.input_thresh}:linear=true`,
        '-c:a', 'aac', '-b:a', AUDIO_BITRATE,
        '-y', tempPath,
    ]);
    const pass2Duration = ((Date.now() - pass2Start) / 1000).toFixed(1);

    // Replace original with normalized version
    fs.renameSync(tempPath, filePath);
    console.log(`[loudnorm] ${filename}: normalize=${pass2Duration}s, total=${((Date.now() - pass1Start) / 1000).toFixed(1)}s`);
}

const FREQUENCY_FILTER = true;
const extractSoundFromMP4 = async (inputPath: string, outputPath: string): Promise<void> => {
    // Validate input file exists and is not empty
    if (!fs.existsSync(inputPath)) {
        throw new Error(`Input file does not exist: ${inputPath}`);
    }
    
    const inputSize = fs.statSync(inputPath).size;
    if (inputSize === 0) {
        throw new Error(`Input file is empty (0 bytes): ${inputPath}`);
    }
    
    console.log(`Extracting audio from: ${path.basename(inputPath)} (${formatBytes(inputSize)})`);
    
    const args = [
        '-i', inputPath,
        '-vn',  // No video
        '-ac', '1', // Convert to mono
        '-acodec', 'libmp3lame',
        '-b:a', '128k',
        '-y',  // Overwrite output file if it exists
        outputPath
    ];

    if (FREQUENCY_FILTER) {
        args.splice(args.length - 1, 0, '-af', 'highpass=f=200, lowpass=f=3000');
    }

    const ffmpegBin = ffmpegPath();

    console.log(`Executing ffmpeg command: ${ffmpegBin} ${args.join(' ')}`);

    return new Promise<void>((resolve, reject) => {
        const ffmpegProcess = cp.spawn(ffmpegBin, args, {
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let stdoutData = '';
        let stderrData = '';

        ffmpegProcess.stdout.on('data', (data) => {
            stdoutData += data.toString();
        });

        ffmpegProcess.stderr.on('data', (data) => {
            stderrData += data.toString();
        });

        ffmpegProcess.on('close', (code) => {
            if (code === 0) {
                const audioSize = fs.statSync(outputPath).size;
                console.log(`Extracted audio: ${formatBytes(audioSize)} -> ${path.basename(outputPath)}`);
                resolve();
            } else {
                console.error(`FFmpeg process failed with code ${code}`);
                console.error(`FFmpeg stdout: ${stdoutData}`);
                console.error(`FFmpeg stderr: ${stderrData}`);
                reject(new Error(`FFmpeg process exited with code ${code}`));
            }
        });

        ffmpegProcess.on('error', (err) => {
            console.error(`FFmpeg process error: ${err.message}`);
            reject(err);
        });
    });
}


const HEADERS = {
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "accept-encoding": "gzip, deflate, br, zstd",
    "accept-language": "en-US,en;q=0.7",
    "sec-ch-ua": "\"Brave\";v=\"129\", \"Not=A?Brand\";v=\"8\", \"Chromium\";v=\"129\"",
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": "\"macOS\"",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
    "sec-gpc": "1",
    "upgrade-insecure-requests": "1",
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"
}


const downloadUrl = async (url: string, outputPath: string) => {
    console.log(`Downloading from: ${url}`);
    
    let writer: fs.WriteStream | null = null;
    
    try {
        const response = await fetch(url, { headers: HEADERS });
        
        if (!response.ok) {
            const responseText = await response.text().catch(() => 'Unable to read response');
            const truncatedResponse = responseText.length > 200 ? `${responseText.substring(0, 200)}...` : responseText;
            throw new Error(`HTTP error getting ${url}: status: ${response.status} ${response.statusText}. Response: ${truncatedResponse}`);
        }

        // Check for file size from response headers
        const contentLength = response.headers.get('content-length');
        const estimatedLength = response.headers.get('estimated-content-length');
        
        if (contentLength) {
            console.log(`Expected file size: ${formatBytes(parseInt(contentLength))}`);
        } else if (estimatedLength) {
            console.log(`Estimated file size: ${formatBytes(parseInt(estimatedLength))}`);
        }

        writer = fs.createWriteStream(outputPath);
        // Attach error handler immediately so disk errors during writes are caught
        const writeCompletion = new Promise<void>((resolve, reject) => {
            writer!.once('finish', resolve);
            writer!.once('error', (err) => {
                reject(new Error(`Error writing file: ${err.message}`));
            });
        });
        // Prevent unhandled rejection if the stream errors before we await it
        writeCompletion.catch(() => {});
        const reader = response.body?.getReader();

        if (!reader) {
            throw new Error("Unable to read response body - response.body is null");
        }

        let totalBytes = 0;
        let lastLogTime = Date.now();

        while (true) {
            const { done, value } = await reader.read();

            if (done) {
                break;
            }

            if (!value || value.length === 0) {
                console.warn(`Warning: Received empty chunk during download`);
                continue;
            }

            writer.write(Buffer.from(value));
            totalBytes += value.length;

            const currentTime = Date.now();
            if (currentTime - lastLogTime >= 5000) {
                console.log(`  Downloading... ${formatBytes(totalBytes)}`);
                lastLogTime = currentTime;
            }
        }

        writer.end();
        
        // Wait for file to be fully written (with timeout)
        await Promise.race([
            writeCompletion,
            new Promise<void>((_, reject) =>
                setTimeout(() => reject(new Error('Write stream timeout after 30 seconds')), 30000)
            )
        ]);
        
        const finalSize = fs.statSync(outputPath).size;
        console.log(`Downloaded video: ${formatBytes(finalSize)} -> ${path.basename(outputPath)}`);
        
        if (finalSize === 0) {
            throw new Error(`Post-download validation failed: file is empty (0 bytes). URL: ${url}`);
        }
    } catch (error) {
        // Close the writer stream if it was created
        if (writer) {
            writer.destroy();
        }
        
        // Clean up empty file on error
        if (fs.existsSync(outputPath)) {
            const size = fs.statSync(outputPath).size;
            if (size === 0) {
                fs.unlinkSync(outputPath);
            }
        }
        throw error;
    }
}

export function formatBytes(bytes: number): string {
    if (bytes < 1024) return bytes + " B";
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

let lastYtDlpUpdateCheck = 0;

async function updateYtDlp(): Promise<void> {
    // The retry loop calls the downloader once per attempt; re-checking for a yt-dlp
    // update on each of up to ~30 attempts adds a network round-trip (up to 60s) per
    // retry for nothing. Once an hour is plenty.
    if (Date.now() - lastYtDlpUpdateCheck < 60 * 60_000) return;
    lastYtDlpUpdateCheck = Date.now();

    const binaryPath = YTDLP_BIN_PATH || 'yt-dlp';
    console.log('Checking for yt-dlp updates...');

    return new Promise((resolve) => {
        const updateProcess = cp.spawn(binaryPath, ['--update-to', 'nightly'], {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';

        updateProcess.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        updateProcess.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        updateProcess.on('close', (code) => {
            clearTimeout(killTimer);
            if (code === 0) {
                // Check if actually updated or already up-to-date
                if (stdout.includes('Updating to') || stdout.includes('Updated yt-dlp')) {
                    console.log('yt-dlp updated successfully');
                } else {
                    console.log('yt-dlp is up to date');
                }
            } else {
                // Log but don't fail - we can still try with existing version
                console.warn(`yt-dlp update check failed (code ${code}): ${stderr || stdout}`);
            }
            resolve();
        });

        updateProcess.on('error', (err) => {
            console.warn(`yt-dlp update check error: ${err.message}`);
            resolve();
        });

        // Timeout after 60 seconds (nightly binary download can be slow)
        const killTimer = setTimeout(() => {
            updateProcess.kill();
            console.warn('yt-dlp update check timed out');
            resolve();
        }, 60000);
    });
}

async function downloadWithYtDlp(
    youtubeUrl: string,
    outputPath: string,
    videoId: string,
    onProgress?: (...args: any[]) => void
) {
    // Try to update yt-dlp before downloading
    await updateYtDlp();

    const ytdlp = new YtDlp({
        binaryPath: YTDLP_BIN_PATH || undefined,
        // we still rely on ffmpeg-static for audio extraction; yt-dlp uses system ffmpeg only if needed
    });

    const proxy = process.env.YTDLP_PROXY || process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
    const outputDir = path.dirname(outputPath);
    const baseName = path.basename(outputPath, path.extname(outputPath));
    const outputTemplate = path.join(outputDir, `${baseName}.%(ext)s`);

    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    // Log a progress snapshot at most every 15s. yt-dlp fires this callback ~10×/s, and a raw
    // per-tick write floods the (non-TTY) container/app logs — thousands of lines that rotate out
    // our meaningful ones. A carriage-return progress bar only works in a TTY, so we snapshot instead.
    let lastProgressLog = 0;
    const ytOptions: FormatOptions<'videoonly'> = {
        output: outputTemplate,
        format: `bestvideo[height<=${DEFAULT_VIDEO_QUALITY}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${DEFAULT_VIDEO_QUALITY}][ext=mp4]/best`,
        onProgress: (p: VideoProgress) => {
            if (onProgress && p.total > 0) {
                const pct = (p.downloaded / p.total) * 100;
                const now = Date.now();
                if (now - lastProgressLog >= 15_000) {
                    lastProgressLog = now;
                    console.log(`[yt-dlp] ${videoId}: ${pct.toFixed(0)}% (${formatBytes(p.downloaded)} / ${formatBytes(p.total)})`);
                }
                // onProgress may throw TaskCancelledError (universal cancellation
                // checkpoint). Swallow it here: this callback runs inside a
                // stdout 'data' event handler and a synchronous throw would be an
                // uncaught exception. Cancellation takes effect at the next
                // stage-boundary checkpoint after downloadAsync resolves.
                try {
                    onProgress('yt-dlp', pct);
                } catch {
                    // intentionally swallowed — see comment above
                }
            }
        },
        // yt-dlp auto-detects Deno (provisioned via the image/flake) to solve YouTube's
        // JS challenge; no '--js-runtimes node' — node here is v20, below EJS's >= 22 floor.
        // --no-playlist: a watch URL carrying &list= would otherwise download every playlist
        // entry into this video's output template (same guard as getInfo).
        additionalOptions: ['--merge-output-format', 'mp4', '--no-playlist'],
    };

    // Use env proxy if available
    if (proxy) {
        ytOptions.proxy = proxy;
    }

    try {
        console.log(`Downloading via yt-dlp: ${youtubeUrl}`);
        await ytdlp.downloadAsync(youtubeUrl, ytOptions);

        const expectedPath = path.join(outputDir, `${baseName}.mp4`);
        if (!fs.existsSync(expectedPath)) {
            throw new Error(`yt-dlp reported success but expected mp4 file not found: ${expectedPath}`);
        }

        return expectedPath;
    } catch (err) {
        throw new Error(`yt-dlp download failed: ${(err as Error).message}`);
    }
}
