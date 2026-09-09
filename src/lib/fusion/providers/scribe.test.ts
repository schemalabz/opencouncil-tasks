import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const publishMock = vi.fn();

vi.mock("../audio.js", () => ({
    ensurePublicUrl: (...args: unknown[]) => publishMock(...args),
}));

const transcribeRaw = vi.fn(async () => ({ response: { text: "", words: [] } }));

vi.mock("../../ScribeTranscribe.js", () => ({
    scribeTranscriber: { transcribeRaw: (...args: unknown[]) => transcribeRaw(...(args as [])) },
    logprobToConfidence: () => null,
}));

const { ScribeProvider } = await import("./scribe.js");

/**
 * A segment that arrived as an upload has bytes and no URL. Scribe is the one
 * provider that cannot fetch it, so if the transport says "url" someone has to
 * publish it first — the other two providers already do.
 */
const uploaded = { sha256: "a".repeat(64), path: "/tmp/segment.wav", bytes: 1234 } as any;

const ctx = (transport: "url" | "bytes") => ({
    transport,
    label: "segment 1/1",
    signal: new AbortController().signal,
}) as any;

beforeEach(() => {
    publishMock.mockReset();
    transcribeRaw.mockClear();
});

afterEach(() => vi.restoreAllMocks());

describe("ScribeProvider audio transport", () => {
    it("publishes an uploaded segment instead of failing on the missing URL", async () => {
        const release = vi.fn(async () => { });
        publishMock.mockResolvedValue({ url: "https://cdn.example.com/fusion-tmp/a.wav", release });

        await new ScribeProvider("el" as any).transcribe(uploaded, ctx("url"));

        expect(publishMock).toHaveBeenCalledOnce();
        expect(transcribeRaw).toHaveBeenCalledWith(expect.objectContaining({
            audioUrl: "https://cdn.example.com/fusion-tmp/a.wav",
        }));
        // Published for one call, so it has to be taken down after it.
        expect(release).toHaveBeenCalledOnce();
    });

    it("releases the published copy even when the call fails", async () => {
        const release = vi.fn(async () => { });
        publishMock.mockResolvedValue({ url: "https://cdn.example.com/fusion-tmp/a.wav", release });
        transcribeRaw.mockRejectedValueOnce(new Error("502 from vendor"));

        await expect(new ScribeProvider("el" as any).transcribe(uploaded, ctx("url"))).rejects.toThrow();
        expect(release).toHaveBeenCalledOnce();
    });

    it("uses the canonical URL as it is, publishing nothing", async () => {
        const withUrl = { ...uploaded, canonicalUrl: "https://cdn.example.com/audio-0.wav" };

        await new ScribeProvider("el" as any).transcribe(withUrl, ctx("url"));

        expect(publishMock).not.toHaveBeenCalled();
        expect(transcribeRaw).toHaveBeenCalledWith(expect.objectContaining({
            audioUrl: "https://cdn.example.com/audio-0.wav",
        }));
    });

    it("still refuses byte transport with no local path", async () => {
        await expect(new ScribeProvider("el" as any).transcribe({ sha256: "b".repeat(64) } as any, ctx("bytes")))
            .rejects.toMatchObject({ reason: "no_audio_path" });
    });
});
