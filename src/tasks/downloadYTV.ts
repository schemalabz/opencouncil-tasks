import { Task } from "./pipeline.js";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import cp from "child_process";
import ffmpeg from 'ffmpeg-static';

dotenv.config();

const COBALT_API_BASE_URL = process.env.COBALT_API_BASE_URL || 'http://cobalt-api:9000';

export const downloadYTV: Task<string, { audioOnly: string, combined: string }> = async (youtubeUrl, onProgress) => {
    const videoId = youtubeUrl.split("v=")[1];
    const outputDir = process.env.DATA_DIR || "./data";
    const filePath = path.join(outputDir, `${videoId}.mp4`);

    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
        console.log(`Created output directory: ${outputDir}`);
    }

    const audioOutputPath = path.join(outputDir, `${videoId}.mp3`);
    const videoOutputPath = path.join(outputDir, `${videoId}.mp4`);

    console.log(`Getting cobalt urls for ${youtubeUrl}`);

    const [audioUrl, videoUrl] = await Promise.all([
        getCobaltStreamUrl(youtubeUrl, { audioOnly: true }),
        getCobaltStreamUrl(youtubeUrl, { vQuality: "480" })
    ]);

    console.log(`Got cobalt urls: ${audioUrl} (AUDIO) and ${videoUrl} (VIDEO)`);

    await Promise.all([
        downloadUrl(audioUrl, audioOutputPath),
        downloadUrl(videoUrl, videoOutputPath)
    ]);

    return { audioOnly: audioOutputPath, combined: videoOutputPath };
}

const getCobaltStreamUrl = async (url: string, options: { audioOnly?: boolean, vQuality?: string } = {}) => {
    const cobaltApiUrl = `${COBALT_API_BASE_URL}/api/json`;
    const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    };

    const response = await fetch(cobaltApiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ url, isAudioOnly: options.audioOnly, vQuality: options.vQuality })
    });

    const data = await response.json();
    return data.url;
}

const downloadUrl = async (url: string, outputPath: string) => {
    if (fs.existsSync(outputPath)) {
        console.log(`Skipping download of ${url} to ${outputPath} because it already exists`);
        return;
    }

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`HTTP error getting ${url}: status: ${response.status}`);
    }

    const writer = fs.createWriteStream(outputPath);
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();

    if (!reader) {
        throw new Error("Unable to read response body");
    }

    let totalBytes = 0;
    let lastLogTime = Date.now();

    while (true) {
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        writer.write(Buffer.from(value));
        totalBytes += value.length;

        const currentTime = Date.now();
        if (currentTime - lastLogTime >= 5000) {
            console.log(`Downloading: ${formatBytes(totalBytes)} written`);
            lastLogTime = currentTime;
        }
    }

    writer.end();

    console.log(`Total downloaded: ${formatBytes(totalBytes)}`);
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return bytes + " B";
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
