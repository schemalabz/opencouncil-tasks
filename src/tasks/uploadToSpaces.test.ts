import { describe, it, expect, vi, afterEach } from "vitest";
import type aws from "aws-sdk";
import fs from "fs";
import { Readable } from "stream";
import { putPublicFile, parseSpacesObjectKey } from "./uploadToSpaces.js";

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

describe("parseSpacesObjectKey", () => {
    it("origin URL → key without leading slash", () => {
        expect(
            parseSpacesObjectKey(
                "https://townhalls-gr.fra1.digitaloceanspaces.com/uploads/vrilissia_jul22_2_2026_recording.mp4",
            ),
        ).toBe("uploads/vrilissia_jul22_2_2026_recording.mp4");
    });

    it("strips a query string (e.g. presigned params)", () => {
        expect(
            parseSpacesObjectKey(
                "https://townhalls-gr.fra1.digitaloceanspaces.com/uploads/a.mp4?X-Amz-Signature=xyz",
            ),
        ).toBe("uploads/a.mp4");
    });

    it("cdn edge host resolves to the same key", () => {
        expect(
            parseSpacesObjectKey(
                "https://townhalls-gr.fra1.cdn.digitaloceanspaces.com/uploads/a.mp4",
            ),
        ).toBe("uploads/a.mp4");
    });

    it("percent-decodes the path", () => {
        expect(
            parseSpacesObjectKey(
                "https://townhalls-gr.fra1.digitaloceanspaces.com/uploads/my%20file.mp4",
            ),
        ).toBe("uploads/my file.mp4");
    });

    it("throws when the URL has no object key", () => {
        expect(() =>
            parseSpacesObjectKey("https://townhalls-gr.fra1.digitaloceanspaces.com/"),
        ).toThrow();
    });

    it("strips a path-prefixed SPACES_PUBLIC_URL (e.g. the dev proxy) to get the real key", () => {
        const prev = process.env.SPACES_PUBLIC_URL;
        process.env.SPACES_PUBLIC_URL = "https://abc123.ngrok.app/dev/files/opencouncil-dev";
        try {
            expect(
                parseSpacesObjectKey(
                    "https://abc123.ngrok.app/dev/files/opencouncil-dev/uploads/vrilissia.mp4",
                ),
            ).toBe("uploads/vrilissia.mp4");
        } finally {
            process.env.SPACES_PUBLIC_URL = prev;
        }
    });
});
