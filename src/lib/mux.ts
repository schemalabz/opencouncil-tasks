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

    const response = await fetch("https://api.mux.com/video/v1/assets", {
        method: "POST",
        body: JSON.stringify({ input: videoUrl, playback_policy: ["public"], video_quality: "basic" }),
        headers: {
            "Content-Type": "application/json",
            Authorization: `Basic ${Buffer.from(`${MUX_TOKEN_ID}:${MUX_TOKEN_SECRET}`).toString("base64")}`,
        },
    });
    const data = await response.json();
    console.log("Got Mux asset", data);
    return data.data.playback_ids[0].id;
}; 