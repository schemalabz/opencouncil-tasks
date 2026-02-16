import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// vi.hoisted runs before imports — set env vars for the "has credentials" tests
const { savedTokenId, savedTokenSecret } = vi.hoisted(() => {
    const savedTokenId = process.env.MUX_TOKEN_ID;
    const savedTokenSecret = process.env.MUX_TOKEN_SECRET;
    process.env.MUX_TOKEN_ID = "test-token-id";
    process.env.MUX_TOKEN_SECRET = "test-token-secret";
    return { savedTokenId, savedTokenSecret };
});

import { getMuxPlaybackId, deleteMuxAsset } from "./mux.js";

function createResponse(ok: boolean, body: unknown, status?: number): Response {
    return {
        ok,
        status: status ?? (ok ? 200 : 500),
        json: async () => body,
        text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    } as Response;
}

const MUX_ASSET = {
    data: { id: "asset-123", playback_ids: [{ id: "playback-abc" }] },
};

describe("getMuxPlaybackId", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let fetchSpy: any;

    beforeEach(() => {
        fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unmocked fetch"));
        process.env.MUX_TOKEN_ID = "test-token-id";
        process.env.MUX_TOKEN_SECRET = "test-token-secret";
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
        // Restore original env vars
        if (savedTokenId !== undefined) process.env.MUX_TOKEN_ID = savedTokenId;
        else delete process.env.MUX_TOKEN_ID;
        if (savedTokenSecret !== undefined) process.env.MUX_TOKEN_SECRET = savedTokenSecret;
        else delete process.env.MUX_TOKEN_SECRET;
    });

    it("returns mock result when credentials are missing", async () => {
        delete process.env.MUX_TOKEN_ID;
        delete process.env.MUX_TOKEN_SECRET;

        const result = await getMuxPlaybackId("https://example.com/video.mp4");

        expect(result.playbackId).toMatch(/^MOCK_/);
        expect(result.assetId).toMatch(/^MOCK_ASSET_/);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("throws on non-OK POST response", async () => {
        fetchSpy.mockResolvedValueOnce(createResponse(false, "Bad Request", 400));

        await expect(getMuxPlaybackId("https://example.com/video.mp4"))
            .rejects.toThrow("Mux asset creation failed (HTTP 400): Bad Request");
    });

    it("returns MuxResult when asset is immediately ready", async () => {
        fetchSpy
            .mockResolvedValueOnce(createResponse(true, MUX_ASSET))
            .mockResolvedValueOnce(createResponse(true, { data: { status: "ready" } }));

        const result = await getMuxPlaybackId("https://example.com/video.mp4");

        expect(result).toEqual({ playbackId: "playback-abc", assetId: "asset-123" });
        expect(fetchSpy).toHaveBeenCalledTimes(2);

        // Verify POST request
        const [postUrl, postInit] = fetchSpy.mock.calls[0];
        expect(postUrl).toBe("https://api.mux.com/video/v1/assets");
        expect((postInit as RequestInit).method).toBe("POST");

        // Verify GET polling request
        const [getUrl] = fetchSpy.mock.calls[1];
        expect(getUrl).toBe("https://api.mux.com/video/v1/assets/asset-123");
    });

    it("polls until asset becomes ready", async () => {
        vi.useFakeTimers();

        fetchSpy
            .mockResolvedValueOnce(createResponse(true, MUX_ASSET))
            .mockResolvedValueOnce(createResponse(true, { data: { status: "preparing" } }))
            .mockResolvedValueOnce(createResponse(true, { data: { status: "preparing" } }))
            .mockResolvedValueOnce(createResponse(true, { data: { status: "ready" } }));

        const promise = getMuxPlaybackId("https://example.com/video.mp4");
        await vi.advanceTimersByTimeAsync(5_000);
        await vi.advanceTimersByTimeAsync(5_000);

        const result = await promise;
        expect(result).toEqual({ playbackId: "playback-abc", assetId: "asset-123" });
        expect(fetchSpy).toHaveBeenCalledTimes(4); // 1 POST + 3 GETs
    });

    it("throws when asset status is errored", async () => {
        fetchSpy
            .mockResolvedValueOnce(createResponse(true, MUX_ASSET))
            .mockResolvedValueOnce(createResponse(true, {
                data: { status: "errored", errors: { messages: ["unsupported codec"] } },
            }));

        await expect(getMuxPlaybackId("https://example.com/video.mp4"))
            .rejects.toThrow("Mux asset asset-123 errored");
    });

    it("throws on non-OK GET during polling", async () => {
        fetchSpy
            .mockResolvedValueOnce(createResponse(true, MUX_ASSET))
            .mockResolvedValueOnce(createResponse(false, "Internal Server Error", 500));

        await expect(getMuxPlaybackId("https://example.com/video.mp4"))
            .rejects.toThrow("Mux asset status check failed (HTTP 500)");
    });

    it("throws after polling timeout", async () => {
        vi.useFakeTimers();

        // POST succeeds, all GETs return "preparing" forever
        fetchSpy
            .mockResolvedValueOnce(createResponse(true, MUX_ASSET))
            .mockImplementation(async () => createResponse(true, { data: { status: "preparing" } }));

        const promise = getMuxPlaybackId("https://example.com/video.mp4");
        // Attach rejection handler before advancing timers to avoid unhandled rejection
        const assertion = expect(promise).rejects.toThrow("did not become ready within 10 minutes");
        await vi.advanceTimersByTimeAsync(10 * 60 * 1_000 + 1);
        await assertion;
    });
});

describe("deleteMuxAsset", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let fetchSpy: any;

    beforeEach(() => {
        fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unmocked fetch"));
        process.env.MUX_TOKEN_ID = "test-token-id";
        process.env.MUX_TOKEN_SECRET = "test-token-secret";
    });

    afterEach(() => {
        vi.restoreAllMocks();
        if (savedTokenId !== undefined) process.env.MUX_TOKEN_ID = savedTokenId;
        else delete process.env.MUX_TOKEN_ID;
        if (savedTokenSecret !== undefined) process.env.MUX_TOKEN_SECRET = savedTokenSecret;
        else delete process.env.MUX_TOKEN_SECRET;
    });

    it("deletes the asset successfully", async () => {
        fetchSpy.mockResolvedValueOnce(createResponse(true, "", 204));

        await deleteMuxAsset("asset-123");

        expect(fetchSpy).toHaveBeenCalledOnce();
        const [url, init] = fetchSpy.mock.calls[0];
        expect(url).toBe("https://api.mux.com/video/v1/assets/asset-123");
        expect((init as RequestInit).method).toBe("DELETE");
    });

    it("skips deletion when no credentials", async () => {
        delete process.env.MUX_TOKEN_ID;
        delete process.env.MUX_TOKEN_SECRET;

        await deleteMuxAsset("asset-123");

        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("throws on non-OK response", async () => {
        fetchSpy.mockResolvedValueOnce(createResponse(false, "Not Found", 404));

        await expect(deleteMuxAsset("asset-123"))
            .rejects.toThrow("Mux asset deletion failed (HTTP 404): Not Found");
    });
});
