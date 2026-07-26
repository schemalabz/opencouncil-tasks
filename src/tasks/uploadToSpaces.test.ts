import { describe, it, expect, vi, afterEach } from "vitest";
import type aws from "aws-sdk";
import fs from "fs";
import { Readable } from "stream";
import { putPublicFile } from "./uploadToSpaces.js";

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
