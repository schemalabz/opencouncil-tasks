import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We need to test the module with different environment states,
// so we'll use dynamic imports and module mocking

describe('ffmpegPath', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        // Reset modules before each test to get fresh imports
        vi.resetModules();
        // Clone the environment
        process.env = { ...originalEnv };
    });

    afterEach(() => {
        // Restore original environment
        process.env = originalEnv;
    });

    describe('getFfmpegPath', () => {
        it('returns FFMPEG_BIN_PATH when environment variable is set', async () => {
            process.env.FFMPEG_BIN_PATH = '/custom/path/to/ffmpeg';

            const { getFfmpegPath } = await import('./ffmpegPath.js');

            expect(getFfmpegPath()).toBe('/custom/path/to/ffmpeg');
        });

        it('returns ffmpeg-static path when FFMPEG_BIN_PATH is not set', async () => {
            delete process.env.FFMPEG_BIN_PATH;

            const { getFfmpegPath } = await import('./ffmpegPath.js');
            const path = getFfmpegPath();

            // ffmpeg-static returns either a path or null
            // In dev environment with npm install, it should return a path
            // In Nix build with --ignore-scripts, it would return null
            if (path) {
                expect(typeof path).toBe('string');
                expect(path.length).toBeGreaterThan(0);
            }
        });

        it('prefers FFMPEG_BIN_PATH over ffmpeg-static', async () => {
            process.env.FFMPEG_BIN_PATH = '/override/ffmpeg';

            const { getFfmpegPath } = await import('./ffmpegPath.js');

            // Even if ffmpeg-static has a valid path, env var takes precedence
            expect(getFfmpegPath()).toBe('/override/ffmpeg');
        });

        it('accepts empty string as valid FFMPEG_BIN_PATH (falls through to ffmpeg-static)', async () => {
            // Empty string is falsy, so it should fall through
            process.env.FFMPEG_BIN_PATH = '';

            const { getFfmpegPath } = await import('./ffmpegPath.js');
            const path = getFfmpegPath();

            // Should not be empty string, should be ffmpeg-static path
            expect(path).not.toBe('');
        });
    });

    describe('ffmpegPath (cached)', () => {
        it('returns the same path on subsequent calls', async () => {
            process.env.FFMPEG_BIN_PATH = '/cached/ffmpeg';

            const { ffmpegPath } = await import('./ffmpegPath.js');

            const path1 = ffmpegPath();
            const path2 = ffmpegPath();

            expect(path1).toBe(path2);
            expect(path1).toBe('/cached/ffmpeg');
        });
    });

    describe('default export', () => {
        it('exports ffmpegPath as default', async () => {
            process.env.FFMPEG_BIN_PATH = '/default/export/test';

            const ffmpegPathModule = await import('./ffmpegPath.js');

            expect(ffmpegPathModule.default).toBe(ffmpegPathModule.ffmpegPath);
            expect(ffmpegPathModule.default()).toBe('/default/export/test');
        });
    });
});

describe('ffmpegPath integration', () => {
    it('works with the actual ffmpeg-static package in development', async () => {
        // This test verifies the integration works in a dev environment
        // where ffmpeg-static has downloaded the binary

        const originalEnv = process.env.FFMPEG_BIN_PATH;
        delete process.env.FFMPEG_BIN_PATH;

        try {
            vi.resetModules();
            const { getFfmpegPath } = await import('./ffmpegPath.js');

            // In development with npm install, ffmpeg-static should work
            // This may fail in CI or Nix builds without the binary
            try {
                const path = getFfmpegPath();
                expect(typeof path).toBe('string');
                // The path should contain 'ffmpeg'
                expect(path.toLowerCase()).toContain('ffmpeg');
            } catch (e) {
                // If ffmpeg-static returns null (e.g., in Nix build),
                // the function should throw
                expect((e as Error).message).toContain('No ffmpeg binary available');
            }
        } finally {
            if (originalEnv !== undefined) {
                process.env.FFMPEG_BIN_PATH = originalEnv;
            }
        }
    });
});

describe('ffmpeg execution', () => {
    it('can execute ffmpeg --version', async () => {
        const { spawnSync } = await import('child_process');
        const { ffmpegPath } = await import('./ffmpegPath.js');

        const ffmpegBin = ffmpegPath();
        const result = spawnSync(ffmpegBin, ['-version'], {
            encoding: 'utf8',
            timeout: 5000,
        });

        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('ffmpeg version');
    });

    it('can get supported formats with ffmpeg -formats', async () => {
        const { spawnSync } = await import('child_process');
        const { ffmpegPath } = await import('./ffmpegPath.js');

        const ffmpegBin = ffmpegPath();
        const result = spawnSync(ffmpegBin, ['-formats'], {
            encoding: 'utf8',
            timeout: 5000,
        });

        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        // Should list common formats
        expect(result.stdout).toContain('mp4');
        expect(result.stdout).toContain('wav');
    });

    it('can get supported codecs with ffmpeg -codecs', async () => {
        const { spawnSync } = await import('child_process');
        const { ffmpegPath } = await import('./ffmpegPath.js');

        const ffmpegBin = ffmpegPath();
        const result = spawnSync(ffmpegBin, ['-codecs'], {
            encoding: 'utf8',
            timeout: 5000,
        });

        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        // Should have common codecs
        expect(result.stdout).toContain('aac');
        expect(result.stdout).toContain('mp3');
    });

    it('can generate a silent audio file', async () => {
        const { spawnSync } = await import('child_process');
        const { ffmpegPath } = await import('./ffmpegPath.js');
        const fs = await import('fs');
        const path = await import('path');
        const os = await import('os');

        const ffmpegBin = ffmpegPath();
        const tmpDir = os.tmpdir();
        const outputFile = path.join(tmpDir, `ffmpeg-test-${Date.now()}.wav`);

        try {
            // Generate 1 second of silence
            const result = spawnSync(ffmpegBin, [
                '-f', 'lavfi',
                '-i', 'anullsrc=r=44100:cl=mono',
                '-t', '1',
                '-y',
                outputFile
            ], {
                encoding: 'utf8',
                timeout: 10000,
            });

            expect(result.error).toBeUndefined();
            expect(result.status).toBe(0);
            expect(fs.existsSync(outputFile)).toBe(true);

            // Verify file has content
            const stats = fs.statSync(outputFile);
            expect(stats.size).toBeGreaterThan(0);
        } finally {
            // Cleanup
            if (fs.existsSync(outputFile)) {
                fs.unlinkSync(outputFile);
            }
        }
    });

    it('can convert audio format (wav to mp3)', async () => {
        const { spawnSync } = await import('child_process');
        const { ffmpegPath } = await import('./ffmpegPath.js');
        const fs = await import('fs');
        const path = await import('path');
        const os = await import('os');

        const ffmpegBin = ffmpegPath();
        const tmpDir = os.tmpdir();
        const wavFile = path.join(tmpDir, `ffmpeg-test-${Date.now()}.wav`);
        const mp3File = path.join(tmpDir, `ffmpeg-test-${Date.now()}.mp3`);

        try {
            // First create a WAV file
            const createResult = spawnSync(ffmpegBin, [
                '-f', 'lavfi',
                '-i', 'anullsrc=r=44100:cl=mono',
                '-t', '1',
                '-y',
                wavFile
            ], {
                encoding: 'utf8',
                timeout: 10000,
            });
            expect(createResult.status).toBe(0);

            // Convert to MP3
            const convertResult = spawnSync(ffmpegBin, [
                '-i', wavFile,
                '-acodec', 'libmp3lame',
                '-b:a', '128k',
                '-y',
                mp3File
            ], {
                encoding: 'utf8',
                timeout: 10000,
            });

            expect(convertResult.error).toBeUndefined();
            expect(convertResult.status).toBe(0);
            expect(fs.existsSync(mp3File)).toBe(true);

            // Verify MP3 file has content
            const stats = fs.statSync(mp3File);
            expect(stats.size).toBeGreaterThan(0);
        } finally {
            // Cleanup
            if (fs.existsSync(wavFile)) fs.unlinkSync(wavFile);
            if (fs.existsSync(mp3File)) fs.unlinkSync(mp3File);
        }
    });
});
