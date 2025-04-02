import dotenv from "dotenv";

dotenv.config();

const MUX_TOKEN_ID = process.env.MUX_TOKEN_ID;
const MUX_TOKEN_SECRET = process.env.MUX_TOKEN_SECRET;

export const getMuxPlaybackId = async (videoUrl: string) => {
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