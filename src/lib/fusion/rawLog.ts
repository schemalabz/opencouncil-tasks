import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";
import zlib from "zlib";
import { promisify } from "util";
import type { FusionArm, NormalizedWord, ProviderId } from "./types.js";

/**
 * The three per-system transcripts, kept.
 *
 * Decision of 2026-09-09: the raw streams do **not** go in the database yet,
 * but they must not be thrown away either — they are the only possible input to
 * a later LLM-as-judge or human correction pass, and once a segment's fusion is
 * cached the vendor calls that produced them are gone.
 *
 * So this is a runtime artifact, not a product surface. Three rules follow:
 *
 *  - It is off unless FUSION_RAW_LOG_DIR points somewhere. The path is a
 *    mounted volume outside the repo, never a path in the checkout: a file of
 *    verbatim council speech is the same PII category as the 2026-07-21 history
 *    purge.
 *  - It records word streams and closed-set statuses, and nothing else. No raw
 *    provider response, no provider error string — a vendor error can carry a
 *    signed URL or a key, and errors are already in the trace.
 *  - It never throws. A log is evidence about a transcription, not part of one.
 *
 * One file per attempt, atomically published, sharing its id with the trace
 * written by TraceWriter — so a trace and a raw record join on `attemptId`
 * without a database, and two concurrent segments cannot interleave.
 */

export const RAW_LOG_SCHEMA = "oc-fusion-raw/1";

/**
 * Written compact and gzipped, because the three streams are mostly the same
 * words three times over and a word record is short. Measured on 2.5 hours of
 * audio at the rate the benchmark saw (9,800 words per audio hour per system):
 * 9.7 MB indented, 4.9 MB compact, 0.75 MB compact and gzipped. Shadow mode
 * writes two records per segment, so the number that reaches a disk quota is
 * the last one doubled.
 *
 * Read one with `gunzip -c <file> | jq`. The uncompressed size is what the
 * valve below measures, so a record is capped by its content and not by how
 * well that content happened to compress.
 */
const gzip = promisify(zlib.gzip);

/** Default valve, not a routine path: a 20-minute segment is about 0.6 MB. */
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

/**
 * A record is verbatim council speech, so it expires by default. A deployment
 * that forgets to configure retention keeps two weeks, not forever; keeping it
 * forever has to be asked for with FUSION_RAW_LOG_RETENTION_DAYS=0.
 */
const DEFAULT_RETENTION_DAYS = 14;

/** The sweep is housekeeping, not part of writing a record. Hourly is enough. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * What this class writes, and nothing else. The directory may be shared with
 * other logs, and a sweep that took every `*.json.gz` in it would delete data
 * it never created. A record's name always begins with the audio sha256.
 */
const RECORD_NAME = /^[0-9a-f]{64}\.[^/]+\.json\.gz$/;

/**
 * A write that died between writeFile and rename leaves this behind. It holds
 * the same speech as a record, so retention has to reach it too, or the
 * expiry guarantee has a hole in it.
 */
const ABANDONED_TMP = /^[0-9a-f]{64}\.[^/]+\.json\.gz\.[0-9a-f]+\.tmp$/;

export type RawStreamStatus = "ok" | "empty" | "failed";

export interface RawProviderStream {
    providerId: ProviderId;
    status: RawStreamStatus;
    model?: string;
    paramsSha?: string;
    schemaRev?: string;
    rawSha256?: string;
    /** The normalized stream that fuse.py was fed. Segment-relative times. */
    words?: NormalizedWord[];
}

export interface RawTranscriptAttempt {
    attemptId: string;
    audioSha256: string;
    label?: string;
    mode: string;
    arm: FusionArm | "scribe";
    engineRev: string;
    configSha: string;
    outcome: "fused" | "scribe-fallback" | "scribe-only" | "failed";
    fallbackReason?: string;
    systems: RawProviderStream[];
}

interface StoredStream {
    providerId: ProviderId;
    status: RawStreamStatus;
    wordCount: number;
    model?: string;
    paramsSha?: string;
    schemaRev?: string;
    rawSha256?: string;
    words?: NormalizedWord[];
}

export interface RawTranscriptRecord {
    schema: typeof RAW_LOG_SCHEMA;
    attemptId: string;
    createdAt: string;
    audioSha256: string;
    label?: string;
    mode: string;
    arm: FusionArm | "scribe";
    engineRev: string;
    configSha: string;
    outcome: RawTranscriptAttempt["outcome"];
    fallbackReason?: string;
    /**
     * Stated rather than assumed: every time on this path is relative to the
     * segment, not the meeting, and a later consumer that guesses wrong would
     * place every word of a three-hour meeting in its first twenty minutes.
     */
    wordTimebase: "segment-relative";
    systems: StoredStream[];
    /** Set when the words were dropped to keep one attempt from filling a disk. */
    omitted?: "record_too_large";
}

export interface RawTranscriptLogOptions {
    maxBytes?: number;
    /** Days a record survives. 0 keeps everything, and has to be asked for. */
    retentionDays?: number;
}

export class RawTranscriptLog {
    private readonly dir?: string;
    private readonly maxBytes: number;
    private readonly retentionMs: number;
    private lastSweep = 0;
    private warned = false;

    constructor(dir: string | undefined, options: RawTranscriptLogOptions = {}) {
        this.dir = dir?.trim() || undefined;
        this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
        const days = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
        this.retentionMs = days > 0 ? days * 24 * 60 * 60 * 1000 : 0;
    }

    get enabled(): boolean {
        return this.dir !== undefined;
    }

    /** Returns whether a record was written. Never throws, never rejects. */
    async write(attempt: RawTranscriptAttempt): Promise<boolean> {
        const dir = this.dir;
        if (!dir) return false;

        let file = "";
        try {
            const record = this.buildRecord(attempt);
            let body = JSON.stringify(record);
            if (Buffer.byteLength(body, "utf8") > this.maxBytes) {
                // Explicit marker, never a silent shortening: a record with
                // half a transcript in it would read as a complete one.
                body = JSON.stringify(withoutWords(record));
            }

            // The name carries only hashes and an id. No word ever reaches a
            // filename, where it would show up in every directory listing and
            // every backup manifest.
            file = path.join(dir, `${attempt.audioSha256}.${attempt.attemptId}.json.gz`);
            await fsp.mkdir(dir, { recursive: true });
            const tmp = `${file}.${crypto.randomBytes(4).toString("hex")}.tmp`;
            await fsp.writeFile(tmp, await gzip(Buffer.from(body, "utf8")));
            await fsp.rename(tmp, file);
            await this.sweep(dir);
            return true;
        } catch (error) {
            // The path and the error, never the payload: a warning that quotes
            // a word stream puts transcript text in app.log, which is collected.
            if (!this.warned) {
                this.warned = true;
                console.warn(`[fusion] raw transcript log write failed (${file || dir}): ${error}`);
            }
            return false;
        }
    }

    /**
     * Delete records older than the retention window. Runs after a successful
     * write and at most once an hour, so a busy segment does not pay for a
     * directory scan, and a deployment that never restarts still expires its
     * speech.
     *
     * Only names this class writes are considered: a directory it shares with
     * other logs must not lose them. Failure is silent by design, exactly like
     * a failed write — deleting is housekeeping, and housekeeping must never
     * turn a transcription into an error.
     */
    private async sweep(dir: string): Promise<void> {
        if (this.retentionMs <= 0) return;
        const now = Date.now();
        if (now - this.lastSweep < SWEEP_INTERVAL_MS) return;
        this.lastSweep = now;

        try {
            const names = await fsp.readdir(dir);
            const cutoff = now - this.retentionMs;
            for (const name of names) {
                if (!RECORD_NAME.test(name) && !ABANDONED_TMP.test(name)) continue;
                const file = path.join(dir, name);
                try {
                    const stat = await fsp.stat(file);
                    if (stat.isFile() && stat.mtimeMs < cutoff) await fsp.unlink(file);
                } catch {
                    // Gone already, or racing another sweep. Either is fine.
                }
            }
        } catch (error) {
            if (!this.warned) {
                this.warned = true;
                console.warn(`[fusion] raw transcript log sweep failed (${dir}): ${error}`);
            }
        }
    }

    private buildRecord(attempt: RawTranscriptAttempt): RawTranscriptRecord {
        return {
            schema: RAW_LOG_SCHEMA,
            attemptId: attempt.attemptId,
            createdAt: new Date().toISOString(),
            audioSha256: attempt.audioSha256,
            label: attempt.label,
            mode: attempt.mode,
            arm: attempt.arm,
            engineRev: attempt.engineRev,
            configSha: attempt.configSha,
            outcome: attempt.outcome,
            fallbackReason: attempt.fallbackReason,
            wordTimebase: "segment-relative",
            systems: attempt.systems.map(storedStream),
        };
    }
}

/**
 * The allowlist. Copying the caller's object would let a future provider add a
 * field — an error, a signed URL, an echoed response — and have it land in the
 * log without anybody choosing that.
 */
function storedStream(stream: RawProviderStream): StoredStream {
    const stored: StoredStream = {
        providerId: stream.providerId,
        status: stream.status,
        wordCount: stream.words?.length ?? 0,
    };
    if (stream.model !== undefined) stored.model = stream.model;
    if (stream.paramsSha !== undefined) stored.paramsSha = stream.paramsSha;
    if (stream.schemaRev !== undefined) stored.schemaRev = stream.schemaRev;
    if (stream.rawSha256 !== undefined) stored.rawSha256 = stream.rawSha256;
    if (stream.words !== undefined) {
        stored.words = stream.words.map((word) => ({
            raw: word.raw, start: word.start, end: word.end, conf: word.conf,
        }));
    }
    return stored;
}

function withoutWords(record: RawTranscriptRecord): RawTranscriptRecord {
    return {
        ...record,
        omitted: "record_too_large",
        systems: record.systems.map(({ words, ...rest }) => rest),
    };
}
