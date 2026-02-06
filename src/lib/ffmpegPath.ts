/**
 * Get the path to the ffmpeg binary.
 *
 * Checks for FFMPEG_BIN_PATH environment variable first (useful for Nix/NixOS deployments
 * where ffmpeg-static's download is skipped and system ffmpeg is used instead).
 * Falls back to ffmpeg-static if the environment variable is not set.
 */

import ffmpegStatic from 'ffmpeg-static';

/**
 * Returns the path to the ffmpeg binary.
 * @throws Error if no ffmpeg binary is available
 */
export function getFfmpegPath(): string {
    // Check environment variable first (used in Nix/preview deployments)
    const envPath = process.env.FFMPEG_BIN_PATH;
    if (envPath) {
        return envPath;
    }

    // Fall back to ffmpeg-static
    const staticPath = ffmpegStatic as unknown as string | null;
    if (staticPath) {
        return staticPath;
    }

    throw new Error(
        'No ffmpeg binary available. Either set FFMPEG_BIN_PATH environment variable ' +
        'or ensure ffmpeg-static has downloaded the binary.'
    );
}

/**
 * The ffmpeg binary path (resolved once at module load).
 * Use getFfmpegPath() if you need to handle errors explicitly.
 */
let _cachedPath: string | null = null;

export function ffmpegPath(): string {
    if (_cachedPath === null) {
        _cachedPath = getFfmpegPath();
    }
    return _cachedPath;
}

export default ffmpegPath;
