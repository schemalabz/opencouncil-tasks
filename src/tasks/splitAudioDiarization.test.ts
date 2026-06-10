import { describe, it, expect } from "vitest";
import { buildFfmpegSplitArgs } from "./splitAudioDiarization.js";

// These properties are invisible at runtime: ffmpeg produces identical output
// with -ss after -i or with re-encoding, just orders of magnitude slower on
// long files. A test is the only guard against silently reverting them.
describe("buildFfmpegSplitArgs", () => {
    it("places -ss/-t before -i so ffmpeg seeks instead of decoding from the start", () => {
        const args = buildFfmpegSplitArgs("/in.mp3", "/out.mp3", 3000.5, 60.25);

        expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
        expect(args.indexOf("-t")).toBeLessThan(args.indexOf("-i"));
        expect(args).toEqual(["-y", "-ss", "3000.500", "-t", "60.250", "-i", "/in.mp3", "-c:a", "copy", "/out.mp3"]);
    });

    it("stream-copies instead of re-encoding", () => {
        const args = buildFfmpegSplitArgs("/in.mp3", "/out.mp3", 0, 60);

        expect(args.join(" ")).toContain("-c:a copy");
        expect(args.join(" ")).not.toContain("libmp3lame");
    });
});
