import { describe, it, expect, vi, afterEach } from "vitest";
import type aws from "aws-sdk";
import fs from "fs";
import { Readable } from "stream";
import { isMissingObjectError, putPublicFile, resolveUploadKey } from "./uploadToSpaces.js";

describe("putPublicFile", () => {
    afterEach(() => vi.restoreAllMocks());

    it("uploads the file stream to the given key as public-read with a derived content-type", async () => {
        const stream = Readable.from(["data"]) as unknown as fs.ReadStream;
        vi.spyOn(fs, "createReadStream").mockReturnValue(stream);
        const upload = vi.fn(() => ({ promise: () => Promise.resolve() }));
        const fakeClient = { upload } as unknown as aws.S3;

        await putPublicFile(fakeClient, "my-bucket", "uploads/a.mp4", "/tmp/a.mp4");

        expect(fs.createReadStream).toHaveBeenCalledWith("/tmp/a.mp4");
        expect(upload).toHaveBeenCalledOnce();
        expect(upload).toHaveBeenCalledWith(
            expect.objectContaining({
                Bucket: "my-bucket",
                Key: "uploads/a.mp4",
                ACL: "public-read",
                ContentType: "video/mp4",
                Body: stream,
            }),
        );
    });

    it("throws (without touching the filesystem) when the content-type can't be derived", async () => {
        const createReadStream = vi.spyOn(fs, "createReadStream");
        const upload = vi.fn(() => ({ promise: () => Promise.resolve() }));
        const fakeClient = { upload } as unknown as aws.S3;

        await expect(putPublicFile(fakeClient, "my-bucket", "k", "/tmp/no-extension")).rejects.toThrow(
            /Content type/,
        );
        expect(createReadStream).not.toHaveBeenCalled();
        expect(upload).not.toHaveBeenCalled();
    });
});

describe("resolveUploadKey", () => {
    // Probe stub: maps fileName -> byte size of the object already in the bucket.
    const bucketWith = (objects: Record<string, number>) =>
        async (fileName: string) =>
            fileName in objects ? { contentLength: objects[fileName] } : null;

    it("uses the base name when nothing is in the bucket yet", async () => {
        const result = await resolveUploadKey("vid_v1.mp4", 100, bucketWith({}));

        expect(result).toEqual({ fileName: "vid_v1.mp4", reuse: false });
    });

    it("reuses an existing object of the same size, so retries don't re-upload", async () => {
        const result = await resolveUploadKey("vid_v1.mp4", 100, bucketWith({ "vid_v1.mp4": 100 }));

        expect(result).toEqual({ fileName: "vid_v1.mp4", reuse: true });
    });

    it("allocates the next suffix when the existing object holds different content", async () => {
        const result = await resolveUploadKey("vid_v1.mp4", 200, bucketWith({ "vid_v1.mp4": 100 }));

        expect(result).toEqual({ fileName: "vid_v1_2.mp4", reuse: false });
    });

    it("reuses a later revision whose size matches rather than allocating another", async () => {
        const bucket = bucketWith({ "vid_v1.mp4": 100, "vid_v1_2.mp4": 200 });

        const result = await resolveUploadKey("vid_v1.mp4", 200, bucket);

        expect(result).toEqual({ fileName: "vid_v1_2.mp4", reuse: true });
    });

    it("falls back to a unique name once the suffix range is exhausted", async () => {
        const taken: Record<string, number> = { "vid_v1.mp4": 1 };
        for (let n = 2; n <= 10; n++) taken[`vid_v1_${n}.mp4`] = n;

        const result = await resolveUploadKey("vid_v1.mp4", 999, bucketWith(taken));

        expect(result.reuse).toBe(false);
        expect(result.fileName).not.toBe("vid_v1.mp4");
        expect(result.fileName).toMatch(/\.mp4$/);
        expect(taken[result.fileName]).toBeUndefined();
    });
});

describe("isMissingObjectError", () => {
    // This classification decides between "upload fresh" and "abort the task":
    // a wrong answer here makes every upload fail on its first head probe.
    it("accepts the SDK NotFound code and any bare 404", () => {
        expect(isMissingObjectError({ code: "NotFound" })).toBe(true);
        expect(isMissingObjectError({ statusCode: 404 })).toBe(true);
        expect(isMissingObjectError({ code: "NoSuchBucket", statusCode: 404 })).toBe(true);
    });

    it("rejects everything else", () => {
        expect(isMissingObjectError({ statusCode: 500 })).toBe(false);
        expect(isMissingObjectError({ code: "AccessDenied", statusCode: 403 })).toBe(false);
        expect(isMissingObjectError(new Error("network down"))).toBe(false);
        expect(isMissingObjectError(null)).toBe(false);
        expect(isMissingObjectError(undefined)).toBe(false);
    });
});
