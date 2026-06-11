import { describe, it, expect } from "vitest";
import { buildFfmpegSplitArgs, segmentFileName } from "./splitAudioDiarization.js";

describe("segmentFileName", () => {
    it("embeds the time range so different segmentations get different names", () => {
        // uploadToSpaces skips uploading when the derived key already exists,
        // so a name collision across runs silently serves stale audio
        const hourly = segmentFileName("vid_segment_1", 3600, 7200);
        const quarterly = segmentFileName("vid_segment_1", 900, 1800);

        expect(hourly).toBe("vid_segment_1_3600-7200.mp3");
        expect(quarterly).toBe("vid_segment_1_900-1800.mp3");
        expect(hourly).not.toBe(quarterly);
    });

    it("rounds fractional silence-derived boundaries", () => {
        expect(segmentFileName("vid_segment_0", 0, 887.4)).toBe("vid_segment_0_0-887.mp3");
    });
});

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

    it("stream-copies mp3 input instead of re-encoding", () => {
        const args = buildFfmpegSplitArgs("/in.mp3", "/out.mp3", 0, 60);

        expect(args.join(" ")).toContain("-c:a copy");
        expect(args.join(" ")).not.toContain("libmp3lame");
    });

    it("re-encodes non-mp3 input, which cannot be stream-copied into an mp3 container", () => {
        const args = buildFfmpegSplitArgs("/in.wav", "/out.mp3", 0, 60);

        expect(args.join(" ")).toContain("-acodec libmp3lame");
        expect(args.join(" ")).not.toContain("copy");
    });
});
