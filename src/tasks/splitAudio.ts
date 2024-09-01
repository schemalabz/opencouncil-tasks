import { Task } from "./pipeline";
import fs from "fs";
import path from "path";
import ffmpeg from "fluent-ffmpeg";
import wav from 'node-wav';
import { NonRealTimeVAD, NonRealTimeVADOptions } from "@ricky0123/vad-node";

interface SplitAudioArgs {
    file: string;
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

const modelPromise = loadModel();
// Helper function to find silences between two timestamps
async function findSilences(audio: Float32Array, sampleRate: number, start: number, end: number): Promise<SilentSegment[]> {
    const model = await modelPromise;
    const silences: SilentSegment[] = [];
    let lastSpeechEnd = start;

    const audioSlice = audio.slice(Math.floor(start * sampleRate), Math.floor(end * sampleRate));
    for await (const { start: segStart, end: segEnd } of model.run(audioSlice, sampleRate)) {
        const adjustedStart = segStart / 1000 + start;
        const adjustedEnd = segEnd / 1000 + start;

        if (adjustedStart > lastSpeechEnd) {
            silences.push({
                start: lastSpeechEnd,
                end: adjustedStart
            });
        }
        lastSpeechEnd = adjustedEnd;
    }

    // Add final silence if needed
    if (lastSpeechEnd < end) {
        silences.push({
            start: lastSpeechEnd,
            end: end
        });
    }

    return silences;
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
async function searchForSilences(audio: Float32Array, sampleRate: number, start: number, end: number, minSilenceDuration: number): Promise<SilentSegment[]> {
    const sectionDuration = Math.min(minSilenceDuration * 20, end - start);
    let currentEnd = end;
    let currentStart = Math.max(start, currentEnd - sectionDuration);
    const maxIterations = Math.ceil((end - start) / sectionDuration);
    let iterations = 0;

    while (currentStart >= start && iterations < maxIterations) {
        const silences = await findSilences(audio, sampleRate, currentStart, currentEnd);

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

const formatTime = (time: number): string => {
    const hours = Math.floor(time / 3600);
    const minutes = Math.floor((time % 3600) / 60);
    const seconds = Math.floor(time % 60);
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
};

const longSilenceThreshold = 5;

export const splitAudio: Task<SplitAudioArgs, AudioSegment[]> = async ({ file, maxDuration }, onProgress) => {
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

    let segments: { start: number; end: number }[] = [];
    let currentStart = 0;

    while (currentStart < duration) {
        const intervalEnd = Math.min(currentStart + maxDuration, duration);
        console.log(`Searching for silences between ${formatTime(currentStart)} and ${formatTime(intervalEnd)}`);
        let silences = await searchForSilences(audio, sampleRate, currentStart, intervalEnd, longSilenceThreshold);
        if (silences.length === 0) {
            console.log(`No silences found, searching for shorter silences`);
            silences = await searchForSilences(audio, sampleRate, currentStart, intervalEnd, minSilenceDuration);
        }


        if (silences.length === 0) {
            throw new Error(`No suitable silent segments found for splitting between ${currentStart} and ${intervalEnd}`);
        }

        let splitPoint: number;
        const longSilence = silences.reverse().find(s => s.end - s.start >= longSilenceThreshold);

        if (longSilence) {
            splitPoint = longSilence.end;
            console.log(`-> Splitting at the end of a long silence at ${splitPoint}`);
        } else {
            splitPoint = silences.reduce((max, silence) => silence.end > max.end ? silence : max).end;
            console.log(`-> Splitting at the end of a short silence at ${splitPoint}`);
        }

        segments.push({ start: currentStart, end: splitPoint });
        currentStart = splitPoint;

        onProgress((currentStart / duration) * 100);
    }

    console.log(`Got ${segments.length} segments, all under ${maxDuration} seconds`);

    const audioSegments: AudioSegment[] = await Promise.all(segments.map(async (segment, index) => {
        const outputPath = path.join(outputDir, `${fileName}_segment_${index}.mp3`);
        await new Promise<void>((resolve, reject) => {
            ffmpeg(file)
                .setStartTime(segment.start)
                .setDuration(segment.end - segment.start)
                .output(outputPath)
                .on('end', () => resolve())
                .on('error', reject)
                .run();
        });
        return { path: outputPath, startTime: segment.start };
    }));

    return audioSegments;
};

async function loadModel() {
    const options: Partial<NonRealTimeVADOptions> = {
        frameSamples: 1536 * 4
    };
    return await NonRealTimeVAD.new(options);
}