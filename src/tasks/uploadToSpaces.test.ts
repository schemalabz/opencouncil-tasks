import { describe, it, expect, vi, afterEach } from "vitest";
import type aws from "aws-sdk";
import fs from "fs";
import { Readable } from "stream";
import { putPublicFile } from "./uploadToSpaces.js";

describe("putPublicFile", () => {
    afterEach(() => vi.restoreAllMocks());

    it("uploads the file to the given key as public-read with a derived content-type", async () => {
        vi.spyOn(fs, "createReadStream").mockReturnValue(Readable.from(["data"]) as unknown as fs.ReadStream);
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
            }),
        );
    });
});
