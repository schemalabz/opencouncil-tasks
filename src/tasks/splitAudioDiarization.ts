import { Task } from "./pipeline.js";
import fs from "fs";
import path from "path";
import cp from "child_process";
import { ffmpegPath } from '../lib/ffmpegPath.js';
import { Diarization } from "../types.js";
import { formatTime } from "../utils.js";


export interface SplitAudioArgs {
    file: string;
    diarization: Diarization;
    maxDuration: number;
}

export interface AudioSegment {
    path: string;
    startTime: number;
}

interface SilentSegment {
    start: number;
    end: number;
}

const minSilenceDuration = 0.5;

// Helper function to find silences between two timestamps
async function findSilences(diarization: Diarization, start: number, end: number): Promise<SilentSegment[]> {
    const silences: SilentSegment[] = [];
    let lastSpeechEnd = start;

    for (const segment of diarization) {
        if (segment.start >= start && segment.end <= end) {
            if (segment.start > lastSpeechEnd) {
                silences.push({
                    start: lastSpeechEnd,
                    end: segment.start
                });
            }
            lastSpeechEnd = segment.end;
        } else if (segment.start > end) {
            break;
        }
    }

    // Add final silence if needed
    if (lastSpeechEnd < end) {
        silences.push({
            start: lastSpeechEnd,
            end: end
        });
    }

    return silences.filter(silence => silence.end - silence.start >= minSilenceDuration);
}


async function searchForSilences(diarization: Diarization, start: number, end: number, minSilenceDuration: number): Promise<SilentSegment[]> {
    const sectionDuration = Math.min(minSilenceDuration * 20, end - start);
    let currentEnd = end;
    let currentStart = Math.max(start, currentEnd - sectionDuration);
    const maxIterations = Math.ceil((end - start) / sectionDuration);
    let iterations = 0;

    while (currentStart >= start && iterations < maxIterations) {
        const silences = await findSilences(diarization, currentStart, currentEnd);

        for (const silence of silences) {
            if (silence.end - silence.start >= minSilenceDuration) {
                return [silence];
            }
        }

        currentEnd = currentStart;
        currentStart = Math.max(start, currentEnd - sectionDuration);
        iterations++;
    }

    console.log(`No suitable silences found after ${iterations} iterations`);
    return [];
}


const longSilenceThreshold = 5;
// if the last diarization ends before the end of the audio, we return segments until the end of the diarization
export const splitAudioDiarization: Task<SplitAudioArgs, AudioSegment[]> = async ({ file, diarization, maxDuration }, onProgress) => {
    console.log(`==> Splitting audio file: ${file}`);
    const outputDir = path.dirname(file);
    const fileName = path.basename(file, path.extname(file));

    const duration = diarization.reduce((acc, segment) => acc < segment.end ? segment.end : acc, 0);
    console.log(`File duration (assumed from diarization): ${formatTime(duration)}`);

    // If the audio is already shorter than maxDuration, return it as a single segment
    if (duration <= maxDuration) {
        console.log(`Audio duration (${duration}s) is already shorter than or equal to maxDuration (${maxDuration}s). No splitting needed.`);
        const outputPath = path.join(outputDir, `${fileName}_full.mp3`);
        await ffmpegPromise(file, outputPath, 0, duration);
        return [{ path: outputPath, startTime: 0 }];
    }

    let segments: { start: number; end: number }[] = [];
    let currentStart = 0;

    while (duration - currentStart > maxDuration) {
        const intervalEnd = Math.min(currentStart + maxDuration, duration);
        console.log(`Searching for silences between ${formatTime(currentStart)} and ${formatTime(intervalEnd)}`);
        let silences = await searchForSilences(diarization, currentStart, intervalEnd, longSilenceThreshold);
        if (silences.length === 0) {
            console.log(`No silences found, searching for shorter silences`);
            silences = await searchForSilences(diarization, currentStart, intervalEnd, minSilenceDuration);
        }

        if (silences.length === 0) {
            throw new Error(`No suitable silent segments found for splitting between ${formatTime(currentStart)} and ${formatTime(intervalEnd)}`);
        }

        const longSilence = silences.reverse().find(s => s.end - s.start >= longSilenceThreshold);
        const splitPoint = longSilence ? longSilence.end : silences.reduce((max, silence) => silence.end > max.end ? silence : max).end;

        console.log(`-> Splitting at the end of a ${longSilence ? 'long' : 'short'} silence at ${formatTime(splitPoint)}`);

        segments.push({ start: currentStart, end: splitPoint });
        currentStart = splitPoint;

        onProgress("splitting", (currentStart / duration) * 100);
    }

    // Handle the remaining audio if any
    if (currentStart < duration) {
        segments.push({ start: currentStart, end: duration });
        onProgress("splitting", 100);
    }

    console.log(`Got ${segments.length} segments, all under ${formatTime(maxDuration)} (${maxDuration}s)`);

    console.log(`About to split ${segments.length} segments`);
    const audioSegments: AudioSegment[] = [];
    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const outputPath = path.join(outputDir, `${fileName}_segment_${i}.mp3`);
        console.log(`Splitting segment ${i + 1} of ${segments.length}: ${formatTime(segment.start)} to ${formatTime(segment.end)}`);
        await retryFfmpeg(file, outputPath, segment.start, segment.end - segment.start);
        console.log(`DONE splitting segment ${i + 1} of ${segments.length}: ${formatTime(segment.start)} to ${formatTime(segment.end)}`);
        audioSegments.push({ path: outputPath, startTime: segment.start });
    }
    console.log(`Split ${segments.length} segments`);

    return audioSegments;
};

// Helper function to promisify ffmpeg operations
const ffmpegPromise = (input: string, output: string, startTime?: number, duration?: number): Promise<void> => {
    return new Promise((resolve, reject) => {
        // Ensure absolute paths
        const absoluteInput = path.resolve(input);
        const absoluteOutput = path.resolve(output);

        const args = [
            '-i', absoluteInput,
            '-y'  // Overwrite output file if it exists
        ];

        if (startTime !== undefined) args.push('-ss', startTime.toFixed(3));
        if (duration !== undefined) args.push('-t', duration.toFixed(3));

        // Add some ffmpeg optimizations
        args.push('-acodec', 'libmp3lame', '-b:a', '128k');

        args.push(absoluteOutput);

        const ffmpegBin = ffmpegPath();
        console.log(`Executing ffmpeg command: ${ffmpegBin} ${args.join(' ')}`);

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
                console.log(`FFmpeg process completed successfully for output: ${absoluteOutput}`);
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
};

async function retryFfmpeg(input: string, output: string, startTime?: number, duration?: number, maxRetries = 2): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            await ffmpegPromise(input, output, startTime, duration);
            return;
        } catch (error) {
            console.error(`FFmpeg attempt ${attempt} failed:`, error);
            if (attempt === maxRetries) {
                throw error;
            }
            // Wait before retrying (exponential backoff)
            await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
        }
    }
}