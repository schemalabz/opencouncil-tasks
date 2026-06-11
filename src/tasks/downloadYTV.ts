import { Task } from "./pipeline.js";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import cp from "child_process";
import { ffmpegPath } from '../lib/ffmpegPath.js';
import { YtDlp, type FormatOptions, type VideoProgress } from "ytdlp-nodejs";

dotenv.config();

const DEFAULT_VIDEO_QUALITY = "720";
const YTDLP_BIN_PATH = process.env.YTDLP_BIN_PATH;

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
        finalVideoPath = await downloadWithYtDlp(youtubeUrl, videoOutputPath, videoId, onProgress);
    } else if (needsDownload) {
        await downloadUrl(videoUrl, videoOutputPath);
        finalVideoPath = videoOutputPath;
    }

    const videoSize = fs.statSync(finalVideoPath).size;
    if (videoSize === 0) {
        throw new Error(`Download failed: video file is empty (0 bytes). URL: ${finalVideoPath}`);
    }

    console.log(`Video downloaded successfully: ${formatBytes(videoSize)}`);
    await normalizeVideoAudio(finalVideoPath);
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
type LoudnormStats = {
    input_i: string;
    input_tp: string;
    input_lra: string;
    input_thresh: string;
};

const LOUDNORM_TARGET = { I: -14, TP: -1.5, LRA: 11 };
// Within this distance of the integrated-loudness target, the correction is
// too small to justify re-encoding the audio and re-muxing the whole file.
// Files we already normalized measure at the target, so reprocessing a cached
// video skips the expensive pass entirely.
const LOUDNORM_TOLERANCE_LU = 1;
const AUDIO_BITRATE = '128k';

export function needsLoudnormCorrection(stats: LoudnormStats): boolean {
    const deltaI = Math.abs(LOUDNORM_TARGET.I - parseFloat(stats.input_i));
    const truePeak = parseFloat(stats.input_tp);
    // Non-finite measurements (ffmpeg emits "-inf" on silent audio) fall
    // through to normalization, preserving the old always-normalize behavior
    if (!Number.isFinite(deltaI) || !Number.isFinite(truePeak)) {
        return true;
    }
    return deltaI > LOUDNORM_TOLERANCE_LU || truePeak > LOUDNORM_TARGET.TP;
}

export function parseLoudnormStats(stderr: string): LoudnormStats {
    // ffmpeg's loudnorm filter outputs a JSON block at the end of stderr
    const jsonMatch = stderr.match(/\{[^{}]*"input_i"\s*:\s*"[^"]*"[^{}]*\}/s);
    if (!jsonMatch) {
        throw new Error('Could not find loudnorm JSON in ffmpeg output');
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const required = ['input_i', 'input_tp', 'input_lra', 'input_thresh'] as const;
    for (const key of required) {
        if (typeof parsed[key] !== 'string') {
            throw new Error(`Missing loudnorm field: ${key}`);
        }
    }

    return {
        input_i: parsed.input_i,
        input_tp: parsed.input_tp,
        input_lra: parsed.input_lra,
        input_thresh: parsed.input_thresh,
    };
}

function runFfmpeg(args: string[]): Promise<{ stderr: string }> {
    const ffmpegBin = ffmpegPath();
    return new Promise((resolve, reject) => {
        const proc = cp.spawn(ffmpegBin, args, {
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stderr = '';
        proc.stderr.on('data', (data) => { stderr += data.toString(); });

        proc.on('close', (code) => {
            if (code === 0) resolve({ stderr });
            else reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-500)}`));
        });
        proc.on('error', reject);
    });
}

async function normalizeVideoAudio(filePath: string): Promise<void> {
    const { I, TP, LRA } = LOUDNORM_TARGET;
    const loudnormFilter = `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}`;
    const filename = path.basename(filePath);

    // Pass 1: measure loudness. Input-side -vn keeps ffmpeg from decoding
    // the video stream, which would otherwise dominate the runtime of a
    // measurement that only reads audio (~35 minutes of video decode for a
    // 6.5h meeting).
    console.log(`[loudnorm] ${filename}: measuring loudness...`);
    const pass1Start = Date.now();
    const { stderr } = await runFfmpeg([
        '-vn',
        '-i', filePath,
        '-af', `${loudnormFilter}:print_format=json`,
        '-f', 'null', '-',
    ]);
    const pass1Duration = ((Date.now() - pass1Start) / 1000).toFixed(1);

    const stats = parseLoudnormStats(stderr);
    const deltaI = (I - parseFloat(stats.input_i)).toFixed(1);
    console.log(`[loudnorm] ${filename}: I=${stats.input_i} LUFS (target ${I}, Δ${parseFloat(deltaI) >= 0 ? '+' : ''}${deltaI}) | TP=${stats.input_tp} dBTP (ceiling ${TP}) | LRA=${stats.input_lra} (target ${LRA}) | thresh=${stats.input_thresh} | measure=${pass1Duration}s`);

    if (!needsLoudnormCorrection(stats)) {
        console.log(`[loudnorm] ${filename}: within ${LOUDNORM_TOLERANCE_LU} LU of target and true peak under ${TP} dBTP, skipping normalization`);
        return;
    }

    // Pass 2: apply normalization with linear mode
    const tempPath = filePath + '.normalized.mp4';
    const pass2Start = Date.now();
    await runFfmpeg([
        '-i', filePath,
        '-c:v', 'copy',
        '-af', `${loudnormFilter}:measured_I=${stats.input_i}:measured_TP=${stats.input_tp}:measured_LRA=${stats.input_lra}:measured_thresh=${stats.input_thresh}:linear=true`,
        '-c:a', 'aac', '-b:a', AUDIO_BITRATE,
        '-y', tempPath,
    ]);
    const pass2Duration = ((Date.now() - pass2Start) / 1000).toFixed(1);

    // Replace original with normalized version
    fs.renameSync(tempPath, filePath);
    console.log(`[loudnorm] ${filename}: normalize=${pass2Duration}s, total=${((Date.now() - pass1Start) / 1000).toFixed(1)}s`);
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

        // Check for file size from response headers
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
        const updateProcess = cp.spawn(binaryPath, ['--update-to', 'nightly'], {
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

        // Timeout after 60 seconds (nightly binary download can be slow)
        setTimeout(() => {
            updateProcess.kill();
            console.warn('yt-dlp update check timed out');
            resolve();
        }, 60000);
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
