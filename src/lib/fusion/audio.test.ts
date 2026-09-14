import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { artifactFromUrl } from "./audio.js";

describe("artifactFromUrl", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "audio-test-"));
    });
    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const leftBehind = () => fs.readdirSync(tmpDir).filter((n) => n.startsWith("oc-fusion-audio-"));

    it("leaves no temp directory behind when the url will not parse", async () => {
        // The extension came off `new URL(url).pathname` after the temp
        // directory existed and before the `try` that removes it, so a
        // malformed url leaked a directory per call. Nothing retries a
        // malformed url, so the leak was permanent.
        await expect(artifactFromUrl("this is not a url", { tmpDir })).rejects.toThrow();
        expect(leftBehind()).toEqual([]);
    });
});
