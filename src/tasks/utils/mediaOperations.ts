import path from "path";
import cp from "child_process";
import ffmpeg from "ffmpeg-static";
import fs from "fs";
import { uploadToSpaces } from "../uploadToSpaces.js";
import { SplitMediaFileRequest, MediaType, GenerateHighlightRequest } from "../../types.js";

// Create data directory if it doesn't exist
const dataDir = process.env.DATA_DIR || "./data";
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

// Social media transformation constants
const SOCIAL_CONSTANTS = {
    // TODO: Calculate input dimensions dynamically instead of assuming fixed values
    // Currently assumes 16:9 aspect ratio input video
    ASSUMED_INPUT_WIDTH: 1280,
    ASSUMED_INPUT_HEIGHT: 720,
    ASSUMED_INPUT_ASPECT_RATIO: 16 / 9,
    
    // Target social media dimensions (9:16 portrait)
    TARGET_WIDTH: 720,
    TARGET_HEIGHT: 1280,
    TARGET_ASPECT_RATIO: 9 / 16,
};

/**
 * Generate FFmpeg filter for social-9x16 transformation
 * Converts 16:9 input to 9:16 output with configurable margins and zoom
 */
export function generateSocialFilter(options: Required<NonNullable<GenerateHighlightRequest['render']['socialOptions']>>): string {
    const { marginType, backgroundColor, zoomFactor } = options;
    
    // Calculate video dimensions based on zoom factor
    // Zoom 1.0 = full 16:9 video visible (720x405)
    // Zoom 0.6 = 60% of video width visible (more cropped, less margin)
    const videoHeight = Math.round(405 + (SOCIAL_CONSTANTS.ASSUMED_INPUT_WIDTH - 405) * (1 - zoomFactor));
    const scaledWidth = Math.round(videoHeight * SOCIAL_CONSTANTS.ASSUMED_INPUT_ASPECT_RATIO); // Maintain 16:9 for scaling
    const cropX = Math.round((scaledWidth - SOCIAL_CONSTANTS.TARGET_WIDTH) / 2); // Center crop X position
    
    // Build common video filters once to keep sub-generators simple
    const videoScaleFilter = `scale=${scaledWidth}:${videoHeight}`;
    const videoCropFilter = scaledWidth > SOCIAL_CONSTANTS.TARGET_WIDTH ? `crop=${SOCIAL_CONSTANTS.TARGET_WIDTH}:${videoHeight}:${cropX}:0` : '';
    
    console.log(`🎬 Social filter: zoom=${zoomFactor}, videoHeight=${videoHeight}, scaledWidth=${scaledWidth}, cropX=${cropX}`);
    
    if (marginType === 'blur') {
        return generateBlurredMarginFilter(videoScaleFilter, videoCropFilter);
    } else {
        return generateSolidMarginFilter(videoScaleFilter, videoCropFilter, backgroundColor);
    }
}

/**
 * Generate filter for solid color margins
 */
function generateSolidMarginFilter(
    videoScaleFilter: string,
    videoCropFilter: string,
    backgroundColor: string
): string {
    // Normalize color for FFmpeg (support #RRGGBB and names)
    const padColor = backgroundColor.startsWith('#') ? `0x${backgroundColor.slice(1)}` : backgroundColor;
    
    // Single-input chain composed of clear steps
    const chainParts: string[] = [
        // Scale incoming video to target size determined by zoom
        videoScaleFilter,
        
        // If scaled width exceeds 720, crop horizontally to 720 preserving center
        ...(videoCropFilter ? [videoCropFilter] : []),
        
        // Pad to 720x1280 frame with solid color margins and center the video
        `pad=${SOCIAL_CONSTANTS.TARGET_WIDTH}:${SOCIAL_CONSTANTS.TARGET_HEIGHT}:(ow-iw)/2:(oh-ih)/2:${padColor}`,
        
        // Ensure widely compatible pixel format
        `format=yuv420p`,
        
        // Force portrait sample and display aspect ratios
        `setsar=1`,
        `setdar=${SOCIAL_CONSTANTS.TARGET_ASPECT_RATIO}`
    ];
    
    return chainParts.join(',');
}

/**
 * Generate filter for blurred background margins
 */
function generateBlurredMarginFilter(
    videoScaleFilter: string,
    videoCropFilter: string
): string {
    const cropPart = videoCropFilter ? `,${videoCropFilter}` : '';
    
    return [
        // Split input into two branches: one for background, one for foreground video
        'split=2[bg][video]',
        
        // Background branch: scale up to fill 720x1280, crop to exact frame, then blur
        `[bg]scale=${SOCIAL_CONSTANTS.TARGET_WIDTH}:${SOCIAL_CONSTANTS.TARGET_HEIGHT}:force_original_aspect_ratio=increase,crop=${SOCIAL_CONSTANTS.TARGET_WIDTH}:${SOCIAL_CONSTANTS.TARGET_HEIGHT},gblur=sigma=20[blurred]`,
        
        // Video branch: scale to target size and optionally crop to 720 wide, keep center
        `[video]${videoScaleFilter}${cropPart}[cropped]`,
        
        // Composite: overlay sharp video on blurred background, enforce portrait SAR/DAR
        `[blurred][cropped]overlay=(W-w)/2:(H-h)/2,setsar=1,setdar=${SOCIAL_CONSTANTS.TARGET_ASPECT_RATIO}`
    ].join(';');
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
 * Split a media file into segments with optional video filters
 */
export const getFileParts = (
    filePath: string,
    segments: SplitMediaFileRequest["parts"][number]["segments"],
    type: MediaType,
    videoFilters?: string,
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
    let finalVideoOutput = "[outv]";
    let finalAudioOutput = "[outa]";
    
    if (type === "audio") {
        // Audio-only: concat directly to final output [outa]
        filterComplexConcat =
            segments.map((_, index) => `[a${index}]`).join("") + `concat=n=${segments.length}:v=0:a=1[outa]`;
    } else {
        // Video: concat to intermediate outputs [concatv][concata] for potential further processing
        filterComplexConcat =
            segments.map((_, index) => `[v${index}][a${index}]`).join("") +
            `concat=n=${segments.length}:v=1:a=1[concatv][concata]`;
        
        // Apply video filters if provided
        if (videoFilters && type === "video") {
            console.log(`🎨 Applying video filters: ${videoFilters}`);
            // Chain: [concatv] → video filters → [outv], audio passes through as [concata]
            filterComplexConcat += `;[concatv]${videoFilters}[outv]`;
            finalVideoOutput = "[outv]";
            finalAudioOutput = "[concata]";
        } else {
            // No filters: use intermediate concat outputs directly
            finalVideoOutput = "[concatv]";
            finalAudioOutput = "[concata]";
        }
    }

    const args = ["-i", filePath, "-filter_complex", `${filterComplex}${filterComplexConcat}`];

    if (type === "audio") {
        args.push("-map", finalAudioOutput, "-c:a", "libmp3lame", "-b:a", "128k");
    } else {
        args.push("-map", finalVideoOutput, "-map", finalAudioOutput, "-c:v", "libx264", "-c:a", "aac");
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
    type: MediaType,
    segments: SplitMediaFileRequest["parts"][number]["segments"],
    spacesPath: string,
    onProgress,
    videoFilters?: string,
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
    const outputFilePath = await getFileParts(inputFile, segments, type, videoFilters);

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
