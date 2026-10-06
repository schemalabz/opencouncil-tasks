import { addUsage, NO_USAGE, toTaskTokenUsage } from '../lib/ai.js';
import type { ReadAttendanceSheetRequest, ReadAttendanceSheetResult } from '../types.js';
import type { Task } from './pipeline.js';
import {
    buildSheetUserPrompt,
    collectSheetNames,
    matchSheetNames,
    readSheetWithModel,
    sheetCacheKey,
    toMeetingFactsReading,
    SHEET_CACHE_PREFIX,
    type RawSheetReading,
} from './utils/attendanceSheetReading.js';
import { readCache, writeCache } from './utils/decisionPdfExtraction.js';
import { isSpacesUrl, spacesPublicBase } from './utils/spacesUrl.js';

/**
 * Read the sheet the back office keeps during a meeting: the roll call, the
 * arrivals and departures noted by hand, per-item votes when the sheet has
 * them, and who presided. The reading states what the page states, matched
 * to the roster; opencouncil combines it with the transcript and the
 * decision documents.
 */

export interface ReadAttendanceSheetOptions {
    /** Call the model even when the file was read before. */
    skipCache?: boolean;
    /** How to get the file's bytes; the default fetches the presigned URL. The CLI reads a local path instead. */
    download?: (fileUrl: string) => Promise<Buffer>;
}

/** The app refuses a sheet above 20 MB; a little room for the object store's framing. */
const MAX_SHEET_BYTES = 25 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * Whether a sheet URL points at the object store the app writes sheets to: an
 * object under our public base (`spacesPublicBase`, which is the app's
 * `/dev/files` proxy on a MinIO setup), or the configured Spaces endpoint and
 * the bucket's own host under it, over https. A task request names the file,
 * so the destination is checked here rather than trusted; a URL elsewhere is
 * refused before anything is fetched. Without a configured endpoint (a local
 * run) only the scheme is checked.
 */
export function isAllowedSheetUrl(fileUrl: string, endpoint: string | undefined, publicBase: string | undefined = undefined, bucket: string | undefined = undefined): boolean {
    if (publicBase && isSpacesUrl(fileUrl, publicBase)) return true;
    let url: URL;
    try { url = new URL(fileUrl); } catch { return false; }
    if (url.protocol !== 'https:') return false;
    if (!endpoint) return true;
    let allowedHost: string;
    try { allowedHost = new URL(endpoint.includes('://') ? endpoint : `https://${endpoint}`).hostname; } catch { return false; }
    // With the bucket known, only our bucket: its own host (virtual-hosted) or its
    // first path segment on the endpoint (path-style). Another customer's bucket in
    // the same region is not ours to read.
    if (bucket) return url.hostname === `${bucket}.${allowedHost}` || (url.hostname === allowedHost && url.pathname.startsWith(`/${bucket}/`));
    return url.hostname === allowedHost || url.hostname.endsWith(`.${allowedHost}`);
}

async function downloadSheet(fileUrl: string): Promise<Buffer> {
    if (!isAllowedSheetUrl(fileUrl, process.env.DO_SPACES_ENDPOINT, spacesPublicBase(), process.env.DO_SPACES_BUCKET)) throw new Error('The sheet URL is not on the configured object store');
    const response = await fetch(fileUrl, { redirect: 'error', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) {
        throw new Error(`Failed to download attendance sheet: HTTP ${response.status} ${response.statusText}`);
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_SHEET_BYTES) throw new Error(`The sheet is larger than ${MAX_SHEET_BYTES} bytes`);
    if (!response.body) throw new Error('The sheet download has no body');
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of response.body) {
        total += chunk.length;
        if (total > MAX_SHEET_BYTES) throw new Error(`The sheet is larger than ${MAX_SHEET_BYTES} bytes`);
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

export async function readAttendanceSheetWith(
    request: ReadAttendanceSheetRequest,
    onProgress: (stage: string, progressPercent: number) => void,
    options: ReadAttendanceSheetOptions = {},
): Promise<ReadAttendanceSheetResult> {
    const userPrompt = buildSheetUserPrompt(request);
    const cacheKey = sheetCacheKey(request.fileUrl, userPrompt);

    let raw = options.skipCache ? null : readCache<RawSheetReading>(cacheKey, SHEET_CACHE_PREFIX);
    let usage = { ...NO_USAGE };
    if (!raw) {
        onProgress('downloading sheet', 5);
        const bytes = await (options.download ?? downloadSheet)(request.fileUrl);
        onProgress('reading sheet', 15);
        const read = await readSheetWithModel({ bytes, mediaType: request.mediaType, userPrompt });
        raw = read.result;
        usage = addUsage(usage, read.usage);
        // An unreadable page is the model's verdict on one attempt; a second read may see it.
        if (!raw.unreadable) writeCache(cacheKey, raw, SHEET_CACHE_PREFIX);
    }

    onProgress('matching names', 75);
    const matching = await matchSheetNames(collectSheetNames(raw), request.roster);
    usage = addUsage(usage, matching.usage);

    const reading = toMeetingFactsReading(raw, matching, request.agendaItems);
    onProgress('done', 100);
    return { reading, usage: toTaskTokenUsage(usage) };
}

export const readAttendanceSheet: Task<ReadAttendanceSheetRequest, ReadAttendanceSheetResult> = (request, onProgress) =>
    readAttendanceSheetWith(request, onProgress, { skipCache: request.forceRead === true });
