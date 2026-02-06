import { Task } from "./pipeline.js";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import cp from "child_process";
import { ffmpegPath } from '../lib/ffmpegPath.js';
import { YtDlp, type FormatOptions, type VideoProgress } from "ytdlp-nodejs";

dotenv.config();

const COBALT_API_BASE_URL = process.env.COBALT_API_BASE_URL || 'http://cobalt-api:9000';
const DEFAULT_VIDEO_QUALITY = "720";
const YTDLP_BIN_PATH = process.env.YTDLP_BIN_PATH;
const COBALT_ENABLED = process.env.COBALT_ENABLED === 'true'; // default off

export const downloadYTV: Task<string, { audioOnly: string, combined: string, sourceType: string }> = async (youtubeUrl, onProgress) => {
    const outputDir = process.env.DATA_DIR || "./data";
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
        console.log(`Created output directory: ${outputDir}`);
    }

    const { videoId, videoUrl, sourceType } = getVideoIdAndUrl(youtubeUrl);
    console.log(`Processing ${sourceType}: ${youtubeUrl}`);
    
    const audioOutputPath = path.join(outputDir, `${videoId}.mp3`);
    const videoOutputPath = path.join(outputDir, `${videoId}.mp4`);
    let finalVideoPath = videoOutputPath;

    // Check if video already exists and is valid
    if (fs.existsSync(videoOutputPath)) {
        const existingSize = fs.statSync(videoOutputPath).size;
        if (existingSize > 0) {
            console.log(`Using existing video file: ${formatBytes(existingSize)} -> ${path.basename(videoOutputPath)}`);
            finalVideoPath = videoOutputPath;
        } else {
            // Remove empty file and continue with download
            console.log(`Removing empty existing file and retrying download`);
            fs.unlinkSync(videoOutputPath);
        }
    }

    // Only download if we don't have a valid existing file
    const needsDownload = !fs.existsSync(videoOutputPath);
    
    if (needsDownload && sourceType === 'YouTube') {
        if (COBALT_ENABLED) {
            const cobaltUrl = await getCobaltStreamUrl(youtubeUrl, { videoQuality: DEFAULT_VIDEO_QUALITY });
            await downloadUrl(cobaltUrl, videoOutputPath);
            finalVideoPath = videoOutputPath;
        } else {
            finalVideoPath = await downloadWithYtDlp(youtubeUrl, videoOutputPath, videoId, onProgress);
        }
    } else if (needsDownload) {
        await downloadUrl(videoUrl, videoOutputPath);
        finalVideoPath = videoOutputPath;
    }

    const videoSize = fs.statSync(finalVideoPath).size;
    if (videoSize === 0) {
        throw new Error(`Download failed: video file is empty (0 bytes). URL: ${finalVideoPath}`);
    }

    console.log(`Video downloaded successfully: ${formatBytes(videoSize)}`);
    await extractSoundFromMP4(finalVideoPath, audioOutputPath);

    return { audioOnly: audioOutputPath, combined: finalVideoPath, sourceType };
}

const randomId = () => Math.random().toString(36).substring(2, 15);

export const getVideoIdAndUrl = (mediaUrl: string) => {
    if (mediaUrl.includes("youtube.com") || mediaUrl.includes("youtu.be")) {
        // Extract video ID from various YouTube URL formats
        let videoId: string | undefined;
        
        if (mediaUrl.includes("youtube.com/watch")) {
            const urlParams = new URL(mediaUrl).searchParams;
            videoId = urlParams.get('v') || undefined;
        } else if (mediaUrl.includes("youtu.be/")) {
            videoId = mediaUrl.split("youtu.be/")[1]?.split(/[?&#/]/)[0];
        } else if (mediaUrl.includes("youtube.com/embed/")) {
            videoId = mediaUrl.split("youtube.com/embed/")[1]?.split(/[?&#/]/)[0];
        }
        
        if (!videoId || videoId.length === 0) {
            throw new Error(`Could not extract video ID from YouTube URL: ${mediaUrl}`);
        }
        
        return { videoId, videoUrl: mediaUrl, sourceType: 'YouTube' };
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
    // Validate input file exists and is not empty
    if (!fs.existsSync(inputPath)) {
        throw new Error(`Input file does not exist: ${inputPath}`);
    }
    
    const inputSize = fs.statSync(inputPath).size;
    if (inputSize === 0) {
        throw new Error(`Input file is empty (0 bytes): ${inputPath}`);
    }
    
    console.log(`Extracting audio from: ${path.basename(inputPath)} (${formatBytes(inputSize)})`);
    
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

    const ffmpegBin = ffmpegPath();

    console.log(`Executing ffmpeg command: ${ffmpegBin} ${args.join(' ')}`);

    return new Promise<void>((resolve, reject) => {
        const ffmpegProcess = cp.spawn(ffmpegBin, args, {
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
    console.log(`Downloading from: ${url}`);
    
    let writer: fs.WriteStream | null = null;
    
    try {
        const response = await fetch(url, { headers: HEADERS });
        
        if (!response.ok) {
            const responseText = await response.text().catch(() => 'Unable to read response');
            const truncatedResponse = responseText.length > 200 ? `${responseText.substring(0, 200)}...` : responseText;
            throw new Error(`HTTP error getting ${url}: status: ${response.status} ${response.statusText}. Response: ${truncatedResponse}`);
        }

        // Check for file size from Cobalt headers
        const contentLength = response.headers.get('content-length');
        const estimatedLength = response.headers.get('estimated-content-length');
        
        if (contentLength) {
            console.log(`Expected file size: ${formatBytes(parseInt(contentLength))}`);
        } else if (estimatedLength) {
            console.log(`Estimated file size: ${formatBytes(parseInt(estimatedLength))}`);
        }

        writer = fs.createWriteStream(outputPath);
        // Attach error handler immediately so disk errors during writes are caught
        const writeCompletion = new Promise<void>((resolve, reject) => {
            writer!.once('finish', resolve);
            writer!.once('error', (err) => {
                reject(new Error(`Error writing file: ${err.message}`));
            });
        });
        // Prevent unhandled rejection if the stream errors before we await it
        writeCompletion.catch(() => {});
        const reader = response.body?.getReader();

        if (!reader) {
            throw new Error("Unable to read response body - response.body is null");
        }

        let totalBytes = 0;
        let lastLogTime = Date.now();

        while (true) {
            const { done, value } = await reader.read();

            if (done) {
                break;
            }

            if (!value || value.length === 0) {
                console.warn(`Warning: Received empty chunk during download`);
                continue;
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
        
        // Wait for file to be fully written (with timeout)
        await Promise.race([
            writeCompletion,
            new Promise<void>((_, reject) =>
                setTimeout(() => reject(new Error('Write stream timeout after 30 seconds')), 30000)
            )
        ]);
        
        const finalSize = fs.statSync(outputPath).size;
        console.log(`Downloaded video: ${formatBytes(finalSize)} -> ${path.basename(outputPath)}`);
        
        if (finalSize === 0) {
            throw new Error(`Post-download validation failed: file is empty (0 bytes). URL: ${url}`);
        }
    } catch (error) {
        // Close the writer stream if it was created
        if (writer) {
            writer.destroy();
        }
        
        // Clean up empty file on error
        if (fs.existsSync(outputPath)) {
            const size = fs.statSync(outputPath).size;
            if (size === 0) {
                fs.unlinkSync(outputPath);
            }
        }
        throw error;
    }
}

export function formatBytes(bytes: number): string {
    if (bytes < 1024) return bytes + " B";
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function updateYtDlp(): Promise<void> {
    const binaryPath = YTDLP_BIN_PATH || 'yt-dlp';
    console.log('Checking for yt-dlp updates...');

    return new Promise((resolve) => {
        const updateProcess = cp.spawn(binaryPath, ['-U'], {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';

        updateProcess.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        updateProcess.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        updateProcess.on('close', (code) => {
            if (code === 0) {
                // Check if actually updated or already up-to-date
                if (stdout.includes('Updating to') || stdout.includes('Updated yt-dlp')) {
                    console.log('yt-dlp updated successfully');
                } else {
                    console.log('yt-dlp is up to date');
                }
            } else {
                // Log but don't fail - we can still try with existing version
                console.warn(`yt-dlp update check failed (code ${code}): ${stderr || stdout}`);
            }
            resolve();
        });

        updateProcess.on('error', (err) => {
            console.warn(`yt-dlp update check error: ${err.message}`);
            resolve();
        });

        // Timeout after 30 seconds
        setTimeout(() => {
            updateProcess.kill();
            console.warn('yt-dlp update check timed out');
            resolve();
        }, 30000);
    });
}

async function downloadWithYtDlp(
    youtubeUrl: string,
    outputPath: string,
    videoId: string,
    onProgress?: (...args: any[]) => void
) {
    // Try to update yt-dlp before downloading
    await updateYtDlp();

    const ytdlp = new YtDlp({
        binaryPath: YTDLP_BIN_PATH || undefined,
        // we still rely on ffmpeg-static for audio extraction; yt-dlp uses system ffmpeg only if needed
    });

    const proxy = process.env.YTDLP_PROXY || process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
    const outputDir = path.dirname(outputPath);
    const baseName = path.basename(outputPath, path.extname(outputPath));
    const outputTemplate = path.join(outputDir, `${baseName}.%(ext)s`);

    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const ytOptions: FormatOptions<'videoonly'> = {
        output: outputTemplate,
        format: `bestvideo[height<=${DEFAULT_VIDEO_QUALITY}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${DEFAULT_VIDEO_QUALITY}][ext=mp4]/best`,
        onProgress: (p: VideoProgress) => {
            if (onProgress && p.total > 0) {
                const pct = (p.downloaded / p.total) * 100;
                const bytesInfo = ` (${formatBytes(p.downloaded)} / ${formatBytes(p.total)})`;
                process.stdout.write(bytesInfo);
                onProgress('yt-dlp', pct);
            }
        },
        additionalOptions: ['--merge-output-format', 'mp4', '--js-runtimes', 'node'],
    };

    // Use env proxy if available
    if (proxy) {
        ytOptions.proxy = proxy;
    }

    try {
        console.log(`Downloading via yt-dlp: ${youtubeUrl}`);
        await ytdlp.downloadAsync(youtubeUrl, ytOptions);

        const expectedPath = path.join(outputDir, `${baseName}.mp4`);
        if (!fs.existsSync(expectedPath)) {
            throw new Error(`yt-dlp reported success but expected mp4 file not found: ${expectedPath}`);
        }

        return expectedPath;
    } catch (err) {
        throw new Error(`yt-dlp download failed: ${(err as Error).message}`);
    }
}
