import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type aws from 'aws-sdk';
import type { RunEnv } from '../telemetry/context.js';
import { getDataDir } from '../dataDir.js';
import { createSpacesClient, isMissingObjectError } from '../../tasks/uploadToSpaces.js';

export interface ArchiveStore {
    readonly url: string;
    put(key: string, body: Buffer | string, contentType?: string): Promise<void>;
    /** null when absent */
    get(key: string): Promise<Buffer | null>;
    exists(key: string): Promise<boolean>;
    /** Full keys relative to the store root, in lexicographic order. */
    list(prefix: string): AsyncIterable<string>;
}

type S3Call<P, R> = (params: P) => { promise(): Promise<R> };

/** The slice of the aws-sdk v2 S3 client the archive uses. */
export interface S3Like {
    putObject: S3Call<aws.S3.PutObjectRequest, unknown>;
    getObject: S3Call<aws.S3.GetObjectRequest, Pick<aws.S3.GetObjectOutput, 'Body'>>;
    headObject: S3Call<aws.S3.HeadObjectRequest, unknown>;
    listObjectsV2: S3Call<aws.S3.ListObjectsV2Request, Pick<aws.S3.ListObjectsV2Output, 'Contents' | 'NextContinuationToken'>>;
}

const TMP_SUFFIX = /\.tmp-[0-9a-f]{16}$/;

export function fsStore(dir: string): ArchiveStore {
    const root = path.resolve(dir);
    const fileFor = (key: string): string => {
        const file = path.resolve(root, key);
        // Keys are often derived from external ids; one with `..` must not write outside the archive.
        if (!file.startsWith(root + path.sep)) throw new Error(`Archive key escapes the store: ${key}`);
        return file;
    };

    async function* walk(relDir: string, prefix: string): AsyncGenerator<string> {
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(path.join(root, relDir), { withFileTypes: true });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
            throw error;
        }
        // Sorting directories as `name/` makes the depth-first walk come out in full-key order
        // (`a/b.txt` sorts before `a/b/x`).
        const sorted = entries
            .map(e => ({ e, sortKey: e.isDirectory() ? `${e.name}/` : e.name }))
            .sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
        for (const { e } of sorted) {
            const key = relDir ? `${relDir}/${e.name}` : e.name;
            if (e.isDirectory()) {
                const asDir = `${key}/`;
                if (asDir.startsWith(prefix) || prefix.startsWith(asDir)) yield* walk(key, prefix);
            } else if (e.isFile() && key.startsWith(prefix) && !TMP_SUFFIX.test(e.name)) {
                yield key;
            }
        }
    }

    return {
        url: `file://${dir}`,
        async put(key, body) {
            const file = fileFor(key);
            await fs.promises.mkdir(path.dirname(file), { recursive: true });
            const tmp = `${file}.tmp-${crypto.randomBytes(8).toString('hex')}`;
            try {
                await fs.promises.writeFile(tmp, body);
                await fs.promises.rename(tmp, file);
            } catch (error) {
                await fs.promises.rm(tmp, { force: true });
                throw error;
            }
        },
        async get(key) {
            try {
                return await fs.promises.readFile(fileFor(key));
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
                throw error;
            }
        },
        async exists(key) {
            try {
                return (await fs.promises.stat(fileFor(key))).isFile();
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
                throw error;
            }
        },
        list(prefix) {
            const slash = prefix.lastIndexOf('/');
            return walk(slash === -1 ? '' : prefix.slice(0, slash), prefix);
        },
    };
}

function defaultArchiveS3Client(): S3Like {
    const endpoint = process.env.ARCHIVE_S3_ENDPOINT ?? process.env.DO_SPACES_ENDPOINT;
    return createSpacesClient({
        endpoint,
        key: process.env.ARCHIVE_S3_KEY ?? process.env.DO_SPACES_KEY,
        secret: process.env.ARCHIVE_S3_SECRET ?? process.env.DO_SPACES_SECRET,
        forcePathStyle: endpoint !== undefined && !endpoint.includes('digitaloceanspaces.com'),
    });
}

function toBuffer(body: aws.S3.Body | undefined): Buffer {
    if (body === undefined) return Buffer.alloc(0);
    if (Buffer.isBuffer(body)) return body;
    if (typeof body === 'string' || body instanceof Uint8Array) return Buffer.from(body);
    throw new Error('Unsupported S3 body type');
}

export function s3Store(bucket: string, client: S3Like = defaultArchiveS3Client()): ArchiveStore {
    return {
        url: `s3://${bucket}`,
        async put(key, body, contentType) {
            await client.putObject({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }).promise();
        },
        async get(key) {
            try {
                return toBuffer((await client.getObject({ Bucket: bucket, Key: key }).promise()).Body);
            } catch (error) {
                if (isMissingObjectError(error)) return null;
                throw error;
            }
        },
        async exists(key) {
            try {
                await client.headObject({ Bucket: bucket, Key: key }).promise();
                return true;
            } catch (error) {
                if (isMissingObjectError(error)) return false;
                throw error;
            }
        },
        async *list(prefix) {
            let token: string | undefined;
            do {
                const page = await client
                    .listObjectsV2({ Bucket: bucket, Prefix: prefix, ContinuationToken: token })
                    .promise();
                for (const obj of page.Contents ?? []) {
                    if (obj.Key) yield obj.Key;
                }
                token = page.NextContinuationToken;
            } while (token);
        },
    };
}

const opened = new Map<string, ArchiveStore>();

/**
 * The archive that runs and responses are written to: only one set explicitly. The
 * file default suits reading on a dev machine, but a server writing every call to its
 * own disk would fill it.
 */
export function configuredArchive(): ArchiveStore | null {
    return process.env.ARCHIVE_URL ? openArchive() : null;
}

export function openArchive(url?: string): ArchiveStore {
    const resolved = url ?? process.env.ARCHIVE_URL ?? `file://${getDataDir()}/archive`;
    const cached = opened.get(resolved);
    if (cached) return cached;

    let store: ArchiveStore;
    if (resolved.startsWith('file://')) {
        store = fsStore(resolved.slice('file://'.length));
    } else if (resolved.startsWith('s3://')) {
        const bucket = resolved.slice('s3://'.length).replace(/\/+$/, '');
        if (!bucket) throw new Error(`Archive URL has no bucket: ${resolved}`);
        // The SDK would put objects into the bucket before the slash under a key prefix, while listing failed.
        if (bucket.includes('/')) throw new Error(`Archive URL must be s3://<bucket>, with no key prefix: ${resolved}`);
        store = s3Store(bucket);
    } else {
        throw new Error(`Unsupported archive URL (expected file:// or s3://): ${resolved}`);
    }
    opened.set(resolved, store);
    return store;
}

const datePath = (date: Date): string => {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}`;
};

const shard = (id: string): string => `${id.slice(0, 2)}/${id}`;

export const archiveKeys = {
    calls: (env: RunEnv, date: Date, taskType: string, traceId: string): string =>
        `${env}/calls/${datePath(date)}/${taskType}/${traceId}.jsonl.gz`,
    /** Body is the calls key. */
    traceIndex: (traceId: string): string => `traces/${traceId}`,
    /**
     * Shared by every environment: an identical request has an interchangeable answer.
     * Each recording is its own immutable object (names sort by recording time), so a
     * repeated sample never overwrites the one another run depends on.
     */
    responsePrefix: (cacheKey: string): string => `responses/${shard(cacheKey)}/`,
    response: (cacheKey: string, recordedAt: string, callId: string): string =>
        `responses/${shard(cacheKey)}/${recordedAt.replace(/[:.]/g, '-')}_${callId}.json`,
    blob: (sha256: string): string => `blobs/sha256/${shard(sha256)}`,
    /** Body is the content sha256. */
    blobByUrl: (urlSha256: string): string => `blobs/by-url/${shard(urlSha256)}`,
    run: (suite: string, runId: string, file: string): string => `runs/${suite}/${runId}/${file}`,
    checks: (env: RunEnv, date: Date, traceId: string): string => `${env}/checks/${datePath(date)}/${traceId}.jsonl`,
    checksDay: (env: RunEnv, date: Date): string => `${env}/checks/${datePath(date)}/`,
    candidate: (suite: string, id: string): string => `candidates/${suite}/${id}.json`,
    review: (batchId: string, file: string): string => `reviews/${batchId}/${file}`,
    /** Pairwise preferences settled in one review batch, as JSONL. */
    preferences: (suite: string, batchId: string): string => `preferences/${suite}/${batchId}.jsonl`,
};
