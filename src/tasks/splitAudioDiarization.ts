/*
 * UNUSED, using splitAudioDiarization instead
 */
import { Task } from "./pipeline";
import fs from "fs";
import path from "path";
import ffmpeg from "fluent-ffmpeg";
import wav from 'node-wav';
import { Diarization } from "../types";
import { formatTime } from "../utils";

interface SplitAudioArgs {
    file: string;
    diarization: Diarization;
    maxDuration: number;
}

interface AudioSegment {
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


// Convert MP3 to WAV and cache the result
async function convertMP3ToWAV(inputFile: string): Promise<{ buffer: Buffer; sampleRate: number }> {
    const cacheDir = path.join('./data', 'wavCache');
    if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
    }

    const inputFileName = path.basename(inputFile, '.mp3');
    const cachedWavFile = path.join(cacheDir, `${inputFileName}.wav`);

    if (fs.existsSync(cachedWavFile)) {
        console.log('Using cached WAV file');
        const buffer = fs.readFileSync(cachedWavFile);
        const wavHeader = wav.decode(buffer);
        return { buffer, sampleRate: wavHeader.sampleRate };
    }

    return new Promise((resolve, reject) => {
        ffmpeg(inputFile)
            .toFormat('wav')
            .audioChannels(1)
            .audioFrequency(16000)
            .on('error', reject)
            .output(cachedWavFile)
            .on('end', () => {
                const buffer = fs.readFileSync(cachedWavFile);
                const wavHeader = wav.decode(buffer);
                resolve({ buffer, sampleRate: wavHeader.sampleRate });
            })
            .run();
    });
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
export const splitAudioDiarization: Task<SplitAudioArgs, AudioSegment[]> = async ({ file, diarization, maxDuration }, onProgress) => {
    console.log(`==> Splitting audio file: ${file}`);
    const outputDir = path.dirname(file);
    const fileName = path.basename(file, path.extname(file));

    // Convert MP3 to WAV
    const { buffer, sampleRate } = await convertMP3ToWAV(file);
    console.log(`Converted to WAV: ${sampleRate} Hz`);
    const wavData = wav.decode(buffer);
    const audio = wavData.channelData[0];
    const duration = audio.length / sampleRate;

    console.log(`File duration: ${duration} seconds`);

    // If the audio is already shorter than maxDuration, return it as a single segment
    if (duration <= maxDuration) {
        console.log(`Audio duration (${duration}s) is already shorter than or equal to maxDuration (${maxDuration}s). No splitting needed.`);
        const outputPath = path.join(outputDir, `${fileName}_full.mp3`);
        await ffmpegPromise(file, outputPath);
        return [{ path: outputPath, startTime: 0 }];
    }

    let segments: { start: number; end: number }[] = [];
    let currentStart = 0;

    while (currentStart < duration) {
        const intervalEnd = Math.min(currentStart + maxDuration, duration);
        console.log(`Searching for silences between ${formatTime(currentStart)} and ${formatTime(intervalEnd)}`);
        let silences = await searchForSilences(diarization, currentStart, intervalEnd, longSilenceThreshold);
        if (silences.length === 0) {
            console.log(`No silences found, searching for shorter silences`);
            silences = await searchForSilences(diarization, currentStart, intervalEnd, minSilenceDuration);
        }

        if (silences.length === 0) {
            throw new Error(`No suitable silent segments found for splitting between ${currentStart} and ${intervalEnd}`);
        }

        const longSilence = silences.reverse().find(s => s.end - s.start >= longSilenceThreshold);
        const splitPoint = longSilence ? longSilence.end : silences.reduce((max, silence) => silence.end > max.end ? silence : max).end;

        console.log(`-> Splitting at the end of a ${longSilence ? 'long' : 'short'} silence at ${splitPoint}`);

        segments.push({ start: currentStart, end: splitPoint });
        currentStart = splitPoint;

        onProgress("splitting", (currentStart / duration) * 100);
    }

    console.log(`Got ${segments.length} segments, all under ${maxDuration} seconds`);

    const audioSegments: AudioSegment[] = await Promise.all(segments.map(async (segment, index) => {
        const outputPath = path.join(outputDir, `${fileName}_segment_${index}.mp3`);
        await ffmpegPromise(file, outputPath, segment.start, segment.end - segment.start);
        return { path: outputPath, startTime: segment.start };
    }));

    return audioSegments;
};
// Helper function to promisify ffmpeg operations
const ffmpegPromise = (input: string, output: string, startTime?: number, duration?: number): Promise<void> => {
    return new Promise((resolve, reject) => {
        let command = ffmpeg(input).output(output);
        if (startTime !== undefined) command = command.setStartTime(startTime);
        if (duration !== undefined) command = command.setDuration(duration);
        command.on('end', () => resolve()).on('error', (err) => reject(err)).run();
    });
};