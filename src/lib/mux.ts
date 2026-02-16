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

export const getMuxPlaybackId = async (videoUrl: string): Promise<MuxResult> => {
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

    await pollAssetStatus(assetId, creds.authHeader);

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

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 10 * 60 * 1_000; // 10 minutes

async function pollAssetStatus(assetId: string, authHeader: string): Promise<void> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
        const res = await fetch(`${MUX_ASSETS_URL}/${assetId}`, {
            headers: { Authorization: authHeader },
        });

        if (!res.ok) {
            const body = await res.text();
            throw new Error(`Mux asset status check failed (HTTP ${res.status}): ${body}`);
        }

        const json = await res.json();
        const status: string = json.data.status;
        console.log(`Mux asset ${assetId} status: ${status}`);

        if (status === "ready") return;
        if (status === "errored") {
            throw new Error(`Mux asset ${assetId} errored: ${JSON.stringify(json.data.errors)}`);
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    throw new Error(`Mux asset ${assetId} did not become ready within ${POLL_TIMEOUT_MS / 60_000} minutes`);
}
