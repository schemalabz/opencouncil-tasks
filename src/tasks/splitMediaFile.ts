import { SplitMediaFileRequest, SplitMediaFileResult } from "../types.js";
import path from "path";
import cp from "child_process";
import ffmpeg from "ffmpeg-static";
import fs from "fs";
import { Task } from "./pipeline.js";
import { uploadToSpaces } from "./uploadToSpaces.js";

export const splitMediaFile: Task<SplitMediaFileRequest, SplitMediaFileResult> = async (request, onProgress) => {
    const { audioUrl, parts } = request;

    const results: SplitMediaFileResult['parts'] = [];
    const audioFile = await downloadAudio(audioUrl);

    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        onProgress(`processing`, (i / parts.length) * 100);

        const outputFilePath = await getFileParts(audioFile, part.segments);
        const uploadedUrls = await uploadToSpaces({
            files: [outputFilePath],
            spacesPath: `podcast-parts`
        }, onProgress);

        if (uploadedUrls.length !== 1) {
            throw new Error(`Expected 1 uploaded URL, got ${uploadedUrls.length}!`);
        }

        const uploadedUrl = uploadedUrls[0];

        results.push({
            id: part.id,
            audioUrl: uploadedUrl
        });
    }

    onProgress(`processing`, 100);

    return { parts: results };
};

const downloadAudio = async (audioUrl: string): Promise<string> => {
    const audioFile = await fetch(audioUrl);
    const audioBuffer = await audioFile.arrayBuffer();
    const fallbackRandomName = Math.random().toString(36).substring(2, 15);
    const fileName = path.join(dataDir, audioUrl.split("/").pop() || fallbackRandomName);
    await fs.promises.writeFile(fileName, Buffer.from(audioBuffer));
    console.log(`Downloaded audio ${audioUrl} to ${fileName}`);
    return fileName;
}

const dataDir = process.env.DATA_DIR || "./data";
function getFileParts(filePath: string, segments: SplitMediaFileRequest['parts'][number]['segments']): Promise<string> {
    // Creates a media (usually audio) file that consists of all the segments from the
    // input file, with ffmpeg.const createMediaFilePart = async (filePath: string, segments: MediaFileSegments): Promise<string> => {
    console.log(`Creating media file part with ${segments.length} segments (${segments.map(s => `${s.startTimestamp} - ${s.endTimestamp}`).join(", ")})...`);
    const randomId = Math.random().toString(36).substring(2, 15);
    const outputFilePath = path.join(dataDir, `${randomId}.mp3`);

    const filterComplex = segments.map((segment, index) => {
        return `[0:a]atrim=${segment.startTimestamp}:${segment.endTimestamp},asetpts=PTS-STARTPTS[a${index}];`;
    }).join('');

    const filterComplexConcat = segments.map((_, index) => `[a${index}]`).join('') + `concat=n=${segments.length}:v=0:a=1[outa]`;

    const args = [
        '-i', filePath,
        '-filter_complex', `${filterComplex}${filterComplexConcat}`,
        '-map', '[outa]',
        '-c:a', 'libmp3lame',
        '-b:a', '128k',
        '-y',
        outputFilePath
    ];

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