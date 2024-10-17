import { Task } from "./pipeline.js";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import cp from "child_process";
import ffmpeg from 'ffmpeg-static';

dotenv.config();

const COBALT_API_BASE_URL = process.env.COBALT_API_BASE_URL || 'http://cobalt-api:9000';

export const downloadYTV: Task<string, { audioOnly: string, combined: string }> = async (youtubeUrl, onProgress) => {
    const outputDir = process.env.DATA_DIR || "./data";
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
        console.log(`Created output directory: ${outputDir}`);
    }

    console.log(`Getting cobalt urls for ${youtubeUrl}`);

    const { videoId, videoUrl } = await getVideoIdAndUrl(youtubeUrl);

    console.log(`Got direct url: ${videoUrl} (VIDEO)`);
    const audioOutputPath = path.join(outputDir, `${videoId}.mp3`);
    const videoOutputPath = path.join(outputDir, `${videoId}.mp4`);

    await Promise.all([
        downloadUrl(videoUrl, videoOutputPath)
    ]);

    console.log(`Extracting sound from ${videoOutputPath} to ${audioOutputPath}`);
    await extractSoundFromMP4(videoOutputPath, audioOutputPath);
    console.log(`Extracted sound from ${videoOutputPath} to ${audioOutputPath}`);

    return { audioOnly: audioOutputPath, combined: videoOutputPath };
}

const randomId = () => Math.random().toString(36).substring(2, 15);

const getVideoIdAndUrl = async (mediaUrl: string) => {
    if (mediaUrl.includes("youtube.com")) {
        const videoId = mediaUrl.split("v=")[1];
        const videoUrl = await getCobaltStreamUrl(mediaUrl, { vQuality: "360" });
        return { videoId, videoUrl };
    }

    console.log(`Unknown media type, assuming it's a url to an mp4 file: ${mediaUrl}`);
    return { videoId: randomId(), videoUrl: mediaUrl };
}

const FREQUENCY_FILTER = true;
const extractSoundFromMP4 = async (inputPath: string, outputPath: string): Promise<void> => {
    const args = [
        '-i', inputPath,
        '-vn',  // No video
        '-acodec', 'libmp3lame',
        '-b:a', '128k',
        '-y',  // Overwrite output file if it exists
        outputPath
    ];

    if (FREQUENCY_FILTER) {
        args.splice(args.length - 1, 0, '-af', 'highpass=f=200, lowpass=f=3000');
    }

    console.log(`Executing ffmpeg command: ${ffmpeg} ${args.join(' ')}`);

    return new Promise<void>((resolve, reject) => {
        const ffmpegProcess = cp.spawn(ffmpeg as unknown as string, args, {
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let stdoutData = '';
        let stderrData = '';

        ffmpegProcess.stdout.on('data', (data) => {
            stdoutData += data.toString();
        });

        ffmpegProcess.stderr.on('data', (data) => {
            stderrData += data.toString();
        });

        ffmpegProcess.on('close', (code) => {
            if (code === 0) {
                console.log(`FFmpeg process completed successfully for output: ${outputPath}`);
                resolve();
            } else {
                console.error(`FFmpeg process failed with code ${code}`);
                console.error(`FFmpeg stdout: ${stdoutData}`);
                console.error(`FFmpeg stderr: ${stderrData}`);
                reject(new Error(`FFmpeg process exited with code ${code}`));
            }
        });

        ffmpegProcess.on('error', (err) => {
            console.error(`FFmpeg process error: ${err.message}`);
            reject(err);
        });
    });
}

const getCobaltStreamUrl = async (url: string, options: { audioOnly?: boolean, vQuality?: string } = {}) => {
    const cobaltApiUrl = `${COBALT_API_BASE_URL}/api/json`;
    const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    };

    console.log(`Calling cobalt via ${cobaltApiUrl}`);
    const response = await fetch(cobaltApiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ url, isAudioOnly: options.audioOnly, vQuality: options.vQuality })
    });

    const data = await response.json();
    return data.url;
}

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.36'
};

const downloadUrl = async (url: string, outputPath: string) => {
    if (fs.existsSync(outputPath)) {
        console.log(`Skipping download of ${url} to ${outputPath} because it already exists`);
        return;
    }

    const response = await fetch(url, { headers: HEADERS });
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
            console.log(`Downloading: ${formatBytes(totalBytes)} written to ${outputPath}`);
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
