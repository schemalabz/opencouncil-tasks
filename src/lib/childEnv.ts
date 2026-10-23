/**
 * Environment for the ffmpeg and ffprobe child processes.
 *
 * The task server holds API keys and storage credentials in its environment.
 * An ffmpeg filter graph can read files, and on Linux the process environment
 * is a file, so these children must not inherit the secrets. They work on
 * local files only, so the allowlist keeps the lookup path, the locale, the
 * temp dir, and the fontconfig variables that libass reads.
 */

const INHERITED_VARS = [
    'PATH',
    'HOME',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'FONTCONFIG_FILE',
    'FONTCONFIG_PATH',
    'FONTCONFIG_SYSROOT',
    'XDG_CACHE_HOME',
] as const;

export function childEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const name of INHERITED_VARS) {
        if (source[name] !== undefined) {
            env[name] = source[name];
        }
    }
    return env;
}
