import path from "path";
import cp from "child_process";
import ffmpeg from "ffmpeg-static";
import fs from "fs";
import { uploadToSpaces } from "../uploadToSpaces.js";
import { SplitMediaFileRequest, SupportedMediaType } from "../../types.js";

// Create data directory if it doesn't exist
const dataDir = process.env.DATA_DIR || "./data";
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

/**
 * Download a file from a URL
 */
export const downloadFile = async (url: string): Promise<string> => {
    const fallbackRandomName = Math.random().toString(36).substring(2, 15);
    const fileName = path.join(dataDir, url.split("/").pop() || fallbackRandomName);

    // Check if file already exists
    try {
        await fs.promises.access(fileName);
        console.log(`File ${fileName} already exists, skipping download`);
        return fileName;
    } catch (error) {
        // File doesn't exist, proceed with download
        const response = await fetch(url);
        const buffer = await response.arrayBuffer();
        await fs.promises.writeFile(fileName, Buffer.from(buffer));
        console.log(`Downloaded file ${url} to ${fileName}`);
        return fileName;
    }
};

/**
 * Split a media file into segments
 */
export const getFileParts = (
    filePath: string,
    segments: SplitMediaFileRequest["parts"][number]["segments"],
    type: SupportedMediaType,
): Promise<string> => {
    // Creates a media file that consists of all the segments from the input file
    console.log(
        `Creating ${type} file part with ${segments.length} segments (${segments
            .map(s => `${s.startTimestamp} - ${s.endTimestamp}`)
            .join(", ")})...`,
    );
    const randomId = Math.random().toString(36).substring(2, 15);
    const outputExt = type === "audio" ? "mp3" : "mp4";
    const outputFilePath = path.join(dataDir, `${randomId}.${outputExt}`);

    const filterComplex = segments
        .map((segment, index) => {
            if (type === "audio") {
                return `[0:a]atrim=${segment.startTimestamp}:${segment.endTimestamp},asetpts=PTS-STARTPTS[a${index}];`;
            } else {
                return (
                    `[0:v]trim=${segment.startTimestamp}:${segment.endTimestamp},setpts=PTS-STARTPTS[v${index}];` +
                    `[0:a]atrim=${segment.startTimestamp}:${segment.endTimestamp},asetpts=PTS-STARTPTS[a${index}];`
                );
            }
        })
        .join("");

    let filterComplexConcat;
    if (type === "audio") {
        filterComplexConcat =
            segments.map((_, index) => `[a${index}]`).join("") + `concat=n=${segments.length}:v=0:a=1[outa]`;
    } else {
        filterComplexConcat =
            segments.map((_, index) => `[v${index}][a${index}]`).join("") +
            `concat=n=${segments.length}:v=1:a=1[outv][outa]`;
    }

    const args = ["-i", filePath, "-filter_complex", `${filterComplex}${filterComplexConcat}`];

    if (type === "audio") {
        args.push("-map", "[outa]", "-c:a", "libmp3lame", "-b:a", "128k");
    } else {
        args.push("-map", "[outv]", "-map", "[outa]", "-c:v", "libx264", "-c:a", "aac");
    }

    args.push("-y", outputFilePath);

    console.log(`Executing ffmpeg command: ${ffmpeg} ${args.join(" ")}`);

    return new Promise((resolve, reject) => {
        const ffmpegProcess = cp.spawn(ffmpeg as unknown as string, args, {
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
        });

        let stdoutData = "";
        let stderrData = "";

        ffmpegProcess.stdout.on("data", data => {
            stdoutData += data.toString();
        });

        ffmpegProcess.stderr.on("data", data => {
            stderrData += data.toString();
        });

        ffmpegProcess.on("close", code => {
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

        ffmpegProcess.on("error", err => {
            console.error(`FFmpeg process error: ${err.message}`);
            reject(err);
        });
    });
};

/**
 * Split media file and upload result to DigitalOcean Spaces
 */
export const splitAndUploadMedia = async (
    mediaUrl: string,
    type: SupportedMediaType,
    segments: SplitMediaFileRequest["parts"][number]["segments"],
    spacesPath: string,
    onProgress,
) => {
    // Validate file extension
    const fileExt = path.extname(mediaUrl).toLowerCase();
    if (type === "audio" && fileExt !== ".mp3") {
        throw new Error("Audio files must be MP3 format");
    }
    if (type === "video" && fileExt !== ".mp4") {
        throw new Error("Video files must be MP4 format");
    }

    // Download the file
    onProgress("downloading", 10);
    const inputFile = await downloadFile(mediaUrl);

    // Split the media
    onProgress("splitting", 30);
    const outputFilePath = await getFileParts(inputFile, segments, type);

    // Upload to DO Spaces
    onProgress("uploading", 50);
    const uploadedUrls = await uploadToSpaces(
        {
            files: [outputFilePath],
            spacesPath: spacesPath || `${type}-parts`,
        },
        onProgress,
    );

    if (uploadedUrls.length !== 1) {
        throw new Error(`Expected 1 uploaded URL, got ${uploadedUrls.length}!`);
    }

    const uploadedUrl = uploadedUrls[0];

    // Calculate total duration
    const duration = segments.reduce((total, segment) => {
        return total + (segment.endTimestamp - segment.startTimestamp);
    }, 0);

    // Clean up temporary files
    try {
        fs.unlinkSync(outputFilePath);
    } catch (e) {
        console.warn("Failed to clean up temporary files:", e);
    }

    onProgress("complete", 100);

    return {
        url: uploadedUrl,
        duration,
        startTimestamp: segments[0].startTimestamp,
        endTimestamp: segments[segments.length - 1].endTimestamp,
    };
};
