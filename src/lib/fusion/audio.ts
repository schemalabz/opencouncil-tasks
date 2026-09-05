import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import crypto from "crypto";
import { pipeline } from "stream/promises";
import { Readable, Transform } from "stream";
import mime from "mime";
import { createSpacesClient, putPublicFile, deleteFromSpacesByPrefix } from "../../tasks/uploadToSpaces.js";
import { spacesUrlForKey } from "../../tasks/utils/spacesUrl.js";
import type { AudioArtifact } from "./types.js";
import { throwIfAborted } from "./deadline.js";

/**
 * Audio never travels through this module as a whole buffer. Everything is a
 * path plus a hash: a 15-minute segment is tens of megabytes and three
 * providers plus four benchmark arms would otherwise hold several copies of it
 * in the heap at once.
 */

const MAX_AUDIO_BYTES = 200 * 1024 * 1024; // 200 MB, per spec §4.5

export class AudioTooLargeError extends Error {
    constructor(bytes: number) {
        super(`audio is ${bytes} bytes, over the ${MAX_AUDIO_BYTES} byte limit`);
        this.name = "AudioTooLargeError";
    }
}

/** Hash a file that is already on disk (the multipart route path). */
export async function artifactFromFile(filePath: string, options: { mime?: string; durationSec?: number } = {}): Promise<AudioArtifact> {
    const stat = await fsp.stat(filePath);
    if (stat.size > MAX_AUDIO_BYTES) {
        throw new AudioTooLargeError(stat.size);
    }
    return {
        path: filePath,
        sha256: await hashFile(filePath),
        sizeBytes: stat.size,
        mime: options.mime || mime.getType(filePath) || "application/octet-stream",
        durationSec: options.durationSec,
    };
}

/**
 * Download a URL to a temp file purely to get its content hash. transcribe.ts
 * already has a public URL, so the bytes are needed only for the cache key —
 * every provider is then pointed back at `canonicalUrl`.
 */
export async function artifactFromUrl(
    url: string,
    options: { signal?: AbortSignal; tmpDir?: string; durationSec?: number } = {},
): Promise<AudioArtifact & { cleanup: () => Promise<void> }> {
    const dir = await fsp.mkdtemp(path.join(options.tmpDir ?? os.tmpdir(), "oc-fusion-audio-"));
    const ext = path.extname(new URL(url).pathname) || ".bin";
    const file = path.join(dir, `audio${ext}`);
    const cleanup = async () => {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => { });
    };

    try {
        const response = await fetch(url, { signal: options.signal });
        if (!response.ok || !response.body) {
            throw new Error(`fetching audio returned ${response.status}`);
        }
        const declared = Number(response.headers.get("content-length") ?? "0");
        if (declared > MAX_AUDIO_BYTES) {
            throw new AudioTooLargeError(declared);
        }
        // Counted as it arrives, not after. `content-length` is a claim: a
        // response that omits it or lies would otherwise write the whole body
        // to disk before anyone measured it.
        await pipeline(
            Readable.fromWeb(response.body as never),
            boundedBytes(MAX_AUDIO_BYTES),
            fs.createWriteStream(file),
        );
        const stat = await fsp.stat(file);
        if (stat.size > MAX_AUDIO_BYTES) {
            throw new AudioTooLargeError(stat.size);
        }
        return {
            path: file,
            canonicalUrl: url,
            sha256: await hashFile(file),
            sizeBytes: stat.size,
            mime: response.headers.get("content-type")?.split(";")[0] || mime.getType(file) || "application/octet-stream",
            durationSec: options.durationSec,
            cleanup,
        };
    } catch (error) {
        await cleanup();
        throw error;
    }
}

/** Stops the download the moment it passes `limit`, and destroys the pipeline. */
function boundedBytes(limit: number): Transform {
    let seen = 0;
    return new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            seen += chunk.length;
            if (seen > limit) {
                callback(new AudioTooLargeError(seen));
                return;
            }
            callback(null, chunk);
        },
    });
}

export function hashFile(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash("sha256");
        const stream = fs.createReadStream(filePath);
        stream.on("error", reject);
        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("end", () => resolve(hash.digest("hex")));
    });
}

export interface PublicAudioHandle {
    url: string;
    /** No-op when the audio already had a public URL of its own. */
    release: () => Promise<void>;
}

/**
 * Soniox and the serverless endpoint fetch audio by URL. When the artifact
 * already has one (every transcribe.ts call), it is reused — uploading a copy
 * of an object we already host would double the storage and the egress.
 * Otherwise the bytes go to `fusion-tmp/<sha256>.<ext>` exactly once, and the
 * caller releases them in a finally block.
 */
export async function ensurePublicUrl(audio: AudioArtifact, options: { signal?: AbortSignal } = {}): Promise<PublicAudioHandle> {
    if (audio.canonicalUrl) {
        return { url: audio.canonicalUrl, release: async () => { } };
    }
    if (!audio.path) {
        throw new Error("audio artifact has neither a canonicalUrl nor a local path");
    }
    if (options.signal) throwIfAborted(options.signal);

    const bucket = process.env.DO_SPACES_BUCKET;
    if (!bucket) {
        throw new Error("DO_SPACES_BUCKET is not set — cannot publish fusion audio for URL-only providers");
    }
    const ext = path.extname(audio.path) || ".bin";
    const key = `fusion-tmp/${audio.sha256}${ext}`;
    await putPublicFile(createSpacesClient(), bucket, key, audio.path);

    return {
        url: spacesUrlForKey(key),
        release: async () => {
            await deleteFromSpacesByPrefix(key).catch((error) => {
                console.warn(`[fusion] failed to delete temp audio ${key}: ${error}`);
            });
        },
    };
}

export { MAX_AUDIO_BYTES };
