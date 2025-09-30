import { Task } from "./pipeline.js";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import cp from "child_process";
import ffmpeg from 'ffmpeg-static';

dotenv.config();

const COBALT_API_BASE_URL = process.env.COBALT_API_BASE_URL || 'http://cobalt-api:9000';

export const downloadYTV: Task<string, { audioOnly: string, combined: string, sourceType: string }> = async (youtubeUrl, onProgress) => {
    const outputDir = process.env.DATA_DIR || "./data";
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
        console.log(`Created output directory: ${outputDir}`);
    }

    const { videoId, videoUrl, sourceType } = await getVideoIdAndUrl(youtubeUrl);
    console.log(`Processing ${sourceType}: ${youtubeUrl}`);
    
    const audioOutputPath = path.join(outputDir, `${videoId}.mp3`);
    const videoOutputPath = path.join(outputDir, `${videoId}.mp4`);

    await downloadUrl(videoUrl, videoOutputPath);
    await extractSoundFromMP4(videoOutputPath, audioOutputPath);

    return { audioOnly: audioOutputPath, combined: videoOutputPath, sourceType };
}

const randomId = () => Math.random().toString(36).substring(2, 15);

const getVideoIdAndUrl = async (mediaUrl: string) => {
    if (mediaUrl.includes("youtube.com")) {
        const videoId = mediaUrl.split("v=")[1];
        const videoUrl = await getCobaltStreamUrl(mediaUrl, { videoQuality: "360" });
        return { videoId, videoUrl, sourceType: 'YouTube' };
    }

    // Check if it's from our CDN
    const cdnBaseUrl = process.env.CDN_BASE_URL;
    if (cdnBaseUrl && mediaUrl.startsWith(cdnBaseUrl)) {
        const fileName = path.basename(mediaUrl, path.extname(mediaUrl));
        return { videoId: fileName, videoUrl: mediaUrl, sourceType: 'CDN' };
    }

    return { videoId: randomId(), videoUrl: mediaUrl, sourceType: 'Direct URL' };
}
const FREQUENCY_FILTER = true;
const extractSoundFromMP4 = async (inputPath: string, outputPath: string): Promise<void> => {
    const args = [
        '-i', inputPath,
        '-vn',  // No video
        '-ac', '1', // Convert to mono
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
                const audioSize = fs.statSync(outputPath).size;
                console.log(`Extracted audio: ${formatBytes(audioSize)} -> ${path.basename(outputPath)}`);
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

const getCobaltStreamUrl = async (url: string, options: { videoQuality?: string } = {}) => {
    const cobaltApiUrl = `${COBALT_API_BASE_URL}`;
    const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    };

    console.log(`Calling cobalt via ${cobaltApiUrl}`);
    const response = await fetch(cobaltApiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ url, videoQuality: options.videoQuality })
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        const errorMessage = errorData?.error 
            ? `Cobalt API error: ${errorData.error.code}${errorData.error.context ? ` - Context: ${JSON.stringify(errorData.error.context)}` : ''}`
            : `Cobalt API request failed with status ${response.status}: ${response.statusText}`;
        throw new Error(errorMessage);
    }

    const data = await response.json();
    
    if (!data || typeof data !== 'object') {
        throw new Error('Invalid response from Cobalt API: response is not a valid JSON object');
    }

    // Handle different response types
    // see https://github.com/imputnet/cobalt/blob/main/docs/api.md
    switch (data.status) {
        case 'error':
            throw new Error(`Cobalt API error: ${data.error?.code || 'Unknown error'}`);
        case 'picker':
            throw new Error('Multiple items found - picker response not supported');
        case 'redirect':
        case 'tunnel':
            if (!data.url || typeof data.url !== 'string') {
                throw new Error('Invalid response from Cobalt API: missing or invalid url field');
            }
            return data.url;
        default:
            throw new Error(`Unknown response status from Cobalt API: ${data.status}`);
    }
}

const HEADERS = {
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "accept-encoding": "gzip, deflate, br, zstd",
    "accept-language": "en-US,en;q=0.7",
    "sec-ch-ua": "\"Brave\";v=\"129\", \"Not=A?Brand\";v=\"8\", \"Chromium\";v=\"129\"",
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": "\"macOS\"",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
    "sec-gpc": "1",
    "upgrade-insecure-requests": "1",
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"
}


const downloadUrl = async (url: string, outputPath: string) => {
    if (fs.existsSync(outputPath)) {
        const existingSize = fs.statSync(outputPath).size;
        console.log(`Using existing file: ${formatBytes(existingSize)} -> ${path.basename(outputPath)}`);
        return;
    }

    console.log(`Downloading from: ${url}`);
    const response = await fetch(url, { headers: HEADERS });
    if (!response.ok) {
        throw new Error(`HTTP error getting ${url}: status: ${response.status}`);
    }

    const writer = fs.createWriteStream(outputPath);
    const reader = response.body?.getReader();

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
            console.log(`  Downloading... ${formatBytes(totalBytes)}`);
            lastLogTime = currentTime;
        }
    }

    writer.end();
    
    const finalSize = fs.statSync(outputPath).size;
    console.log(`Downloaded video: ${formatBytes(finalSize)} -> ${path.basename(outputPath)}`);
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return bytes + " B";
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
