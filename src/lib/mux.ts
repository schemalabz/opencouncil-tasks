import dotenv from "dotenv";
import { isUsingMinIO } from "../utils.js";

dotenv.config();

const MUX_TOKEN_ID = process.env.MUX_TOKEN_ID;
const MUX_TOKEN_SECRET = process.env.MUX_TOKEN_SECRET;

// Generate a mock MUX playback ID
const generateMockPlaybackId = (): string => {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `MOCK_${timestamp}_${random}`;
};

export const getMuxPlaybackId = async (videoUrl: string) => {
    // If using MinIO, return a mock playback ID
    if (isUsingMinIO()) {
        const mockId = generateMockPlaybackId();
        console.log(`Using MinIO - generating mock MUX playback ID: ${mockId}`);
        return mockId;
    }

    // Otherwise, use real MUX API
    if (!MUX_TOKEN_ID || !MUX_TOKEN_SECRET) {
        throw new Error("MUX_TOKEN_ID or MUX_TOKEN_SECRET is not set");
    }

    const authHeader = `Basic ${Buffer.from(`${MUX_TOKEN_ID}:${MUX_TOKEN_SECRET}`).toString("base64")}`;

    const response = await fetch("https://api.mux.com/video/v1/assets", {
        method: "POST",
        body: JSON.stringify({ input: videoUrl, playback_policy: ["public"], video_quality: "basic" }),
        headers: {
            "Content-Type": "application/json",
            Authorization: authHeader,
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

    await pollAssetStatus(assetId, authHeader);

    return playbackId;
};

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 10 * 60 * 1_000; // 10 minutes

async function pollAssetStatus(assetId: string, authHeader: string): Promise<void> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
        const res = await fetch(`https://api.mux.com/video/v1/assets/${assetId}`, {
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