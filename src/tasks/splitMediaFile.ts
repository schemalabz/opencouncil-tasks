import { SplitMediaFileRequest, SplitMediaFileResult } from "../types.js";
import path from "path";
import cp from "child_process";
import ffmpeg from "ffmpeg-static";
import fs from "fs";
import { Task } from "./pipeline.js";
import { uploadToSpaces } from "./uploadToSpaces.js";

export const splitMediaFile: Task<SplitMediaFileRequest, SplitMediaFileResult> = async (request, onProgress) => {
    const { url, type, parts } = request;

    // Validate file extension
    const fileExt = path.extname(url).toLowerCase();
    if (type === 'audio' && fileExt !== '.mp3') {
        throw new Error('Audio files must be MP3 format');
    }
    if (type === 'video' && fileExt !== '.mp4') {
        throw new Error('Video files must be MP4 format');
    }

    const results: SplitMediaFileResult['parts'] = [];
    const inputFile = await downloadFile(url);

    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        onProgress(`processing`, (i / parts.length) * 100);

        const outputFilePath = await getFileParts(inputFile, part.segments, type);
        const uploadedUrls = await uploadToSpaces({
            files: [outputFilePath],
            spacesPath: `${type}-parts`
        }, onProgress);

        if (uploadedUrls.length !== 1) {
            throw new Error(`Expected 1 uploaded URL, got ${uploadedUrls.length}!`);
        }

        const uploadedUrl = uploadedUrls[0];

        const duration = part.segments.reduce((total, segment) => {
            return total + (segment.endTimestamp - segment.startTimestamp);
        }, 0);

        results.push({
            id: part.id,
            url: uploadedUrl,
            type,
            duration,
            startTimestamp: part.segments[0].startTimestamp,
            endTimestamp: part.segments[part.segments.length - 1].endTimestamp
        });
    }

    onProgress(`processing`, 100);

    return { parts: results };
};

const downloadFile = async (url: string): Promise<string> => {
    const response = await fetch(url);
    const buffer = await response.arrayBuffer();
    const fallbackRandomName = Math.random().toString(36).substring(2, 15);
    const fileName = path.join(dataDir, url.split("/").pop() || fallbackRandomName);
    await fs.promises.writeFile(fileName, Buffer.from(buffer));
    console.log(`Downloaded file ${url} to ${fileName}`);
    return fileName;
}

const dataDir = process.env.DATA_DIR || "./data";
function getFileParts(filePath: string, segments: SplitMediaFileRequest['parts'][number]['segments'], type: 'audio' | 'video'): Promise<string> {
    // Creates a media file that consists of all the segments from the input file
    console.log(`Creating ${type} file part with ${segments.length} segments (${segments.map(s => `${s.startTimestamp} - ${s.endTimestamp}`).join(", ")})...`);
    const randomId = Math.random().toString(36).substring(2, 15);
    const outputExt = type === 'audio' ? 'mp3' : 'mp4';
    const outputFilePath = path.join(dataDir, `${randomId}.${outputExt}`);

    const filterComplex = segments.map((segment, index) => {
        if (type === 'audio') {
            return `[0:a]atrim=${segment.startTimestamp}:${segment.endTimestamp},asetpts=PTS-STARTPTS[a${index}];`;
        } else {
            return `[0:v]trim=${segment.startTimestamp}:${segment.endTimestamp},setpts=PTS-STARTPTS[v${index}];` +
                `[0:a]atrim=${segment.startTimestamp}:${segment.endTimestamp},asetpts=PTS-STARTPTS[a${index}];`;
        }
    }).join('');

    let filterComplexConcat;
    if (type === 'audio') {
        filterComplexConcat = segments.map((_, index) => `[a${index}]`).join('') + `concat=n=${segments.length}:v=0:a=1[outa]`;
    } else {
        filterComplexConcat = segments.map((_, index) => `[v${index}][a${index}]`).join('') +
            `concat=n=${segments.length}:v=1:a=1[outv][outa]`;
    }

    const args = [
        '-i', filePath,
        '-filter_complex', `${filterComplex}${filterComplexConcat}`
    ];

    if (type === 'audio') {
        args.push(
            '-map', '[outa]',
            '-c:a', 'libmp3lame',
            '-b:a', '128k'
        );
    } else {
        args.push(
            '-map', '[outv]',
            '-map', '[outa]',
            '-c:v', 'libx264',
            '-c:a', 'aac'
        );
    }

    args.push('-y', outputFilePath);

    console.log(`Executing ffmpeg command: ${ffmpeg} ${args.join(' ')}`);

    return new Promise<string>((resolve, reject) => {
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
                console.log(`FFmpeg process completed successfully for output: ${outputFilePath}`);
                resolve(outputFilePath);
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