import type { CaptionPreset } from './types.js';

// NOTE: font.family values must equal the bundled fonts' INTERNAL family names
// (asserted by src/lib/captions/fonts.test.ts).
//
// Portrait yPct: a 16:9 source letterboxed into 9:16 ends at 65.8% of the frame
// at the maximum zoom (1.0), so anything centred higher than ~70 puts a caption's
// upper line over the video instead of the blurred band beneath it. 70 keeps a
// two-line page just below that edge and clear of the bottom-25% platform UI.
export const CAPTION_PRESETS: Record<string, CaptionPreset> = {
    /**
     * Chosen by the marketing team in the caption studio, tuned per format:
     * 9:16 carries their portrait values, 16:9 their landscape session's.
     */
    team: {
        id: 'team',
        name: 'Team pick',
        font: { family: 'Inter Black', sizePct: 3, uppercase: false },
        colors: { text: '#FFFFFF', active: '#FFD60A' },
        stroke: { width: 6, color: '#151414' },
        shadow: { depth: 2, color: '#000000' },
        emphasis: { style: 'pop', scalePct: 106 },
        layout: { maxWordsPerPage: 3, combineWithinMs: 1200, minPageDurationMs: 1000 },
        position: { yPct: 70, maxWidthPct: 69 },
        landscape: {
            font: { sizePct: 5.5 },
            stroke: { width: 8, color: '#151414' },
            shadow: { depth: 6, color: '#000000' },
            layout: { maxWordsPerPage: 6 },
            position: { yPct: 84, maxWidthPct: 74 },
        },
    },
    sweep: {
        id: 'sweep',
        name: 'Karaoke sweep',
        font: { family: 'Inter Black', sizePct: 4.5, uppercase: true },
        colors: { text: '#FFFFFF', active: '#FF8C33' },
        stroke: { width: 6, color: '#000000' },
        shadow: { depth: 3, color: '#000000' },
        emphasis: { style: 'karaoke' },
        layout: { maxWordsPerPage: 4, combineWithinMs: 1200, minPageDurationMs: 1000 },
        position: { yPct: 70, maxWidthPct: 80 },
        landscape: { position: { yPct: 82 } },
    },
    pop: {
        id: 'pop',
        name: 'Active word pop',
        font: { family: 'Inter Black', sizePct: 4.5, uppercase: true },
        colors: { text: '#FFFFFF', active: '#FFD60A' },
        stroke: { width: 6, color: '#000000' },
        shadow: { depth: 3, color: '#000000' },
        emphasis: { style: 'pop', scalePct: 106 },
        layout: { maxWordsPerPage: 4, combineWithinMs: 1200, minPageDurationMs: 1000 },
        position: { yPct: 70, maxWidthPct: 80 },
        landscape: { position: { yPct: 82 } },
    },
    card: {
        id: 'card',
        name: 'White card',
        font: { family: 'Inter Black', sizePct: 3.8, uppercase: false },
        colors: { text: '#111111', active: '#FF6600' },
        container: { color: '#FFFFFF', opacity: 0.96, paddingPx: 16 },
        emphasis: { style: 'highlight' },
        layout: { maxWordsPerPage: 4, combineWithinMs: 1200, minPageDurationMs: 1000 },
        position: { yPct: 70, maxWidthPct: 78 },
        landscape: { position: { yPct: 82 } },
    },
};

// The team's pick, made from real renders of the alternatives in both formats.
// Overridable per environment via the runtime config file (see presetConfig.ts).
export const DEFAULT_PRESET_ID = 'team';

/**
 * Flatten a preset for the output frame's orientation. Portrait values are the
 * base; the landscape override group replaces them on 16:9 frames. Consumers
 * (timeline paging, ASS renderer) receive a resolved preset and never branch
 * on aspect themselves.
 */
export function resolveForOrientation(
    preset: CaptionPreset,
    frame: { width: number; height: number },
): CaptionPreset {
    if (frame.height > frame.width || !preset.landscape) {
        return preset;
    }
    const o = preset.landscape;
    const resolved: CaptionPreset = {
        ...preset,
        font: { ...preset.font, ...(o.font ?? {}) },
        colors: { ...preset.colors, ...(o.colors ?? {}) },
        emphasis: { ...preset.emphasis, ...(o.emphasis ?? {}) },
        layout: { ...preset.layout, ...(o.layout ?? {}) },
        position: { ...preset.position, ...(o.position ?? {}) },
        ...(o.stroke !== undefined ? { stroke: o.stroke } : {}),
        ...(o.shadow !== undefined ? { shadow: o.shadow } : {}),
        ...(o.container !== undefined ? { container: o.container } : {}),
    };
    // An override can introduce a container the base preset did not have, and
    // ASS draws a box or an outline, never both.
    if (resolved.container) {
        delete resolved.stroke;
        delete resolved.shadow;
    }
    return resolved;
}
