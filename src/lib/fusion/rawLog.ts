import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";
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

/** Default valve, not a routine path: a 20-minute segment is about 0.6 MB. */
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

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
}

export class RawTranscriptLog {
    private readonly dir?: string;
    private readonly maxBytes: number;
    private warned = false;

    constructor(dir: string | undefined, options: RawTranscriptLogOptions = {}) {
        this.dir = dir?.trim() || undefined;
        this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
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
            let body = JSON.stringify(record, null, 2);
            if (Buffer.byteLength(body, "utf8") > this.maxBytes) {
                // Explicit marker, never a silent shortening: a record with
                // half a transcript in it would read as a complete one.
                body = JSON.stringify(withoutWords(record), null, 2);
            }

            // The name carries only hashes and an id. No word ever reaches a
            // filename, where it would show up in every directory listing and
            // every backup manifest.
            file = path.join(dir, `${attempt.audioSha256}.${attempt.attemptId}.json`);
            await fsp.mkdir(dir, { recursive: true });
            const tmp = `${file}.${crypto.randomBytes(4).toString("hex")}.tmp`;
            await fsp.writeFile(tmp, body, "utf8");
            await fsp.rename(tmp, file);
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
