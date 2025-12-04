import path from "path";
import cp from "child_process";
import ffmpeg from "ffmpeg-static";
import fs from "fs";
import { promisify } from "util";
import { uploadToSpaces } from "../uploadToSpaces.js";
import { SplitMediaFileRequest, MediaType, GenerateHighlightRequest, AspectRatio } from "../../types.js";

const execAsync = promisify(cp.exec);

// Create data directory if it doesn't exist
const dataDir = process.env.DATA_DIR || "./data";
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

// Caption rendering constants - only essential constants that don't belong in presets
const CAPTION_CONSTANTS = {
    // Font configuration
    FONT_URL: 'https://townhalls-gr.fra1.cdn.digitaloceanspaces.com/fonts/relative-book-pro.ttf',
    FONT_FILENAME: 'relative-book-pro.ttf',

    // Font width estimation (typical character width ratio for most fonts)
    FONT_CHAR_WIDTH_RATIO: 0.6,  // Character width is typically 60% of font size

    // Minimum font size to maintain readability
    MIN_FONT_SIZE: 12,

    // Global styling constants (same across all resolutions and aspect ratios)
    FONT_COLOR: 'white',
    BACKGROUND_COLOR: 'black@0.7',
    BORDER_WIDTH: 2,
    BORDER_COLOR: 'black',
};

// Caption configuration for a specific aspect ratio
type CaptionConfig = {
    startFont: number;        // Initial font size (px) - will shrink if text doesn't fit
    maxFont: number;          // Maximum font size (px) - prevents text from being too large
    bottomPadding: number;    // Distance from bottom edge (px) - where captions appear
    sidePadding: number;      // Horizontal padding from edges (px) - text area width
    maxLines: number;         // Maximum text lines before truncation with "..."
};

// Speaker overlay configuration for a specific aspect ratio
type OverlayConfig = {
    topPadding: number;       // Distance from top edge (px) - where overlay appears
    leftPadding: number;      // Distance from left edge (px) - overlay positioning
    baseFontSize: number;     // Base font size (px) - speaker name uses 1.2x this
    maxWidth: number;         // Maximum overlay width (px) - prevents overflow
    paddingH: number;         // Internal horizontal padding (px) - space inside overlay box
    paddingV: number;         // Internal vertical padding (px) - space inside overlay box
    lineSpacing: number;      // Space between text lines (px) - multi-line spacing
    accentWidth: number;      // Party color accent bar width (px) - left border
};

// Resolution-specific presets for consistent styling across different video sizes
type ResolutionPreset = {
    caption: {
        'default': CaptionConfig;      // 16:9 landscape format
        'social-9x16'?: CaptionConfig; // 9:16 portrait format (optional - falls back to default)
    };
    overlay: {
        'default': OverlayConfig;      // 16:9 landscape format
        'social-9x16'?: OverlayConfig; // 9:16 portrait format (optional - falls back to default)
    };
};

const RESOLUTION_PRESETS: Record<string, ResolutionPreset> = {
    // 1280x720 (HD)
    "1280x720": {
        caption: {
            'default': {
                startFont: 32,
                maxFont: 36,
                bottomPadding: 140,
                sidePadding: 30,
                maxLines: 3
            },
            'social-9x16': {
                startFont: 32,
                maxFont: 40,
                bottomPadding: 400,
                sidePadding: 30,
                maxLines: 6
            },
        },
        overlay: {
            'default': {
                topPadding: 20,
                leftPadding: 20,
                baseFontSize: 28,
                maxWidth: 450,
                paddingH: 12,
                paddingV: 8,
                lineSpacing: 4,
                accentWidth: 3,
            },
            'social-9x16': {
                topPadding: 350,
                leftPadding: 20,
                baseFontSize: 20,
                maxWidth: 450,
                paddingH: 12,
                paddingV: 8,
                lineSpacing: 4,
                accentWidth: 3,
            },
        },
    },
    // 640x360 (nHD)
    "640x360": {
        caption: {
            'default': {
                startFont: 28,
                maxFont: 32,
                bottomPadding: 90,
                sidePadding: 15,
                maxLines: 3
            }
            // NOTE: social-9x16 Defaults to 1080p's social-9x16 preset
        },
        overlay: {
            'default': {
                topPadding: 12,
                leftPadding: 12,
                baseFontSize: 14,
                maxWidth: 280,
                paddingH: 8,
                paddingV: 6,
                lineSpacing: 3,
                accentWidth: 2,
            }
            // NOTE: social-9x16 Defaults to 1080p's social-9x16 preset
        },
    },
};

/**
 * Get preset configuration and dimensions for a given resolution and aspect ratio
 * Handles 9:16 aspect ratio by finding corresponding 16:9 preset
 * Uses sequential fallback (first available preset) if exact match not found
 */
function getPresetConfig(resolution: string, aspectRatio: AspectRatio): {
    config: ResolutionPreset;
    dimensions: { width: number; height: number };
} {
    // Handle 9:16 aspect ratio by finding corresponding 16:9 preset
    if (aspectRatio === 'social-9x16') {
        const [width, height] = resolution.split('x').map(n => parseInt(n, 10));
        const swappedResolution = `${height}x${width}`;

        // Try exact match first
        if (RESOLUTION_PRESETS[swappedResolution]) {
            return {
                config: RESOLUTION_PRESETS[swappedResolution],
                dimensions: { width: height, height: width } // Swapped for social
            };
        }

        // Fallback: use first available preset for social
        const firstPresetKey = Object.keys(RESOLUTION_PRESETS)[0];
        const [fallbackWidth, fallbackHeight] = firstPresetKey.split('x').map(n => parseInt(n, 10));
        return {
            config: RESOLUTION_PRESETS[firstPresetKey],
            dimensions: { width: fallbackHeight, height: fallbackWidth } // Swapped for social
        };
    }

    // Default aspect ratio - direct lookup with fallback
    if (RESOLUTION_PRESETS[resolution]) {
        const [width, height] = resolution.split('x').map(n => parseInt(n, 10));
        return {
            config: RESOLUTION_PRESETS[resolution],
            dimensions: { width, height }
        };
    }

    // Fallback: use first available preset
    const firstPresetKey = Object.keys(RESOLUTION_PRESETS)[0];
    const [fallbackWidth, fallbackHeight] = firstPresetKey.split('x').map(n => parseInt(n, 10));
    return {
        config: RESOLUTION_PRESETS[firstPresetKey],
        dimensions: { width: fallbackWidth, height: fallbackHeight }
    };
}

// Speaker overlay constants - keep only styling/flags; numeric layout comes from RESOLUTION_PRESETS
const SPEAKER_OVERLAY_CONSTANTS = {
    // Feature flags
    ENABLED: true,
    PARTY_ACCENT_ENABLED: true,
    DISPLAY_MODE: 'always' as 'always' | 'on_speaker_change',

    // Typography hierarchy
    SPEAKER_NAME_FONT_RATIO: 1.2,        // Speaker name 20% larger than base
    PARTY_INFO_FONT_RATIO: 0.85,         // Party info 15% smaller than base

    // Styling
    BACKGROUND_COLOR: 'black@0.8',
    TEXT_COLOR: '#e0e0e0',
    BORDER_WIDTH: 0,
    BORDER_COLOR: 'black@0.3',

    // Timing
    FADE_DURATION: 0.2,
};

/**
 * Get video resolution using ffprobe
 * @param videoPath Path to the video file
 * @returns Promise<{width: number, height: number}> Video dimensions
 */
export async function getVideoResolution(videoPath: string): Promise<{ width: number, height: number }> {
    try {
        console.log(`🔍 Getting video resolution for: ${videoPath}`);

        // Resolve ffprobe path: allow override via env, fallback to system ffprobe
        const ffprobePath = process.env.FFPROBE_PATH || 'ffprobe';

        // Use ffprobe to get video stream dimensions
        const command = `${ffprobePath} -v quiet -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${videoPath}"`;

        const { stdout, stderr } = await execAsync(command);

        if (stderr) {
            console.warn(`⚠️ ffprobe stderr: ${stderr}`);
        }

        // Parse the output (format: "width,height")
        const dimensions = stdout.trim().split(',');

        if (dimensions.length !== 2) {
            throw new Error(`Invalid ffprobe output format: ${stdout}`);
        }

        const width = parseInt(dimensions[0], 10);
        const height = parseInt(dimensions[1], 10);

        if (isNaN(width) || isNaN(height) || width <= 0 || height <= 0) {
            throw new Error(`Invalid video dimensions: ${width}x${height}`);
        }

        console.log(`📐 Video resolution: ${width}x${height}`);

        return { width, height };

    } catch (error) {
        console.error(`❌ Failed to get video resolution for ${videoPath}:`, error);
        throw new Error(`Failed to get video resolution: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * Generate FFmpeg filter for social-9x16 transformation
 * Converts any input aspect ratio to 9:16 output with configurable margins and zoom
 * Now size-agnostic - works with any input dimensions
 */
export function generateSocialFilter(
    options: Required<NonNullable<GenerateHighlightRequest['render']['socialOptions']>>,
    inputVideoWidth: number,
    inputVideoHeight: number
): string {
    const { marginType, backgroundColor, zoomFactor } = options;

    console.log(`🎬 Social filter: zoom=${zoomFactor}, marginType=${marginType}`);

    if (marginType === 'blur') {
        return generateBlurredMarginFilter(zoomFactor, inputVideoWidth, inputVideoHeight);
    } else {
        return generateSolidMarginFilter(zoomFactor, backgroundColor, inputVideoWidth, inputVideoHeight);
    }
}

/**
 * Generate filter for solid color margins
 * Size-agnostic approach using relative scaling
 */
function generateSolidMarginFilter(
    zoomFactor: number,
    backgroundColor: string,
    inputVideoWidth: number,
    inputVideoHeight: number
): string {
    // Normalize color for FFmpeg (support #RRGGBB and names)
    const padColor = backgroundColor.startsWith('#') ? `0x${backgroundColor.slice(1)}` : backgroundColor;

    // Get social resolution from preset system
    const resolution = `${inputVideoWidth}x${inputVideoHeight}`;
    const { dimensions } = getPresetConfig(resolution, 'social-9x16');
    const socialWidth = dimensions.width;
    const socialHeight = dimensions.height;

    console.log(`🎬 Social filter using resolution: ${socialWidth}x${socialHeight} (from input: ${inputVideoWidth}x${inputVideoHeight})`);

    // Size-agnostic transformation to 9:16 aspect ratio
    // This approach works with any input dimensions
    const chainParts: string[] = [
        // Step 1: Scale video based on zoom factor while maintaining aspect ratio
        // The scale filter will automatically fit the video into 9:16 format
        `scale='if(gt(a,9/16),${socialWidth},-1)':'if(gt(a,9/16),-1,${socialHeight})'`,

        // Step 2: Apply zoom by scaling again
        `scale='iw*${zoomFactor}':'ih*${zoomFactor}'`,

        // Step 3: Pad to exact social resolution with colored margins, centering the video
        `pad=${socialWidth}:${socialHeight}:(ow-iw)/2:(oh-ih)/2:${padColor}`,

        // Step 4: Ensure widely compatible pixel format
        `format=yuv420p`,

        // Step 5: Force portrait sample and display aspect ratios
        `setsar=1`,
        `setdar=9/16`
    ];

    return chainParts.join(',');
}

/**
 * Generate filter for blurred background margins
 * Size-agnostic approach using relative scaling
 */
function generateBlurredMarginFilter(
    zoomFactor: number,
    inputVideoWidth: number,
    inputVideoHeight: number
): string {
    // Get social resolution from preset system
    const resolution = `${inputVideoWidth}x${inputVideoHeight}`;
    const { dimensions } = getPresetConfig(resolution, 'social-9x16');
    const socialWidth = dimensions.width;
    const socialHeight = dimensions.height;

    console.log(`🎬 Blurred social filter using resolution: ${socialWidth}x${socialHeight} (from input: ${inputVideoWidth}x${inputVideoHeight})`);

    return [
        // Split input into two branches: one for background, one for foreground video
        'split=2[bg][video]',

        // Background branch: scale to fill social resolution, crop to exact frame, then blur
        `[bg]scale=${socialWidth}:${socialHeight}:force_original_aspect_ratio=increase,crop=${socialWidth}:${socialHeight},gblur=sigma=20[blurred]`,

        // Video branch: scale based on aspect ratio and zoom factor
        `[video]scale='if(gt(a,9/16),${socialWidth},-1)':'if(gt(a,9/16),-1,${socialHeight})',scale='iw*${zoomFactor}':'ih*${zoomFactor}'[scaled]`,

        // Composite: overlay sharp video on blurred background, centered
        `[blurred][scaled]overlay=(W-w)/2:(H-h)/2,setsar=1,setdar=9/16`
    ].join(';');
}


function calculateOptimalFontSizeWithStartAndCap(
    text: string,
    aspectRatio: AspectRatio,
    startFontSize: number,
    maxFontSize: number,
    sidePaddingPx: number,
    frameWidth: number,
    maxLinesOverride?: number
): { fontSize: number; wrappedText: string } {
    // Override available width computation to fixed pixel based on preset side padding
    const isSocial = aspectRatio === 'social-9x16';
    const maxLines = maxLinesOverride ?? (isSocial ? 6 : 3); // Fallback values
    const minFont = CAPTION_CONSTANTS.MIN_FONT_SIZE;
    const availableWidthPx = Math.max(50, frameWidth - sidePaddingPx * 2);

    let fontSize = Math.max(minFont, Math.min(maxFontSize, startFontSize));
    let wrappedText = wrapTextByPixelWidth(text, fontSize, availableWidthPx);
    let lines = wrappedText.split('\n');
    if (lines.length <= maxLines) {
        return { fontSize, wrappedText };
    }
    let attempts = 0;
    while (fontSize > minFont && attempts < 20) {
        attempts++;
        fontSize = Math.max(minFont, fontSize - 1);
        wrappedText = wrapTextByPixelWidth(text, fontSize, availableWidthPx);
        lines = wrappedText.split('\n');
        if (lines.length <= maxLines) return { fontSize, wrappedText };
    }
    // truncate
    wrappedText = wrapTextByPixelWidth(text, minFont, availableWidthPx);
    lines = wrappedText.split('\n');
    if (lines.length > maxLines) {
        const truncated = lines.slice(0, maxLines);
        const charWidth = minFont * CAPTION_CONSTANTS.FONT_CHAR_WIDTH_RATIO;
        const estimatedChars = Math.max(10, Math.floor(availableWidthPx / charWidth));
        const last = truncated[truncated.length - 1];
        truncated[truncated.length - 1] = (last.length > estimatedChars - 3)
            ? last.substring(0, estimatedChars - 3) + '...'
            : last + '...';
        wrappedText = truncated.join('\n');
    }
    return { fontSize: minFont, wrappedText };
}

// Pixel-based wrapper used by resolution presets
function wrapTextByPixelWidth(text: string, fontSize: number, availableWidthPx: number): string {
    const words = text.split(' ');
    const lines: string[] = [];
    let currentLine = '';
    const charWidth = fontSize * CAPTION_CONSTANTS.FONT_CHAR_WIDTH_RATIO;
    const estimatedCharsPerLine = Math.max(10, Math.floor(availableWidthPx / charWidth));
    for (const word of words) {
        const testLine = currentLine ? `${currentLine} ${word}` : word;
        if (testLine.length <= estimatedCharsPerLine) {
            currentLine = testLine;
        } else {
            if (currentLine) {
                lines.push(currentLine);
                currentLine = word;
            } else {
                lines.push(word);
                currentLine = '';
            }
        }
    }
    if (currentLine) lines.push(currentLine);
    return lines.join('\n');
}

/**
 * Generate caption filters for video highlighting
 * Creates drawtext filters for each utterance with precise timing
 * Automatically normalizes timestamps for concatenated segments
 * Now uses dynamic font sizing to avoid truncation
 */
export async function generateCaptionFilters(
    utterances: Array<{
        text: string;
        startTimestamp: number;
        endTimestamp: number;
    }>,
    aspectRatio: AspectRatio,
    inputVideoWidth: number,
    inputVideoHeight: number
): Promise<string> {
    if (utterances.length === 0) {
        return '';
    }

    // Ensure font is available
    const fontPath = await ensureFontAvailable();

    const resolution = `${inputVideoWidth}x${inputVideoHeight}`;
    const { config } = getPresetConfig(resolution, aspectRatio);
    const cap = config.caption[aspectRatio];

    if (!cap) {
        throw new Error(`Missing caption configuration for ${aspectRatio} aspect ratio in ${resolution} preset`);
    }

    console.log(`📐 Caption resolution: ${resolution} (${aspectRatio})`);

    // Fixed pixel bottom padding from preset
    const yPosition = `h-${cap.bottomPadding}`;

    // Normalize timestamps for concatenated timeline
    const normalizedUtterances = normalizeUtteranceTimestamps(utterances);

    // Generate drawtext filter for each utterance with dynamic font sizing
    const captionFilters = normalizedUtterances.map((utterance, index) => {
        // Calculate optimal font size and wrapped text for this utterance
        // Start size scaled from frame height
        const baseStartFont = cap.startFont;
        const maxFont = cap.maxFont;

        // For social-9x16, use the output width (swapped dimensions) for text wrapping
        const textWrapWidth = aspectRatio === 'social-9x16' ?
            getPresetConfig(`${inputVideoWidth}x${inputVideoHeight}`, 'social-9x16').dimensions.width :
            inputVideoWidth;

        const { fontSize, wrappedText } = calculateOptimalFontSizeWithStartAndCap(
            utterance.text,
            aspectRatio,
            baseStartFont,
            maxFont,
            cap.sidePadding,
            textWrapWidth,
            cap.maxLines
        );

        // Escape text for FFmpeg (wrappedText already contains newlines)
        const escapedText = escapeTextForFFmpeg(wrappedText, aspectRatio);

        return `drawtext=` +
            `fontfile='${fontPath}':` + // Use downloaded font file
            `text='${escapedText}':` +
            `enable='between(t,${utterance.normalizedStart},${utterance.normalizedEnd})':` +
            `x=(w-text_w)/2:` + // Center horizontally
            `y=${yPosition}:` +
            `fontsize=${fontSize}:` +
            `fontcolor=${CAPTION_CONSTANTS.FONT_COLOR}:` +
            `box=1:` +
            `boxcolor=${CAPTION_CONSTANTS.BACKGROUND_COLOR}:` +
            `boxborderw=5:` +
            `borderw=${CAPTION_CONSTANTS.BORDER_WIDTH}:` +
            `bordercolor=${CAPTION_CONSTANTS.BORDER_COLOR}`;
    });

    return captionFilters.join(',');
}

/**
 * Normalize utterance timestamps for concatenated highlight timeline
 * When utterances are concatenated, each segment becomes sequential in the output
 */
function normalizeUtteranceTimestamps(utterances: Array<{
    text: string;
    startTimestamp: number;
    endTimestamp: number;
}>): Array<{
    text: string;
    normalizedStart: number;
    normalizedEnd: number;
    originalStart: number;
    originalEnd: number;
}> {
    let currentTime = 0;

    return utterances.map((utterance) => {
        const duration = utterance.endTimestamp - utterance.startTimestamp;
        const normalizedStart = currentTime;
        const normalizedEnd = currentTime + duration;

        // Update current time for next utterance
        currentTime = normalizedEnd;

        return {
            text: utterance.text,
            normalizedStart,
            normalizedEnd,
            originalStart: utterance.startTimestamp,
            originalEnd: utterance.endTimestamp
        };
    });
}


/**
 * Escape text for safe use in FFmpeg drawtext filter
 * Text should already be wrapped with newlines from calculateOptimalFontSize
 */
function escapeTextForFFmpeg(text: string, aspectRatio: AspectRatio = 'default'): string {
    return text
        // Escape colons that would interfere with filter parsing
        .replace(/:/g, '\\:')
        // Escape single quotes
        .replace(/'/g, "\\'")
        // Escape backslashes
        .replace(/\\/g, '\\\\')
        // Escape percent signs (used for text expansion)
        .replace(/%/g, '\\%');
}

// Speaker overlay types and interfaces
interface SpeakerInfo {
    name: string;
    role?: string;
    party?: string;
    partyColor?: string;
}

interface SpeakerDisplaySegment {
    speakerInfo: SpeakerInfo;
    startTime: number;
    endTime: number;
    showOverlay: boolean;
}

/**
 * Format speaker information for display
 * Returns primary text (name) and secondary text (role, party)
 */
function formatSpeakerInfo(speaker?: GenerateHighlightRequest['parts'][0]['utterances'][0]['speaker']): SpeakerInfo {
    const name = speaker?.name || 'Unknown Speaker';

    return {
        name,
        role: speaker?.roleLabel,
        party: speaker?.partyLabel,
        partyColor: speaker?.partyColorHex
    };
}

/**
 * Calculate when to show speaker overlays based on display mode
 * Handles both 'always' mode and 'on_speaker_change' mode
 */
function calculateSpeakerDisplaySegments(
    utterances: Array<{
        text: string;
        startTimestamp: number;
        endTimestamp: number;
        speaker?: GenerateHighlightRequest['parts'][0]['utterances'][0]['speaker'];
    }>,
    displayMode: 'always' | 'on_speaker_change'
): SpeakerDisplaySegment[] {
    if (utterances.length === 0) {
        return [];
    }

    // Normalize timestamps for concatenated timeline
    const normalizedUtterances = normalizeUtteranceTimestamps(utterances);

    const segments: SpeakerDisplaySegment[] = [];
    let lastSpeakerId: string | undefined;

    for (const utterance of normalizedUtterances) {
        const currentSpeakerId = utterance.originalStart + '-' + (utterance.text || 'unknown'); // Use a combination for uniqueness
        const speakerInfo = formatSpeakerInfo(utterances.find(u =>
            u.startTimestamp === utterance.originalStart && u.endTimestamp === utterance.originalEnd
        )?.speaker);

        let showOverlay = false;

        if (displayMode === 'always') {
            showOverlay = true;
        } else if (displayMode === 'on_speaker_change') {
            // Show overlay when speaker changes or for the first utterance
            const actualSpeakerId = utterances.find(u =>
                u.startTimestamp === utterance.originalStart && u.endTimestamp === utterance.originalEnd
            )?.speaker?.id || speakerInfo.name;

            showOverlay = !lastSpeakerId || lastSpeakerId !== actualSpeakerId;
            lastSpeakerId = actualSpeakerId;
        }

        segments.push({
            speakerInfo,
            startTime: utterance.normalizedStart,
            endTime: utterance.normalizedEnd,
            showOverlay
        });
    }

    return segments;
}

/**
 * Wrap speaker text (role/party) to fit within the overlay box
 * Simple character-based wrapping
 */
function wrapSpeakerText(text: string, isSocial: boolean): string {
    // Character limits based on aspect ratio
    const maxCharsPerLine = isSocial ? 25 : 35;

    if (text.length <= maxCharsPerLine) {
        return text;
    }

    const words = text.split(' ');
    const lines: string[] = [];
    let currentLine = '';

    for (const word of words) {
        const testLine = currentLine ? `${currentLine} ${word}` : word;

        if (testLine.length <= maxCharsPerLine) {
            currentLine = testLine;
        } else {
            if (currentLine) {
                lines.push(currentLine);
                currentLine = word;
            } else {
                // Single word is too long, force it on the line anyway
                lines.push(word);
                currentLine = '';
            }
        }
    }

    if (currentLine) {
        lines.push(currentLine);
    }

    return lines.join('\n');
}

/**
 * Generate FFmpeg drawtext filter for speaker overlay (simplified approach)
 */
function generateSpeakerOverlayDrawtext(
    segment: SpeakerDisplaySegment,
    aspectRatio: AspectRatio,
    fontPath: string,
    layout: {
        boxX: number; boxY: number; baseFontSize: number; maxWidth: number;
        paddingH: number; paddingV: number; lineSpacing: number;
    }
): string[] {
    const isSocial = aspectRatio === 'social-9x16';
    const constants = SPEAKER_OVERLAY_CONSTANTS;

    // Simple pixel-based positioning
    const boxX = layout.boxX;
    const boxY = layout.boxY;
    const baseFontSize = layout.baseFontSize;
    const maxWidth = layout.maxWidth;

    // Calculate font sizes
    const nameFontSize = Math.round(baseFontSize * constants.SPEAKER_NAME_FONT_RATIO);
    const partyFontSize = Math.round(baseFontSize * constants.PARTY_INFO_FONT_RATIO);

    // Process speaker info with text wrapping
    const speakerName = segment.speakerInfo.name;
    const partyInfo: string[] = [];

    if (segment.speakerInfo.role) {
        const wrappedRole = wrapSpeakerText(segment.speakerInfo.role, isSocial);
        partyInfo.push(wrappedRole);
    }
    if (segment.speakerInfo.party && !segment.speakerInfo.role) {
        const wrappedParty = wrapSpeakerText(segment.speakerInfo.party, isSocial);
        partyInfo.push(wrappedParty);
    }

    // Calculate box dimensions dynamically
    const hasPartyInfo = partyInfo.length > 0;

    // Calculate height based on content
    const paddingV = layout.paddingV;
    const paddingH = layout.paddingH;
    const lineSpacing = layout.lineSpacing;

    let boxHeight = nameFontSize + (paddingV * 2);
    if (hasPartyInfo) {
        const partyLines = partyInfo.map(text => text.split('\n').length).reduce((sum, lines) => sum + lines, 0);
        boxHeight += (partyFontSize * partyLines) + lineSpacing;
    }

    // Calculate width based on speaker name and party info
    // Estimate character width as ~0.6 of font size (typical for most fonts)
    const nameCharWidth = nameFontSize * 0.6;
    const partyCharWidth = partyFontSize * 0.6;

    // Calculate width needed for speaker name
    const nameWidth = speakerName.length * nameCharWidth;

    // Calculate width needed for party info (if present)
    let partyWidth = 0;
    if (hasPartyInfo) {
        const partyText = partyInfo.join(', ');
        partyWidth = partyText.length * partyCharWidth;
    }

    // Use the wider of name or party info, plus padding
    const contentWidth = Math.max(nameWidth, partyWidth);
    const boxWidth = Math.min(
        Math.max(contentWidth + (paddingH * 2), 120),
        maxWidth
    );

    const filters: string[] = [];

    // Step 1: Draw background box
    filters.push(
        `drawbox=` +
        `x=${boxX}:` +
        `y=${boxY}:` +
        `w=${boxWidth}:` +
        `h=${boxHeight}:` +
        `color=${constants.BACKGROUND_COLOR}:` +
        `t=fill:` +
        `enable='between(t,${segment.startTime},${segment.endTime})'`
    );

    // Step 2: Draw speaker name
    const escapedName = escapeTextForFFmpeg(speakerName, aspectRatio);
    const nameX = boxX + paddingH;
    const nameY = boxY + paddingV;

    filters.push(
        `drawtext=` +
        `fontfile='${fontPath}':` +
        `text='${escapedName}':` +
        `enable='between(t,${segment.startTime},${segment.endTime})':` +
        `x=${nameX}:` +
        `y=${nameY}:` +
        `fontsize=${nameFontSize}:` +
        `fontcolor=${constants.TEXT_COLOR}:` +
        `box=0`
    );

    // Step 3: Draw party info if present
    if (hasPartyInfo) {
        const partyText = partyInfo.join(', ');
        const escapedPartyText = escapeTextForFFmpeg(partyText, aspectRatio);
        const partyX = nameX;
        const partyY = nameY + nameFontSize + lineSpacing;

        filters.push(
            `drawtext=` +
            `fontfile='${fontPath}':` +
            `text='${escapedPartyText}':` +
            `enable='between(t,${segment.startTime},${segment.endTime})':` +
            `x=${partyX}:` +
            `y=${partyY}:` +
            `fontsize=${partyFontSize}:` +
            `fontcolor=${constants.TEXT_COLOR}:` +
            `box=0`
        );
    }

    return filters;
}

/**
 * Generate party color accent filter (simplified approach)
 */
function generatePartyAccentFilter(
    segment: SpeakerDisplaySegment,
    aspectRatio: AspectRatio,
    layoutOverrides?: {
        baseFontSize: number; paddingV: number; lineSpacing: number;
        accentX: number; accentY: number; accentWidth: number;
    }
): string | null {
    if (!SPEAKER_OVERLAY_CONSTANTS.PARTY_ACCENT_ENABLED || !segment.speakerInfo.partyColor) {
        return null;
    }

    const isSocial = aspectRatio === 'social-9x16';
    const constants = SPEAKER_OVERLAY_CONSTANTS;

    // Simple pixel-based positioning
    const accentX = layoutOverrides ? layoutOverrides.accentX : 0;
    const accentY = layoutOverrides ? layoutOverrides.accentY : 0;
    const accentWidth = layoutOverrides ? layoutOverrides.accentWidth : 0;

    // Calculate accent height to match main box (same logic as main box)
    const baseFontSize = layoutOverrides ? layoutOverrides.baseFontSize : 14;
    const nameFontSize = Math.round(baseFontSize * constants.SPEAKER_NAME_FONT_RATIO);
    const partyFontSize = Math.round(baseFontSize * constants.PARTY_INFO_FONT_RATIO);

    const paddingV = layoutOverrides ? layoutOverrides.paddingV : 6;
    const lineSpacing = layoutOverrides ? layoutOverrides.lineSpacing : 4;

    let accentHeight = nameFontSize + (paddingV * 2);

    if (segment.speakerInfo.role || segment.speakerInfo.party) {
        const partyText = segment.speakerInfo.role || segment.speakerInfo.party || '';
        const wrappedPartyText = wrapSpeakerText(partyText, isSocial);
        const partyLines = wrappedPartyText.split('\n').length;
        accentHeight += (partyFontSize * partyLines) + lineSpacing;
    }

    // Convert hex color to RGB for FFmpeg
    const color = segment.speakerInfo.partyColor.startsWith('#') ?
        segment.speakerInfo.partyColor :
        `#${segment.speakerInfo.partyColor}`;

    return `drawbox=x=${accentX}:y=${accentY}:w=${accentWidth}:h=${accentHeight}:color=${color}:t=fill:enable='between(t,${segment.startTime},${segment.endTime})'`;
}

/**
 * Generate complete speaker overlay filter for video highlighting
 * Creates speaker information overlays with precise timing
 */
export async function generateSpeakerOverlayFilter(
    utterances: Array<{
        text: string;
        startTimestamp: number;
        endTimestamp: number;
        speaker?: GenerateHighlightRequest['parts'][0]['utterances'][0]['speaker'];
    }>,
    aspectRatio: AspectRatio,
    inputVideoWidth: number,
    inputVideoHeight: number
): Promise<string> {
    if (!SPEAKER_OVERLAY_CONSTANTS.ENABLED || utterances.length === 0) {
        return '';
    }

    // Ensure font is available
    const fontPath = await ensureFontAvailable();

    const resolution = `${inputVideoWidth}x${inputVideoHeight}`;
    const { config } = getPresetConfig(resolution, aspectRatio);
    const o = config.overlay[aspectRatio];

    if (!o) {
        throw new Error(`Missing overlay configuration for ${aspectRatio} aspect ratio in ${resolution} preset`);
    }

    // Calculate when to show overlays based on display mode
    const displaySegments = calculateSpeakerDisplaySegments(utterances, SPEAKER_OVERLAY_CONSTANTS.DISPLAY_MODE);

    const allFilters: string[] = [];
    const layout = {
        boxX: o.leftPadding,
        boxY: o.topPadding,
        baseFontSize: o.baseFontSize,
        maxWidth: o.maxWidth,
        paddingH: o.paddingH,
        paddingV: o.paddingV,
        lineSpacing: o.lineSpacing,
        accentX: o.leftPadding,
        accentY: o.topPadding,
        accentWidth: o.accentWidth,
    };

    // Generate text overlay filters (includes background boxes and text)
    for (const segment of displaySegments) {
        if (segment.showOverlay) {
            const textFilters = generateSpeakerOverlayDrawtext(segment, aspectRatio, fontPath, layout);
            allFilters.push(...textFilters);

            // Add party accent on top of the background (after background but before text)
            if (SPEAKER_OVERLAY_CONSTANTS.PARTY_ACCENT_ENABLED) {
                const accentFilter = generatePartyAccentFilter(segment, aspectRatio, {
                    baseFontSize: layout.baseFontSize,
                    paddingV: layout.paddingV,
                    lineSpacing: layout.lineSpacing,
                    accentX: layout.accentX,
                    accentY: layout.accentY,
                    accentWidth: layout.accentWidth,
                });
                if (accentFilter) {
                    // Insert accent filter after background but before text
                    // Background is first (index 0), so insert accent at index 1
                    allFilters.splice(-textFilters.length + 1, 0, accentFilter);
                }
            }
        }
    }

    return allFilters.join(',');
}

/**
 * Ensure font is available for caption rendering
 * Downloads the font if it doesn't exist locally
 */
async function ensureFontAvailable(): Promise<string> {
    const fontsDir = path.join(dataDir, 'fonts');
    const fontPath = path.join(fontsDir, CAPTION_CONSTANTS.FONT_FILENAME);

    // Check if font already exists
    if (fs.existsSync(fontPath)) {
        return fontPath;
    }

    // Create fonts directory if it doesn't exist
    if (!fs.existsSync(fontsDir)) {
        fs.mkdirSync(fontsDir, { recursive: true });
        console.log(`📁 Created fonts directory: ${fontsDir}`);
    }

    console.log(`📝 Downloading font from: ${CAPTION_CONSTANTS.FONT_URL}`);

    try {
        const fontData = await downloadFile(CAPTION_CONSTANTS.FONT_URL);

        // Move downloaded font to the correct location
        fs.renameSync(fontData, fontPath);
        console.log(`✅ Font downloaded successfully: ${fontPath}`);

        return fontPath;
    } catch (error) {
        console.error(`❌ Failed to download font:`, error);
        throw new Error(`Failed to download font from ${CAPTION_CONSTANTS.FONT_URL}: ${error instanceof Error ? error.message : String(error)}`);
    }
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
 * Merge continuous utterances to avoid unnatural cuts
 * Utterances are considered continuous if the gap between them is <= maxGapSeconds
 */
export function mergeContinuousUtterances<T extends { startTimestamp: number; endTimestamp: number }>(
    utterances: T[],
    maxGapSeconds: number = 2.0
): Array<{
    startTimestamp: number;
    endTimestamp: number;
    originalUtterances: T[];
}> {
    if (utterances.length === 0) {
        return [];
    }

    // Sort utterances by start time to ensure proper ordering
    const sortedUtterances = [...utterances].sort((a, b) => a.startTimestamp - b.startTimestamp);

    const mergedSegments: Array<{
        startTimestamp: number;
        endTimestamp: number;
        originalUtterances: T[];
    }> = [];

    let currentSegment = {
        startTimestamp: sortedUtterances[0].startTimestamp,
        endTimestamp: sortedUtterances[0].endTimestamp,
        originalUtterances: [sortedUtterances[0]]
    };

    for (let i = 1; i < sortedUtterances.length; i++) {
        const utterance = sortedUtterances[i];
        const gap = utterance.startTimestamp - currentSegment.endTimestamp;

        if (gap <= maxGapSeconds) {
            // Merge with current segment
            currentSegment.endTimestamp = utterance.endTimestamp;
            currentSegment.originalUtterances.push(utterance);
        } else {
            // Start new segment
            mergedSegments.push(currentSegment);
            currentSegment = {
                startTimestamp: utterance.startTimestamp,
                endTimestamp: utterance.endTimestamp,
                originalUtterances: [utterance]
            };
        }
    }

    // Don't forget the last segment
    mergedSegments.push(currentSegment);

    console.log(`📎 Merged ${sortedUtterances.length} utterances into ${mergedSegments.length} continuous segments`);
    mergedSegments.forEach((segment, index) => {
        console.log(`   Segment ${index + 1}: ${segment.startTimestamp}s - ${segment.endTimestamp}s (${segment.originalUtterances.length} utterances)`);
    });

    return mergedSegments;
}

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
