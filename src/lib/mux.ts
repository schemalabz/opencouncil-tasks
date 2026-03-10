import dotenv from "dotenv";

dotenv.config();

const MUX_ASSETS_URL = "https://api.mux.com/video/v1/assets";

export type MuxResult = { playbackId: string; assetId: string };

function getMuxCredentials(): { authHeader: string } | null {
    const tokenId = process.env.MUX_TOKEN_ID;
    const tokenSecret = process.env.MUX_TOKEN_SECRET;
    if (!tokenId || !tokenSecret) return null;
    return {
        authHeader: `Basic ${Buffer.from(`${tokenId}:${tokenSecret}`).toString("base64")}`,
    };
}

export function hasMuxCredentials(): boolean {
    return getMuxCredentials() !== null;
}

// Generate a mock MUX playback ID
const generateMockId = (prefix: string): string => {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `${prefix}_${timestamp}_${random}`;
};

/**
 * Create a Mux asset and return the playback ID + asset ID immediately,
 * without waiting for the asset to become ready.
 */
export const createMuxAsset = async (videoUrl: string): Promise<MuxResult> => {
    const creds = getMuxCredentials();

    // If no Mux credentials, return mock IDs
    if (!creds) {
        const mockPlaybackId = generateMockId("MOCK");
        const mockAssetId = generateMockId("MOCK_ASSET");
        console.log(`No Mux credentials - generating mock IDs: ${mockPlaybackId}`);
        return { playbackId: mockPlaybackId, assetId: mockAssetId };
    }

    const response = await fetch(MUX_ASSETS_URL, {
        method: "POST",
        body: JSON.stringify({ input: videoUrl, playback_policy: ["public"], video_quality: "basic" }),
        headers: {
            "Content-Type": "application/json",
            Authorization: creds.authHeader,
        },
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Mux asset creation failed (HTTP ${response.status}): ${body}`);
    }

    const data = await response.json();
    const assetId: string = data.data.id;
    const playbackId: string = data.data.playback_ids[0].id;
    console.log(`Mux asset created: ${assetId}, playback ID: ${playbackId}`);

    return { playbackId, assetId };
};

export const deleteMuxAsset = async (assetId: string): Promise<void> => {
    const creds = getMuxCredentials();
    if (!creds) return;

    const response = await fetch(`${MUX_ASSETS_URL}/${assetId}`, {
        method: "DELETE",
        headers: { Authorization: creds.authHeader },
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Mux asset deletion failed (HTTP ${response.status}): ${body}`);
    }

    console.log(`Mux asset deleted: ${assetId}`);
};
