import aws from 'aws-sdk';
import type { AWSError } from 'aws-sdk';
const S3 = aws.S3;
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { Task } from './pipeline.js';
import mime from 'mime/lite';
import { isUsingMinIO } from '../utils.js';
import { spacesKeyForUrl, spacesUrlForKey } from './utils/spacesUrl.js';
dotenv.config();

export interface UploadFilesArgs {
    files: string | string[];
    spacesPath: string;
}

const VERSION = "1";

// Mirrors the `file.pdf -> file_2.pdf -> file_3.pdf` naming convention, and the
// 10-candidate cap, that opencouncil uses for its own uploads.
const MAX_REVISIONS = 10;

export interface ExistingObject {
    contentLength: number;
}

/**
 * Picks the key to write `baseFileName` to, given what's already in the bucket.
 *
 * Same size means the same file, so a re-run reuses it instead of paying for the upload
 * again. A different size means the source produced different bytes under the same name —
 * a livestream VOD re-downloaded after processing finished is longer than the truncated
 * one fetched while it was still `post_live` — and overwriting would destroy the original,
 * so the new content lands on the next revision instead.
 */
export async function resolveUploadKey(
    baseFileName: string,
    localSize: number,
    head: (fileName: string) => Promise<ExistingObject | null>,
): Promise<{ fileName: string; reuse: boolean }> {
    const ext = path.extname(baseFileName);
    const stem = path.basename(baseFileName, ext);

    for (let revision = 1; revision <= MAX_REVISIONS; revision++) {
        const fileName = revision === 1 ? baseFileName : `${stem}_${revision}${ext}`;
        const existing = await head(fileName);
        if (!existing) return { fileName, reuse: false };
        if (existing.contentLength === localSize) return { fileName, reuse: true };
    }

    return { fileName: `${stem}_${crypto.randomUUID()}${ext}`, reuse: false };
}

export function createSpacesClient(): aws.S3 {
    return new S3({
        endpoint: process.env.DO_SPACES_ENDPOINT,
        accessKeyId: process.env.DO_SPACES_KEY,
        secretAccessKey: process.env.DO_SPACES_SECRET,
        region: "fra1",
        // Only add MinIO-specific config when needed
        ...(isUsingMinIO() && {
            s3ForcePathStyle: true,
            signatureVersion: "v4",
        }),
    });
}

/** S3 reports an absent object as a `NotFound` code, or as a bare 404 on some endpoints. */
export function isMissingObjectError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;
    const { code, statusCode } = error as Partial<AWSError>;
    return code === 'NotFound' || statusCode === 404;
}

async function headExistingObject(client: aws.S3, bucket: string, key: string): Promise<ExistingObject | null> {
    try {
        const head = await client.headObject({ Bucket: bucket, Key: key }).promise();
        // A missing ContentLength must never compare equal to a real file size.
        return { contentLength: head.ContentLength ?? -1 };
    } catch (error) {
        if (isMissingObjectError(error)) return null;
        console.error(`Error checking file existence for ${key}:`, error);
        throw error;
    }
}

export async function putPublicFile(client: aws.S3, bucket: string, key: string, localFile: string): Promise<void> {
    const contentType = mime.getType(localFile);
    if (!contentType) {
        throw new Error(`Content type for file ${localFile} not found`);
    }
    await client
        .upload({
            Bucket: bucket,
            Key: key,
            Body: fs.createReadStream(localFile),
            ContentType: contentType,
            ACL: "public-read",
        })
        .promise();
}

/**
 * Overwrite an existing Spaces object in place with a local file, keeping the same URL.
 * Unlike uploadToSpaces, this writes to the exact key derived from `originalUrl` (no
 * version suffix, no spacesPath prefix) and always overwrites. Returns `originalUrl`.
 */
export async function overwriteSpacesObject(originalUrl: string, localFile: string): Promise<string> {
    const key = spacesKeyForUrl(originalUrl);
    const bucketName = process.env.DO_SPACES_BUCKET;
    if (!bucketName) {
        throw new Error("DO_SPACES_BUCKET environment variable is not set");
    }

    await putPublicFile(createSpacesClient(), bucketName, key, localFile);

    console.log(`Overwrote Spaces object ${key} from ${path.basename(localFile)}`);
    return originalUrl;
}

export const uploadToSpaces: Task<UploadFilesArgs, string[]> = async ({ files, spacesPath }, onProgress) => {

    const spacesEndpoint = createSpacesClient();

    const bucketName = process.env.DO_SPACES_BUCKET;

    if (!bucketName) {
        throw new Error('DO_SPACES_BUCKET environment variable is not set');
    }

    const filesToUpload = Array.isArray(files) ? files : [files];
    const uploadedUrls: string[] = [];

    for (let i = 0; i < filesToUpload.length; i++) {
        const file = filesToUpload[i];
        const baseFileName = path.basename(file, path.extname(file)) + `_v${VERSION}` + path.extname(file);

        const { fileName, reuse } = await resolveUploadKey(
            baseFileName,
            fs.statSync(file).size,
            (candidate) => headExistingObject(spacesEndpoint, bucketName, `${spacesPath}/${candidate}`),
        );
        const finalUrl = spacesUrlForKey(`${spacesPath}/${fileName}`);

        if (reuse) {
            console.log(`File ${fileName} already exists with the same size. Skipping upload.`);
            uploadedUrls.push(finalUrl);
            onProgress("uploading", ((i + 1) / filesToUpload.length) * 100);
            continue;
        }
        if (fileName !== baseFileName) {
            console.log(`File ${baseFileName} exists with different content, uploading as ${fileName} instead`);
        }
        try {
            await putPublicFile(spacesEndpoint, bucketName, `${spacesPath}/${fileName}`, file);
            uploadedUrls.push(finalUrl);
            console.log(`Uploaded file ${fileName} to ${finalUrl}`);
            onProgress("uploading", ((i + 1) / filesToUpload.length) * 100);
        } catch (error) {
            console.error(`Error uploading file ${fileName}:`, error);
            throw error;
        }
    }

    return uploadedUrls;
};

export const checkSpacesConnection = async (): Promise<void> => {
    const spacesEndpoint = createSpacesClient();

    const bucketName = process.env.DO_SPACES_BUCKET;
    if (!bucketName) {
        throw new Error('DO_SPACES_BUCKET is not set');
    }

    await spacesEndpoint.headBucket({ Bucket: bucketName }).promise();
};

export const deleteFromSpacesByPrefix = async (prefix: string): Promise<void> => {
    const spacesEndpoint = createSpacesClient();

    const bucketName = process.env.DO_SPACES_BUCKET;
    if (!bucketName) {
        console.warn('Warning: DO_SPACES_BUCKET not set, skipping S3 cleanup');
        return;
    }

    try {
        const listed = await spacesEndpoint.listObjectsV2({
            Bucket: bucketName,
            Prefix: prefix,
        }).promise();

        const objects = listed.Contents;
        if (!objects || objects.length === 0) {
            console.log(`  No objects found with prefix "${prefix}"`);
            return;
        }

        const keys = objects
            .map(obj => obj.Key)
            .filter((key): key is string => key != null);

        console.log(`  Deleting ${keys.length} object(s) with prefix "${prefix}"`);

        await spacesEndpoint.deleteObjects({
            Bucket: bucketName,
            Delete: {
                Objects: keys.map(Key => ({ Key })),
                Quiet: true,
            },
        }).promise();
    } catch (error) {
        console.warn(`Warning: S3 cleanup for prefix "${prefix}" failed: ${error instanceof Error ? error.message : error}`);
    }
};
