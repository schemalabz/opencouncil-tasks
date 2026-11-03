import { createHash } from 'crypto';
import type { MediaSourceInfo, MediaUnsupportedReason, MediaFailure } from '../../types.js';

/**
 * `yt-dlp -O` template: a JSON object of just these fields. A full --dump-single-json
 * runs to tens of MB for a multi-hour VOD (every format, heatmaps), which overflows the
 * exec output buffer.
 */
export const MEDIA_INFO_TEMPLATE = '%(.{extractor_key,id,title,duration,live_status,release_timestamp,timestamp,' +
    'uploader,channel,webpage_url,thumbnail,chapters,direct,playlist_id})j';

// The two failures a lookup reports itself, worded like yt-dlp's own so one classifier reads both
const NO_VIDEO = 'ERROR: No video found at this URL';
const SEVERAL_VIDEOS = 'ERROR: Several videos at this URL (a playlist, a channel, or a page embedding more than one)';

/** What a yt-dlp lookup reports about a URL that it can download. */
export interface MediaInfo {
    extractor: string;
    id: string;
    /** A plain media file, not a page: Generic extractor, served by a direct fetch. */
    direct: boolean;
    title?: string;
    durationSec?: number;
    liveStatus?: string;
    startedAt?: string;
    uploader?: string;
    webpageUrl?: string;
    thumbnailUrl?: string;
    chapters?: { title: string; startSeconds: number; endSeconds: number }[];
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const positive = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);

/**
 * Parses the `-O MEDIA_INFO_TEMPLATE` output: one JSON line per video found (yt-dlp may print
 * warnings before them). A page where yt-dlp finds nothing exits 0 with no output; a
 * playlist or channel prints a line per entry, each carrying the playlist's id.
 */
export function parseMediaInfo(stdout: string): MediaInfo {
    const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'));
    if (lines.length === 0) throw new Error(NO_VIDEO);
    let raw: Record<string, unknown>;
    try {
        raw = JSON.parse(lines[lines.length - 1]);
    } catch {
        throw new Error(`yt-dlp printed unreadable media info: ${lines[lines.length - 1].slice(0, 200)}`);
    }
    if (lines.length > 1 || str(raw.playlist_id)) throw new Error(SEVERAL_VIDEOS);
    const line = lines[0];
    const extractor = str(raw.extractor_key);
    const id = raw.id === undefined || raw.id === null ? undefined : String(raw.id);
    if (!extractor || !id) {
        throw new Error(`yt-dlp media info lacks an extractor or id: ${line.slice(0, 200)}`);
    }
    const started = positive(raw.release_timestamp) ?? positive(raw.timestamp);
    const chapters = Array.isArray(raw.chapters)
        ? raw.chapters.flatMap((c: any) => typeof c?.start_time === 'number' && typeof c?.end_time === 'number'
            ? [{ title: String(c.title ?? ''), startSeconds: c.start_time, endSeconds: c.end_time }]
            : [])
        : [];
    return {
        extractor,
        id,
        direct: raw.direct === true,
        title: str(raw.title),
        durationSec: positive(raw.duration),
        liveStatus: str(raw.live_status),
        startedAt: started === undefined ? undefined : new Date(started * 1000).toISOString(),
        uploader: str(raw.uploader) ?? str(raw.channel),
        // yt-dlp appends a #__youtubedl_smuggle fragment (the embedding page as referer)
        webpageUrl: str(raw.webpage_url)?.split('#__youtubedl_smuggle')[0],
        thumbnailUrl: str(raw.thumbnail),
        chapters: chapters.length ? chapters : undefined,
    };
}

/** Whether a lookup result is a plain media file rather than a page yt-dlp extracts from. */
export const isDirectFile = (info: MediaInfo): boolean => info.extractor === 'Generic' && info.direct;

const sensitiveMediaQueryKeys = new Set([
    'keypairid', 'token', 'accesstoken', 'authtoken', 'auth', 'authorization', 'signature', 'sig', 'key', 'apikey',
    'password', 'passwd', 'credential', 'credentials', 'h', 'hash', 'jwt', 'bearer', 'policy',
    'expires', 'expiry', 'session', 'sessionid', 'secret', 'clientsecret', 'oauthtoken',
    'awsaccesskeyid', 'googleaccessid', 'hdnts', 'hdnea', 'authkey', 'securitytoken', 'cookie',
]);

/** Informational URLs must not expose access credentials. The input URL is kept for transfer. */
export function sanitizeMediaUrl(value: string | undefined): string | undefined {
    if (!value) return undefined;
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
        url.username = '';
        url.password = '';
        url.hash = '';
        for (const key of [...url.searchParams.keys()]) {
            const normalized = key.toLowerCase().replace(/[-_]/g, '');
            if (sensitiveMediaQueryKeys.has(normalized) || /token|password|passwd|secret|credential|signature|(^|[-_])sig($|[-_])/i.test(key)
                || normalized.startsWith('xamz') || normalized.startsWith('xgoog')) {
                url.searchParams.delete(key);
            }
        }
        return url.toString();
    } catch {
        return undefined;
    }
}

/** The API view of a looked-up source. */
export function toSourceInfo(info: MediaInfo): MediaSourceInfo {
    return {
        kind: isDirectFile(info) ? 'file' : 'yt-dlp',
        extractor: info.extractor,
        id: info.id,
        title: info.title,
        durationSeconds: info.durationSec,
        liveStatus: info.liveStatus,
        startedAt: info.startedAt,
        uploader: info.uploader,
        webpageUrl: sanitizeMediaUrl(info.webpageUrl),
        thumbnailUrl: sanitizeMediaUrl(info.thumbnailUrl),
        chapters: info.chapters,
    };
}

const urlHash = (url: string) => createHash('sha256').update(url).digest('hex').slice(0, 16);

/**
 * The data-dir file name and Spaces object name for a looked-up video: stable per video,
 * `[A-Za-z0-9_-]` only. YouTube keeps its bare id and Facebook its `fb-` prefix, the keys
 * existing media already carries. Generic and HTML5 ids are page or file names that repeat
 * across sites. Other providers can have per-tenant ids, so new keys include the source
 * origin and original id in a digest; sanitizing an id must not make distinct ids collide.
 */
export function cacheKeyFor(info: MediaInfo, url: string): string {
    if (info.extractor === 'Generic' || info.extractor === 'HTML5MediaEmbed') return `url-${urlHash(url)}`;
    const id = info.id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
    if (info.extractor === 'Youtube') return id;
    if (info.extractor === 'Facebook') return `fb-${id}`;
    const extractor = info.extractor.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 40);
    const origin = new URL(info.webpageUrl ?? url).origin;
    return `${extractor}-${id}-${urlHash(JSON.stringify([info.extractor, origin, info.id]))}`;
}

interface ErrorClass {
    reason: Exclude<MediaUnsupportedReason, 'error'>;
    pattern: RegExp;
    hint?: string;
}

// Only failures that no amount of waiting fixes; anything unmatched stays retryable
// (bot-check walls, network blips, 403s while a post-live VOD is processing). Facebook's
// "The video is not available, Facebook said: ..." is deliberately absent: yt-dlp emits it
// for any interstitial, including the transient one served while a post-live VOD
// processes. Its login wall (raise_login_required's default message) only fires on a real
// login form, never on bot-checks. A 404 counts only for the page itself ("Unable to
// download webpage"), not for a media fragment of a VOD that is still processing.
const PERMANENT_ERRORS: ErrorClass[] = [
    { reason: 'unsupported', pattern: /Unsupported URL|No video found at this URL|Invalid YouTube video ID/i,
      hint: 'Send the URL of a video page, a page that embeds a video player, or a media file.' },
    { reason: 'playlist', pattern: /Several videos at this URL/i,
      hint: "Send the URL of the meeting's own video." },
    { reason: 'embed_only', pattern: /embed-only video/i,
      hint: 'The video plays only where it is embedded: send the URL of the page that embeds it.' },
    { reason: 'login_required', pattern: /only available for registered users|only works when logged-in/i,
      hint: 'The source requires an account. For Vimeo, a player.vimeo.com/video/<id> URL or the page that embeds the video may work.' },
    { reason: 'drm', pattern: /DRM protected/i },
    { reason: 'unavailable', pattern: /video unavailable|private video|has been removed/i },
    { reason: 'not_found', pattern: /Unable to download webpage: HTTP Error (?:404|410)/i },
];

/** A status returned by the plain HTTP transfer, not by a fragment downloader. */
export class MediaHttpError extends Error {
    constructor(readonly status: number, url: string, statusText: string) {
        super(`HTTP error getting ${url}: status: ${status} ${statusText}`);
        this.name = 'MediaHttpError';
    }
}

/** Classifies a yt-dlp failure. `reason: 'error'` is the retryable remainder. */
export function classifyMediaError(err: unknown): { reason: MediaUnsupportedReason; permanent: boolean; hint?: string } {
    if (err instanceof MediaHttpError && (err.status === 404 || err.status === 410)) {
        return { reason: 'not_found', permanent: true };
    }
    const message = (err as Error)?.message ?? '';
    const match = PERMANENT_ERRORS.find((c) => c.pattern.test(message));
    return match
        ? { reason: match.reason, permanent: true, hint: match.hint }
        : { reason: 'error', permanent: false };
}

export const isPermanentMediaError = (err: unknown): boolean => classifyMediaError(err).permanent;

/** The yt-dlp `ERROR:` line(s) of a failure, without the wrapper and warning noise. */
export function mediaErrorMessage(err: unknown): string {
    const message = (err as Error)?.message ?? String(err);
    const errors = message.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('ERROR:'));
    const selected = errors.length ? [...new Set(errors)].join('\n') : message;
    // Failure prose does not need the object path or query. Preserve the provider origin
    // so callbacks, MCP histories and seed exports cannot become usable signed links.
    return selected.replace(/https?:\/\/[^\s"'<>]+/gi, value => {
        try { return new URL(value).origin; }
        catch { return '[redacted media URL]'; }
    });
}


/** A failure of source resolution or raw transfer, distinguished from later processing. */
export class MediaDownloadError extends Error {
    readonly mediaFailure: MediaFailure;

    constructor(cause: unknown, retryable?: boolean) {
        super(mediaErrorMessage(cause), { cause });
        this.name = 'MediaDownloadError';
        const classified = classifyMediaError(cause);
        this.mediaFailure = {
            reason: classified.reason,
            retryable: !classified.permanent && retryable !== false,
            ...(classified.hint && { hint: classified.hint }),
        };
    }
}
