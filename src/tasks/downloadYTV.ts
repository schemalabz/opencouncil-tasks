import { Task } from "./pipeline.js";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import cp from "child_process";
import { promisify } from "util";
import { randomUUID } from "crypto";
import { Readable } from "stream";
import { pipeline as streamPipeline } from "stream/promises";
import type { ReadableStream } from "stream/web";
import { ffmpegPath } from '../lib/ffmpegPath.js';
import { childEnv } from '../lib/childEnv.js';
import { assertFetchableUrl } from '../lib/fetchableUrl.js';
import { isCancellation } from '../lib/taskControl.js';
import { YtDlp, helpers as ytdlpHelpers, type FormatOptions, type VideoProgress } from "ytdlp-nodejs";
import { getMediaDurationSeconds, probeVideoTiming } from "./utils/mediaOperations.js";
import { isSpacesUrl } from "./utils/spacesUrl.js";
import {
    MEDIA_INFO_TEMPLATE, parseMediaInfo, isDirectFile, toSourceInfo, cacheKeyFor,
    classifyMediaError, isPermanentMediaError, mediaErrorMessage, MediaDownloadError, MediaHttpError, type MediaInfo,
} from "./utils/mediaSource.js";
import type { InspectMediaResponse, MediaSourceInfo } from "../types.js";

dotenv.config();

const DEFAULT_VIDEO_QUALITY = "1080";
const YTDLP_BIN_PATH = process.env.YTDLP_BIN_PATH;
// The binary downloads run: YTDLP_BIN_PATH, else the copy ytdlp-nodejs bundles. A bare
// `yt-dlp` from PATH would be a second binary, updated separately (and absent in the dev shell).
const ytdlpBinary = () => YTDLP_BIN_PATH || ytdlpHelpers.findYtdlpBinary() || 'yt-dlp';

/**
 * A single raw video download attempt (no retry, no audio processing). Wrapped by
 * `downloadYTV` in `downloadUntilComplete`, which verifies completeness on the raw file —
 * so the expensive loudnorm/extract passes only run once, after the download is confirmed
 * complete.
 */
const downloadVideoOnce = async (source: MediaSource, onProgress: ProgressFn): Promise<RawVideo> => {
    const outputDir = process.env.DATA_DIR || "./data";
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
        console.log(`Created output directory: ${outputDir}`);
    }

    const videoId = source.cacheKey();
    if (!videoId) {
        // Only a URL without an offline key gets here, after a lookup that failed in a way
        // that may pass (a network blip); the caller retries, and the lookup with it.
        throw new Error(`The media source is not resolved yet: ${source.lastLookupError ?? 'no lookup has succeeded'}`);
    }
    const usesYtDlp = source.kind() === 'yt-dlp';
    console.log(`Processing ${source.describe()}: ${source.url}`);

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
        finalVideoPath = await downloadWithYtDlp(source.url, videoOutputPath, videoId, onProgress);
    } else if (needsDownload) {
        await downloadUrl(source.url, videoOutputPath);
        finalVideoPath = videoOutputPath;
    }

    const videoSize = fs.statSync(finalVideoPath).size;
    if (videoSize === 0) {
        throw new Error(`Download failed: video file is empty (0 bytes). URL: ${finalVideoPath}`);
    }

    console.log(`Video downloaded successfully: ${formatBytes(videoSize)}`);
    return { combined: finalVideoPath };
}

type ProgressFn = (stage: string, progressPercent: number) => void;

/** A downloaded raw video file, before preparation (loudnorm, video start shift) and audio extraction. */
export interface RawVideo {
    combined: string;
}

export interface DownloadedMedia {
    audioOnly: string;
    combined: string;
    source: MediaSourceInfo;
    /** The file differs from the download (loudness normalized or video decode timestamps rebuilt), so a Spaces source must be overwritten. */
    mediaRewritten: boolean;
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
    /**
     * Whether a failed download attempt is worth retrying. Only a yt-dlp source has a
     * post-live processing window; a Spaces or file download fails the same way again.
     */
    isRetryable: (err: unknown) => boolean;
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
            // The lookup is where an unsupported page, an embed-only or DRM video shows up;
            // the download would only fail the same way, after the whole wait.
            if (isPermanentMediaError(err)) throw err;
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
            // incomplete download: wait and retry rather than failing the whole task.
            // Spaces/file failures and permanently-gone videos would just burn the full wait,
            // so those fail fast with the original error.
            if (!deps.isRetryable(err)) throw err;
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

/**
 * Asks yt-dlp what a URL is: the extractor that handles it, the video id, duration, live
 * status and the rest of MEDIA_INFO_TEMPLATE. yt-dlp's generic extractor also covers a
 * plain media file (`direct`) and a page embedding any player it knows. Throws yt-dlp's
 * error otherwise; `classifyMediaError` tells a permanent one from a passing one.
 */
async function lookupMedia(url: string): Promise<MediaInfo> {
    // --no-playlist: a watch URL carrying &list= would otherwise print one line per playlist
    // entry, and the fetch would enumerate the whole playlist on every attempt. A URL that is
    // only a playlist or channel still prints its entries: one is enough to see the playlist
    // id that parseMediaInfo refuses.
    const args = ['-O', MEDIA_INFO_TEMPLATE, '--no-warnings', '--no-playlist', '--playlist-items', '1'];
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
        const { stdout } = await withYtDlpBinary(() => execFileAsync(ytdlpBinary(), args, { timeout: 60_000 }));
        return parseMediaInfo(stdout);
    } catch (err) {
        // execFile errors embed the full argv; the proxy value may carry credentials and the
        // message gets logged by the callers, so redact it (mutate, don't wrap — the original
        // error object stays intact for anything that inspects it).
        if (proxy && err instanceof Error) err.message = err.message.split(proxy).join('<proxy>');
        throw err;
    }
}

/**
 * Whether a data-dir file belongs to this video: its media, yt-dlp's intermediates
 * (`.part`, `.ytdl`, per-format `.fNNN.*`), and the split audio derived from it.
 *
 * Deliberately not a bare `${videoId}_` prefix. A Spaces-sourced download takes its
 * videoId from the object basename, so `<id>_v1` is a sibling task's own media rather
 * than a variant of this video's, and matching it would delete another task's cache.
 * Only the splitter's `_segment_`/`_full_` outputs are ours to remove.
 */
export function isCachedMediaFor(videoId: string, fileName: string): boolean {
    return fileName === videoId
        || fileName.startsWith(`${videoId}.`)
        || fileName.startsWith(`${videoId}_segment_`)
        || fileName.startsWith(`${videoId}_full_`);
}

/**
 * One download's source. The URL alone settles Spaces, YouTube and Facebook (their cache
 * keys come from the URL, so a lookup failing while a post-live VOD processes still leaves
 * a key to retry under); anything else is resolved by its first successful lookup.
 */
class MediaSource {
    private readonly offline: OfflineSource | undefined;
    private info: MediaInfo | undefined;
    private key: string | undefined;
    lastLookupError: string | undefined;

    constructor(readonly url: string) {
        this.offline = offlineSource(url);
        this.key = this.offline?.cacheKey;
    }

    /** Looks the URL up again: duration and live status change while a VOD processes. */
    async lookup(): Promise<MediaInfo | undefined> {
        if (this.offline?.kind === 'spaces') return undefined;
        // A plain file does not change between attempts
        if (this.info && isDirectFile(this.info)) return this.info;
        try {
            this.info = await lookupMedia(this.url);
        } catch (err) {
            const { permanent, hint } = classifyMediaError(err);
            // A media file downloaded without yt-dlp before it was asked first: a lookup that
            // fails for any passing reason (yt-dlp broken or blocked) must not stop one now.
            if (!permanent && !this.offline) {
                const contentType = await mediaFileType(this.url);
                if (contentType) {
                    console.warn(`[media-source] ${this.url}: lookup failed (${mediaErrorMessage(err)}); it serves ${contentType}, downloading it as a file`);
                    this.info = { extractor: 'Generic', id: path.basename(new URL(this.url).pathname) || 'file', direct: true };
                    this.key ??= cacheKeyFor(this.info, this.url);
                    return this.info;
                }
            }
            // The task's error goes back to the app: yt-dlp's own words and what to do
            // instead, not the binary path and argv of the exec failure. Mutated, not
            // wrapped, so the ERROR line that classifyMediaError reads stays in place.
            this.lastLookupError = mediaErrorMessage(err);
            if (err instanceof Error) err.message = this.lastLookupError + (hint ? ` (${hint})` : '');
            throw err;
        }
        this.key ??= cacheKeyFor(this.info, this.url);
        return this.info;
    }

    /** Undefined until a lookup succeeds, for a URL the offline rules do not cover. */
    kind(): MediaSourceInfo['kind'] | undefined {
        if (this.offline?.kind === 'spaces') return 'spaces';
        if (this.info) return isDirectFile(this.info) ? 'file' : 'yt-dlp';
        return this.offline?.kind;
    }

    cacheKey(): string | undefined {
        return this.key;
    }

    isRetryable(err: unknown): boolean {
        const kind = this.kind();
        return kind !== 'spaces' && kind !== 'file' && !isPermanentMediaError(err);
    }

    describe(): string {
        return this.info?.extractor ?? this.offline?.sourceType ?? 'unresolved source';
    }

    sourceInfo(): MediaSourceInfo {
        if (this.info) return toSourceInfo(this.info);
        // Downloaded without a successful lookup: a Spaces object, or YouTube/Facebook while
        // their metadata fetch failed.
        return { kind: this.kind() ?? 'yt-dlp', extractor: this.offline?.extractor };
    }
}

/**
 * Removes ALL cached files for the video, so the next attempt re-downloads fresh against
 * the current manifest instead of resuming a stale/partial one (resume behaviour after a
 * manifestless→manifest transition is not something we want to rely on).
 */
function dropCachedMedia(videoId: string | undefined): void {
    const outputDir = process.env.DATA_DIR || "./data";
    if (!videoId || !fs.existsSync(outputDir)) return;
    for (const name of fs.readdirSync(outputDir)) {
        if (isCachedMediaFor(videoId, name)) {
            const file = path.join(outputDir, name);
            try { fs.unlinkSync(file); } catch (err) { console.warn(`Failed to remove ${file}:`, err); }
        }
    }
}

/**
 * Total bytes on disk for the video's files (final mp4 plus yt-dlp intermediates).
 * Narrower than isCachedMediaFor on purpose: this measures download progress for the
 * post_live heartbeat, and a previous run's split audio is already on disk at the first
 * attempt, so counting it would corrupt the byte curve.
 */
function downloadedBytes(videoId: string | undefined): number {
    const outputDir = process.env.DATA_DIR || "./data";
    if (!videoId || !fs.existsSync(outputDir)) return 0;
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
 * Downloads a recording from any source yt-dlp supports, a media file, or our Spaces
 * storage, retrying while it comes back incomplete — a just-ended livestream VOD is still
 * processing and can download truncated. Returns the raw media; downloadYTV prepares it
 * and extracts audio after completeness is confirmed. Also used by CLI source verification.
 */
export const downloadMedia: Task<string, RawVideo & { source: MediaSourceInfo }> = async (youtubeUrl, onProgress) => {
    let resolved: MediaSource | undefined;
    try {
        const source = new MediaSource(youtubeUrl);
        resolved = source;
        const { combined } = await downloadUntilComplete(
            youtubeUrl,
            {
                download: (_url, progress) => downloadVideoOnce(source, progress),
                getInfo: async () => {
                    const info = await source.lookup();
                    return info ? { liveStatus: info.liveStatus, durationSec: info.durationSec } : {};
                },
                probeDurationSeconds: getMediaDurationSeconds,
                dropCachedMedia: () => dropCachedMedia(source.cacheKey()),
                downloadedBytes: () => downloadedBytes(source.cacheKey()),
                isRetryable: (err) => source.isRetryable(err),
                sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
                now: () => Date.now(),
            },
            completeDownloadConfig(),
            onProgress,
        );

        return { combined, source: source.sourceInfo() };
    } catch (err) {
        if (isCancellation(err) || err instanceof MediaDownloadError) throw err;
        // Agent recovery is separate from the worker retry loop: a transient HTTP
        // failure can clear later even though files are not automatically retried here.
        throw new MediaDownloadError(err, resolved ? undefined : false);
    }
};

export const downloadYTV: Task<string, DownloadedMedia> = async (youtubeUrl, onProgress) => {
    const { combined, source } = await downloadMedia(youtubeUrl, onProgress);
    const audioOnly = path.join(path.dirname(combined), `${path.basename(combined, path.extname(combined))}.mp3`);
    const mediaRewritten = await prepareVideo(combined);
    await extractSoundFromMP4(combined, audioOnly);
    return { audioOnly, combined, source, mediaRewritten };
};

/** Whether the server can download a URL, and what the source reports about it. Downloads nothing. */
export async function inspectMedia(url: string): Promise<InspectMediaResponse> {
    let source: MediaSource | undefined;
    try {
        source = new MediaSource(url);
        await source.lookup();
        return { supported: true, source: source.sourceInfo() };
    } catch (err) {
        const { reason, permanent, hint } = classifyMediaError(err);
        return { supported: false, reason, retryable: !permanent, message: source?.lastLookupError ?? mediaErrorMessage(err), ...(hint && { hint }) };
    }
}

/** What the URL alone settles: our own storage, or a video whose cache key the URL carries. */
interface OfflineSource {
    kind: 'spaces' | 'yt-dlp';
    cacheKey: string;
    sourceType: string;
    /** The yt-dlp extractor key, for the report when no lookup succeeds. */
    extractor?: string;
}

const isFacebookHost = (host: string): boolean =>
    host === 'fb.watch' || host === 'facebook.com' || host === 'fb.com'
    || host.endsWith('.facebook.com') || host.endsWith('.fb.com');

const extractFacebookVideoId = (url: URL): string | undefined => {
    if (url.hostname === 'fb.watch') {
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

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be']);
// A YouTube id is exactly 11 url-safe characters. The id names files in the data dir.
const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

const extractYouTubeVideoId = (url: URL): string | undefined => {
    let videoId: string | undefined;
    if (url.hostname.endsWith('youtu.be')) {
        videoId = url.pathname.split('/')[1];
    } else if (url.pathname === '/watch' || url.pathname === '/watch/') {
        videoId = url.searchParams.get('v') || undefined;
    } else {
        // /embed/<id>, /live/<id> (a livestream's own URL), /shorts/<id>
        videoId = url.pathname.match(/^\/(?:embed|live|shorts)\/([^/]+)/)?.[1];
    }
    if (videoId && !YOUTUBE_VIDEO_ID.test(videoId)) {
        throw new Error('Invalid YouTube video ID');
    }
    return videoId || undefined;
};

/**
 * Spaces, YouTube and Facebook from the URL alone; undefined for anything else, including a
 * YouTube or Facebook URL of a form not parsed here (a lookup resolves those).
 */
export function offlineSource(mediaUrl: string): OfflineSource | undefined {
    // The string goes to yt-dlp as an argument and to fetch, so it must parse
    // as an http(s) URL: an option-like string or a path never gets that far.
    const parsed = assertFetchableUrl(mediaUrl, 'youtubeUrl');
    const hostname = parsed.hostname.toLowerCase();

    if (YOUTUBE_HOSTS.has(hostname)) {
        const id = extractYouTubeVideoId(parsed);
        return id ? { kind: 'yt-dlp', cacheKey: id, sourceType: 'YouTube', extractor: 'Youtube' } : undefined;
    }
    if (isFacebookHost(hostname)) {
        const id = extractFacebookVideoId(parsed);
        return id ? { kind: 'yt-dlp', cacheKey: `fb-${id}`, sourceType: 'Facebook', extractor: 'Facebook' } : undefined;
    }
    // Already on our own Spaces storage (front-end upload)
    if (isSpacesUrl(mediaUrl)) {
        return { kind: 'spaces', cacheKey: path.basename(mediaUrl, path.extname(mediaUrl)), sourceType: 'Spaces' };
    }
    return undefined;
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
// Integrated loudness at or below this counts as no usable audio. Real recordings
// sit far above it even when badly under-recorded; the two observed failures were
// aborted streams measuring -inf (digital silence) with peaks around -72 dBTP.
const SILENCE_FLOOR_LUFS = -60;
const AUDIO_BITRATE = '128k';
// Mux ignores MP4 edit lists, so it shows the picture this much behind the sound.
// Facebook downloads carry 0.665 s and 2.938 s (18 and 22 frames); a B-frame delay
// of one or two frames is normal and is what a rebuild leaves.
const VIDEO_START_SHIFT_TOLERANCE_SECONDS = 0.1;
const VIDEO_START_SHIFT_TOLERANCE_FRAMES = 3;

/**
 * Whether the source carries no usable audio. Normalization cannot rescue it:
 * ffmpeg rejects a `measured_I` outside [-99, 0], and clamping -inf to the floor
 * would apply ~85 dB of gain to the noise floor. Nor is there anything to
 * transcribe — so this is a task failure, not a pass to skip.
 */
export function isSilentAudio(stats: LoudnormStats): boolean {
    const integrated = parseFloat(stats.input_i);
    // ffmpeg emits "-inf" on digital silence
    return !Number.isFinite(integrated) || integrated <= SILENCE_FLOOR_LUFS;
}

export function needsLoudnormCorrection(stats: LoudnormStats): boolean {
    const deltaI = Math.abs(LOUDNORM_TARGET.I - parseFloat(stats.input_i));
    // Callers reject silence via isSilentAudio first; false keeps this correct
    // standalone, since a non-finite measurement is precisely what pass 2 rejects.
    if (!Number.isFinite(deltaI)) {
        return false;
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
            env: childEnv(),
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

/**
 * Rewrites the downloaded file at most once, for either or both of two independent
 * corrections: loudness normalization (audio re-encode) and the video start shift
 * (decode timestamps rebuilt, video copied). Returns whether the file was rewritten.
 */
async function prepareVideo(filePath: string): Promise<boolean> {
    const filename = path.basename(filePath);
    const loudnormFilter = await measureLoudnormFilter(filePath);

    const timing = await measureVideoStartShift(filePath);
    let rebuildVideoDts = timing !== null && isVideoStartShifted(timing.shift, timing.frameSeconds);
    if (timing !== null) {
        console.log(`[video-start] ${filename}: edit list shifts the first frame by ${timing.shift.toFixed(3)}s${rebuildVideoDts ? ', rebuilding the video decode timestamps' : ''}`);
    }

    if (!loudnormFilter && !rebuildVideoDts) {
        return false;
    }

    const tempPath = filePath + '.rewritten.mp4';
    const rewrite = async (rebuild: boolean) => {
        try {
            await runFfmpeg(buildRewriteArgs(filePath, tempPath, { loudnormFilter, rebuildVideoDts: rebuild }));
        } catch (err) {
            // A half-written temp file would otherwise linger in the media cache
            fs.rmSync(tempPath, { force: true });
            throw err;
        }
    };
    const start = Date.now();
    try {
        await rewrite(rebuildVideoDts);
    } catch (err) {
        // The shift correction must not fail the transcription: the file then plays as downloaded
        if (!rebuildVideoDts) throw err;
        console.warn(`[video-start] ${filename}: rebuilding the video decode timestamps failed, leaving the shift uncorrected: ${(err as Error).message}`);
        rebuildVideoDts = false;
        if (!loudnormFilter) return false;
        await rewrite(false);
    }
    fs.renameSync(tempPath, filePath);
    console.log(`[prepare-video] ${filename}: rewrote in ${((Date.now() - start) / 1000).toFixed(1)}s (loudnorm=${loudnormFilter !== null}, rebuildVideoDts=${rebuildVideoDts})`);
    return true;
}

/**
 * Rewrite arguments: the video is always copied, and the audio is re-encoded only when
 * loudnorm applies (with neither correction, the result is a plain remux).
 *
 * A Facebook video carries decode timestamps that run a constant 0.6–3 s before its
 * presentation timestamps, hidden by an edit list. Mux ignores edit lists and starts
 * the video at its first decode timestamp, and the web player starts its clock at the
 * first video frame, so neither the edit list nor a delayed audio track survives
 * playback. `-fflags +igndts` drops the input decode timestamps, and ffmpeg derives
 * new ones from the H.264 stream with the normal one- or two-frame delay: the first
 * frame then starts at ~0 for Mux, the player, browsers and the transcript audio alike.
 */
export function buildRewriteArgs(
    input: string,
    output: string,
    { loudnormFilter, rebuildVideoDts }: { loudnormFilter: string | null; rebuildVideoDts: boolean },
): string[] {
    return [
        ...(rebuildVideoDts ? ['-fflags', '+igndts'] : []),
        '-i', input,
        '-c:v', 'copy',
        ...(loudnormFilter
            ? ['-af', loudnormFilter, '-c:a', 'aac', '-b:a', AUDIO_BITRATE]
            : ['-c:a', 'copy']),
        '-y', output,
    ];
}

// A failed probe must not fail the transcription: the file then plays as it did before.
async function measureVideoStartShift(filePath: string): Promise<{ shift: number; frameSeconds: number | null } | null> {
    try {
        const [presented, raw] = await Promise.all([
            probeVideoTiming(filePath, { ignoreEditList: false }),
            probeVideoTiming(filePath, { ignoreEditList: true }),
        ]);
        return { shift: parseVideoStartShift(presented.startTime, raw.startTime), frameSeconds: parseFrameSeconds(presented.avgFrameRate) };
    } catch (err) {
        console.warn(`[video-start] ${path.basename(filePath)}: could not measure the video start shift, leaving it uncorrected: ${(err as Error).message}`);
        return null;
    }
}

/**
 * Seconds by which the video edit list delays the first frame, from ffprobe's
 * `start_time` with the edit list applied and ignored. A file with no video stream,
 * or an unreadable value, has no shift to correct.
 */
export function parseVideoStartShift(presentedStart: string, rawStart: string): number {
    const shift = parseFloat(rawStart) - parseFloat(presentedStart);
    return Number.isFinite(shift) ? shift : 0;
}

/** One frame's duration from ffprobe's `avg_frame_rate` ("30000/1001"), or null when unknown. */
export function parseFrameSeconds(avgFrameRate: string): number | null {
    const [num, den] = avgFrameRate.split('/').map(Number);
    const fps = den === undefined ? num : num / den;
    return Number.isFinite(fps) && fps > 0 ? 1 / fps : null;
}

/**
 * Whether the shift is the Facebook decode delay rather than a normal B-frame delay.
 * The frame bound keeps a rebuilt file from being rebuilt again on every run: in a
 * low-frame-rate video the normal one- or two-frame delay can exceed the time bound.
 */
export function isVideoStartShifted(shift: number, frameSeconds: number | null): boolean {
    return shift > VIDEO_START_SHIFT_TOLERANCE_SECONDS
        && (frameSeconds === null || shift > VIDEO_START_SHIFT_TOLERANCE_FRAMES * frameSeconds);
}

/**
 * Measures loudness (pass 1) and returns the audio filter that normalizes it in the
 * rewrite, or null when the audio needs no correction.
 */
async function measureLoudnormFilter(filePath: string): Promise<string | null> {
    // An operator switch for when the time to a transcript matters more than even
    // loudness: the measurement and normalization are skipped, including the
    // silent-audio check. The video start shift is still corrected.
    if (process.env.SKIP_LOUDNORM === '1') {
        console.log(`[loudnorm] ${path.basename(filePath)}: SKIP_LOUDNORM=1, skipping measurement and normalization`);
        return null;
    }
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

    if (isSilentAudio(stats)) {
        throw new Error(
            `Source audio is silent (integrated loudness ${stats.input_i} LUFS, at or below the ${SILENCE_FLOOR_LUFS} LUFS floor) — ` +
            `the recording has no audio to transcribe`
        );
    }

    if (!needsLoudnormCorrection(stats)) {
        console.log(`[loudnorm] ${filename}: within ${LOUDNORM_TOLERANCE_LU} LU of the ${I} LUFS target, skipping normalization`);
        return null;
    }

    // Pass 2 (in the rewrite): apply normalization with linear mode
    return `${loudnormFilter}:measured_I=${stats.input_i}:measured_TP=${stats.input_tp}:measured_LRA=${stats.input_lra}:measured_thresh=${stats.input_thresh}:linear=true`;
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
            stdio: ['pipe', 'pipe', 'pipe'],
            env: childEnv(),
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


/** The content type when the URL serves a video or audio file, else undefined (a page, an error, no answer). */
async function mediaFileType(url: string): Promise<string | undefined> {
    try {
        const res = await fetch(url, { method: 'HEAD', headers: HEADERS, signal: AbortSignal.timeout(15_000) });
        const type = res.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
        return res.ok && type && /^(video|audio)\//.test(type) ? type : undefined;
    } catch {
        return undefined;
    }
}

const downloadUrl = async (url: string, outputPath: string) => {
    console.log(`Downloading from: ${url}`);
    // Only complete downloads become cache entries. A disconnected stream or a killed
    // process must never leave a nonempty final file that the next request reuses.
    const partialPath = `${outputPath}.${randomUUID()}.part`;
    try {
        assertFetchableUrl(url, 'youtubeUrl');
        const response = await fetch(url, { headers: HEADERS });
        if (!response.ok) {
            await response.body?.cancel();
            throw new MediaHttpError(response.status, url, response.statusText);
        }
        if (!response.body) throw new Error('Unable to read response body');
        await streamPipeline(
            Readable.fromWeb(response.body as ReadableStream),
            fs.createWriteStream(partialPath),
        );
        const finalSize = fs.statSync(partialPath).size;
        if (finalSize === 0) throw new Error(`Download failed: empty file. URL: ${url}`);
        fs.renameSync(partialPath, outputPath);
        console.log(`Downloaded video: ${formatBytes(finalSize)} -> ${path.basename(outputPath)}`);
    } finally {
        fs.rmSync(partialPath, { force: true });
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
let ytDlpUpdateInFlight: Promise<void> | undefined;
let activeYtDlpCalls = 0;

/** Do not read the Python zipapp while its updater is replacing it. */
async function withYtDlpBinary<T>(call: () => Promise<T>): Promise<T> {
    while (ytDlpUpdateInFlight) await ytDlpUpdateInFlight;
    activeYtDlpCalls++;
    try { return await call(); }
    finally { activeYtDlpCalls--; }
}

async function updateYtDlp(): Promise<void> {
    // The retry loop calls the downloader once per attempt; re-checking for a yt-dlp
    // update on each of up to ~30 attempts adds a network round-trip (up to 60s) per
    // retry for nothing. Once an hour is plenty.
    if (process.env.YTDLP_AUTO_UPDATE === 'false' || activeYtDlpCalls > 0) return;
    if (ytDlpUpdateInFlight) return ytDlpUpdateInFlight;
    if (Date.now() - lastYtDlpUpdateCheck < 60 * 60_000) return;
    lastYtDlpUpdateCheck = Date.now();

    const binaryPath = ytdlpBinary();
    console.log('Checking for yt-dlp updates...');

    ytDlpUpdateInFlight = new Promise<void>((resolve) => {
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
            // Keep the read barrier until the close event confirms termination.
            updateProcess.kill('SIGKILL');
            console.warn('yt-dlp update check timed out');
        }, 60000);
    });
    try { await ytDlpUpdateInFlight; }
    finally { ytDlpUpdateInFlight = undefined; }
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
        binaryPath: ytdlpBinary(),
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
        // The extension-free split pair is for Vimeo, which serves only separate HLS video and
        // audio streams, both ext=mp4: the alternatives before it match neither.
        format: `bestvideo[height<=${DEFAULT_VIDEO_QUALITY}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${DEFAULT_VIDEO_QUALITY}][ext=mp4]` +
            `/bestvideo[height<=${DEFAULT_VIDEO_QUALITY}]+bestaudio/best`,
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
        await withYtDlpBinary(() => ytdlp.downloadAsync(youtubeUrl, ytOptions));

        const expectedPath = path.join(outputDir, `${baseName}.mp4`);
        if (!fs.existsSync(expectedPath)) {
            throw new Error(`yt-dlp reported success but expected mp4 file not found: ${expectedPath}`);
        }

        return expectedPath;
    } catch (err) {
        throw new Error(`yt-dlp download failed: ${(err as Error).message}`);
    }
}
