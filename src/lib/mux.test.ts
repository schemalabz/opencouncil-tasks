import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// vi.hoisted runs before imports — set env vars for the "has credentials" tests
const { savedTokenId, savedTokenSecret } = vi.hoisted(() => {
    const savedTokenId = process.env.MUX_TOKEN_ID;
    const savedTokenSecret = process.env.MUX_TOKEN_SECRET;
    process.env.MUX_TOKEN_ID = "test-token-id";
    process.env.MUX_TOKEN_SECRET = "test-token-secret";
    return { savedTokenId, savedTokenSecret };
});

import { createMuxAsset, deleteMuxAsset } from "./mux.js";

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

describe("createMuxAsset", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let fetchSpy: any;

    beforeEach(() => {
        fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unmocked fetch"));
        process.env.MUX_TOKEN_ID = "test-token-id";
        process.env.MUX_TOKEN_SECRET = "test-token-secret";
    });

    afterEach(() => {
        vi.restoreAllMocks();
        // Restore original env vars
        if (savedTokenId !== undefined) process.env.MUX_TOKEN_ID = savedTokenId;
        else delete process.env.MUX_TOKEN_ID;
        if (savedTokenSecret !== undefined) process.env.MUX_TOKEN_SECRET = savedTokenSecret;
        else delete process.env.MUX_TOKEN_SECRET;
    });

    it("returns mock result when credentials are missing", async () => {
        delete process.env.MUX_TOKEN_ID;
        delete process.env.MUX_TOKEN_SECRET;

        const result = await createMuxAsset("https://example.com/video.mp4");

        expect(result.playbackId).toMatch(/^MOCK_/);
        expect(result.assetId).toMatch(/^MOCK_ASSET_/);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("throws on non-OK POST response", async () => {
        fetchSpy.mockResolvedValueOnce(createResponse(false, "Bad Request", 400));

        await expect(createMuxAsset("https://example.com/video.mp4"))
            .rejects.toThrow("Mux asset creation failed (HTTP 400): Bad Request");
    });

    it("returns playback ID and asset ID immediately", async () => {
        fetchSpy.mockResolvedValueOnce(createResponse(true, MUX_ASSET));

        const result = await createMuxAsset("https://example.com/video.mp4");

        expect(result).toEqual({ playbackId: "playback-abc", assetId: "asset-123" });
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        // Verify POST request
        const [postUrl, postInit] = fetchSpy.mock.calls[0];
        expect(postUrl).toBe("https://api.mux.com/video/v1/assets");
        expect((postInit as RequestInit).method).toBe("POST");
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
