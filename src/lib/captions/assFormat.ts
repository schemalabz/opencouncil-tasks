/** ASS event timestamp: H:MM:SS.CC (centisecond precision). */
export function msToAssTime(ms: number): string {
    const cs = Math.round(ms / 10);
    const h = Math.floor(cs / 360_000);
    const m = Math.floor((cs % 360_000) / 6_000);
    const s = Math.floor((cs % 6_000) / 100);
    const rest = cs % 100;
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(rest).padStart(2, '0')}`;
}

/** \k-family karaoke durations are centiseconds (unlike \t/\fad which are ms). */
export function msToCs(ms: number): number {
    return Math.round(ms / 10);
}

function hexToBgr(hex: string): string {
    // Malformed request colors (bad presets, unexpected input) must not produce
    // garbage ASS tags — fall back to white rather than emitting invalid color codes.
    if (!/^#?[0-9a-fA-F]{6}$/.test(hex)) return 'FFFFFF';
    const clean = hex.replace('#', '');
    const r = clean.slice(0, 2), g = clean.slice(2, 4), b = clean.slice(4, 6);
    return `${b}${g}${r}`.toUpperCase();
}

/** Inline override tag color: {\c&HBBGGRR&} */
export function hexToAssColorTag(hex: string): string {
    return `&H${hexToBgr(hex)}&`;
}

/** Style-line color: &HAABBGGRR (AA: 00 = opaque, FF = transparent). */
export function hexToAssStyleColor(hex: string, alpha = 0): string {
    return `&H${alpha.toString(16).padStart(2, '0').toUpperCase()}${hexToBgr(hex)}`;
}

/**
 * Braces would open override blocks and a backslash would start a control
 * sequence (\N, \h) even outside braces; newlines must become \N.
 */
export function escapeAssText(text: string): string {
    return text
        .replace(/\{/g, '(')
        .replace(/\}/g, ')')
        .replace(/\\/g, '/')
        .replace(/\r?\n/g, '\\N');
}
