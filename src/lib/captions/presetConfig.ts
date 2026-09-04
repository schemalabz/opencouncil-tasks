import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { CAPTION_PRESETS, DEFAULT_PRESET_ID } from './presets.js';
import { ALLOWED_FONT_FAMILIES } from './fonts.js';
import { getDataDir } from '../dataDir.js';
import type { CaptionPreset, EmphasisStyle } from './types.js';

/**
 * Caption presets can be overridden at runtime by a JSON file on the mounted
 * data volume, so styling changes ship without a rebuild:
 *
 *   { "default": "teamB", "presets": { "teamB": { …full or partial preset… } } }
 *
 * Overrides merge onto the built-in preset with the same id; an unknown id
 * defines a new preset and must be complete. Anything invalid is dropped with a
 * warning and the built-ins stand — a bad config must never break a render.
 */
export interface CaptionConfig {
    presets: Record<string, CaptionPreset>;
    defaultId: string;
    /** Absolute path of the file this config came from, when one was loaded. */
    sourcePath?: string;
}

const EMPHASIS_STYLES: EmphasisStyle[] = ['none', 'highlight', 'karaoke', 'pop'];
const REQUIRED_LEAVES = [
    'font.family', 'font.sizePct', 'font.uppercase', 'colors.text', 'colors.active', 'emphasis.style',
    'layout.maxWordsPerPage', 'layout.combineWithinMs', 'layout.minPageDurationMs', 'position.yPct', 'position.maxWidthPct',
];

function configPath(): string {
    return process.env.CAPTIONS_CONFIG_PATH
        ?? path.join(getDataDir(), 'captions.json');
}

const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

function num(v: unknown, min: number, max: number, label: string, errors: string[]): number | undefined {
    if (v === undefined) return undefined;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
        errors.push(`${label} must be a number between ${min} and ${max}`);
        return undefined;
    }
    return v;
}

function hex(v: unknown, label: string, errors: string[]): string | undefined {
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || !/^#?[0-9a-fA-F]{6}$/.test(v)) {
        errors.push(`${label} must be a 6-digit hex color`);
        return undefined;
    }
    return v.startsWith('#') ? v : `#${v}`;
}

/** Drop keys whose value is undefined so they don't erase the base preset's. */
const defined = <T extends object>(o: T): Partial<T> =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

function mergePreset(id: string, raw: Record<string, unknown>, base: CaptionPreset | undefined, errors: string[]): CaptionPreset | null {
    const font = isObj(raw.font) ? raw.font : {};
    const colors = isObj(raw.colors) ? raw.colors : {};
    const layout = isObj(raw.layout) ? raw.layout : {};
    const position = isObj(raw.position) ? raw.position : {};

    if (font.family !== undefined && !ALLOWED_FONT_FAMILIES.includes(String(font.family))) {
        // libass substitutes silently for an unknown family, so refuse it here
        // rather than shipping captions in whatever font the host happens to have.
        errors.push(`font.family must be one of: ${ALLOWED_FONT_FAMILIES.join(', ')}`);
    }
    if (raw.emphasis !== undefined && (!isObj(raw.emphasis) || !EMPHASIS_STYLES.includes(raw.emphasis.style as EmphasisStyle))) {
        errors.push(`emphasis.style must be one of: ${EMPHASIS_STYLES.join(', ')}`);
    }

    const merged: CaptionPreset = {
        ...(base ?? ({} as CaptionPreset)),
        id,
        name: typeof raw.name === 'string' ? raw.name : (base?.name ?? id),
        font: {
            ...(base?.font ?? {} as CaptionPreset['font']),
            ...defined({
                family: typeof font.family === 'string' ? font.family : undefined,
                sizePct: num(font.sizePct, 0.5, 20, `${id}.font.sizePct`, errors),
                uppercase: typeof font.uppercase === 'boolean' ? font.uppercase : undefined,
            }),
        },
        colors: {
            ...(base?.colors ?? {} as CaptionPreset['colors']),
            ...defined({
                text: hex(colors.text, `${id}.colors.text`, errors),
                active: hex(colors.active, `${id}.colors.active`, errors),
            }),
        },
        emphasis: isObj(raw.emphasis)
            ? { ...(base?.emphasis ?? {}), style: raw.emphasis.style as EmphasisStyle, ...defined({ scalePct: num(raw.emphasis.scalePct, 100, 200, `${id}.emphasis.scalePct`, errors) }) }
            : base?.emphasis ?? { style: 'karaoke' },
        layout: {
            ...(base?.layout ?? {} as CaptionPreset['layout']),
            ...defined({
                maxWordsPerPage: num(layout.maxWordsPerPage, 1, 12, `${id}.layout.maxWordsPerPage`, errors),
                combineWithinMs: num(layout.combineWithinMs, 0, 10_000, `${id}.layout.combineWithinMs`, errors),
                minPageDurationMs: num(layout.minPageDurationMs, 0, 10_000, `${id}.layout.minPageDurationMs`, errors),
            }),
        },
        position: {
            ...(base?.position ?? {} as CaptionPreset['position']),
            ...defined({
                yPct: num(position.yPct, 0, 100, `${id}.position.yPct`, errors),
                maxWidthPct: num(position.maxWidthPct, 10, 100, `${id}.position.maxWidthPct`, errors),
            }),
        },
    };

    if (isObj(raw.container)) {
        merged.container = {
            color: hex(raw.container.color, `${id}.container.color`, errors) ?? base?.container?.color ?? '#FFFFFF',
            opacity: num(raw.container.opacity, 0, 1, `${id}.container.opacity`, errors) ?? base?.container?.opacity ?? 1,
            paddingPx: num(raw.container.paddingPx, 0, 200, `${id}.container.paddingPx`, errors) ?? base?.container?.paddingPx ?? 16,
        };
    } else if (raw.container === null) {
        delete merged.container;
    }

    if (isObj(raw.stroke)) {
        merged.stroke = {
            width: num(raw.stroke.width, 0, 40, `${id}.stroke.width`, errors) ?? base?.stroke?.width ?? 0,
            color: hex(raw.stroke.color, `${id}.stroke.color`, errors) ?? base?.stroke?.color ?? '#000000',
        };
    } else if (raw.stroke === null) {
        delete merged.stroke;
    }

    if (isObj(raw.shadow)) {
        merged.shadow = {
            depth: num(raw.shadow.depth, 0, 40, `${id}.shadow.depth`, errors) ?? base?.shadow?.depth ?? 0,
            color: hex(raw.shadow.color, `${id}.shadow.color`, errors) ?? base?.shadow?.color ?? '#000000',
        };
    } else if (raw.shadow === null) {
        delete merged.shadow;
    }

    if (isObj(raw.landscape)) {
        // The landscape group may override any styling section, so it is
        // validated with the same rules as the base preset.
        const l = raw.landscape;
        if (isObj(l.font) && l.font.family !== undefined && !ALLOWED_FONT_FAMILIES.includes(String(l.font.family))) {
            errors.push(`landscape.font.family must be one of: ${ALLOWED_FONT_FAMILIES.join(', ')}`);
        }
        if (isObj(l.emphasis) && l.emphasis.style !== undefined && !EMPHASIS_STYLES.includes(l.emphasis.style as EmphasisStyle)) {
            errors.push(`landscape.emphasis.style must be one of: ${EMPHASIS_STYLES.join(', ')}`);
        }
        // Section by section over the built-in's landscape group, like the base
        // sections above — a one-key override must not drop its siblings.
        const bl = base?.landscape;
        merged.landscape = {
            ...(bl ?? {}),
            ...defined({
                font: isObj(l.font) ? { ...(bl?.font ?? {}), ...defined({
                    family: typeof l.font.family === 'string' ? l.font.family : undefined,
                    sizePct: num(l.font.sizePct, 0.5, 20, `${id}.landscape.font.sizePct`, errors),
                    uppercase: typeof l.font.uppercase === 'boolean' ? l.font.uppercase : undefined,
                }) } : undefined,
                colors: isObj(l.colors) ? { ...(bl?.colors ?? {}), ...defined({
                    text: hex(l.colors.text, `${id}.landscape.colors.text`, errors),
                    active: hex(l.colors.active, `${id}.landscape.colors.active`, errors),
                }) } : undefined,
                stroke: isObj(l.stroke) ? {
                    width: num(l.stroke.width, 0, 40, `${id}.landscape.stroke.width`, errors) ?? bl?.stroke?.width ?? 0,
                    color: hex(l.stroke.color, `${id}.landscape.stroke.color`, errors) ?? bl?.stroke?.color ?? '#000000',
                } : undefined,
                shadow: isObj(l.shadow) ? {
                    depth: num(l.shadow.depth, 0, 40, `${id}.landscape.shadow.depth`, errors) ?? bl?.shadow?.depth ?? 0,
                    color: hex(l.shadow.color, `${id}.landscape.shadow.color`, errors) ?? bl?.shadow?.color ?? '#000000',
                } : undefined,
                container: isObj(l.container) ? {
                    color: hex(l.container.color, `${id}.landscape.container.color`, errors) ?? bl?.container?.color ?? '#FFFFFF',
                    opacity: num(l.container.opacity, 0, 1, `${id}.landscape.container.opacity`, errors) ?? bl?.container?.opacity ?? 1,
                    paddingPx: num(l.container.paddingPx, 0, 200, `${id}.landscape.container.paddingPx`, errors) ?? bl?.container?.paddingPx ?? 16,
                } : undefined,
                emphasis: isObj(l.emphasis) ? { ...(bl?.emphasis ?? {}), ...defined({
                    style: l.emphasis.style as EmphasisStyle | undefined,
                    scalePct: num(l.emphasis.scalePct, 100, 200, `${id}.landscape.emphasis.scalePct`, errors),
                }) } : undefined,
                layout: isObj(l.layout) ? { ...(bl?.layout ?? {}), ...defined({
                    maxWordsPerPage: num(l.layout.maxWordsPerPage, 1, 12, `${id}.landscape.layout.maxWordsPerPage`, errors),
                    combineWithinMs: num(l.layout.combineWithinMs, 0, 10_000, `${id}.landscape.layout.combineWithinMs`, errors),
                    minPageDurationMs: num(l.layout.minPageDurationMs, 0, 10_000, `${id}.landscape.layout.minPageDurationMs`, errors),
                }) } : undefined,
                position: isObj(l.position) ? { ...(bl?.position ?? {}), ...defined({
                    yPct: num(l.position.yPct, 0, 100, `${id}.landscape.position.yPct`, errors),
                    maxWidthPct: num(l.position.maxWidthPct, 10, 100, `${id}.landscape.position.maxWidthPct`, errors),
                }) } : undefined,
            }),
        };
    }

    // Presets exported before per-orientation overrides carried the landscape
    // placement as position.landscapeYPct. Convert rather than ignore it, so an
    // older export does not silently lose its landscape placement.
    const legacyLandscapeY = num(position.landscapeYPct, 0, 100, `${id}.position.landscapeYPct`, errors);
    if (legacyLandscapeY !== undefined && merged.landscape?.position?.yPct === undefined) {
        merged.landscape = {
            ...(merged.landscape ?? {}),
            position: { ...(merged.landscape?.position ?? {}), yPct: legacyLandscapeY },
        };
        console.warn(`⚠️ caption preset '${id}': converted position.landscapeYPct to the landscape override`);
    }

    // ASS draws a box or an outline, never both — normalize instead of shipping
    // a preset whose stroke would be silently dropped at render time.
    if (merged.container && (merged.stroke || merged.shadow)) {
        delete merged.stroke;
        delete merged.shadow;
        console.warn(`⚠️ caption preset '${id}': stroke/shadow dropped — a container replaces them in ASS`);
    }

    if (errors.length > 0) return null;

    // Every leaf the timeline and renderer read. A missing one would not throw
    // downstream — it would turn into NaN timestamps that libass drops silently.
    const missing = REQUIRED_LEAVES.filter(leaf => leaf.split('.').reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), merged) === undefined);
    if (missing.length > 0) {
        errors.push(`'${id}' does not override a built-in preset and is missing ${missing.join(', ')}`);
        return null;
    }
    return merged;
}

/**
 * The caption studio exports one preset object. Accept that verbatim as a
 * single-preset config so a file can be pasted in without rewrapping, keyed by
 * its own id and made the default.
 */
function asConfigShape(raw: Record<string, unknown>): Record<string, unknown> {
    if (raw.presets !== undefined || raw.default !== undefined) return raw;
    if (!isObj(raw.font) && !isObj(raw.colors) && !isObj(raw.emphasis)) return raw;
    const id = typeof raw.id === 'string' && raw.id ? raw.id : 'custom';
    return { default: id, presets: { [id]: raw } };
}

function readConfigFile(file: string): CaptionConfig {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
    if (!isObj(parsed)) throw new Error('config root must be an object');
    const raw = asConfigShape(parsed);

    const presets: Record<string, CaptionPreset> = { ...CAPTION_PRESETS };
    if (raw.presets !== undefined) {
        if (!isObj(raw.presets)) throw new Error('"presets" must be an object keyed by preset id');
        for (const [id, value] of Object.entries(raw.presets)) {
            if (!isObj(value)) {
                console.warn(`⚠️ caption preset '${id}' ignored: not an object`);
                continue;
            }
            const errors: string[] = [];
            const preset = mergePreset(id, value, CAPTION_PRESETS[id], errors);
            if (preset) {
                presets[id] = preset;
            } else {
                console.warn(`⚠️ caption preset '${id}' ignored: ${errors.join('; ')}`);
            }
        }
    }

    let defaultId = DEFAULT_PRESET_ID;
    if (raw.default !== undefined) {
        if (typeof raw.default === 'string' && Object.hasOwn(presets, raw.default)) {
            defaultId = raw.default;
        } else {
            console.warn(`⚠️ caption config "default" ignored: '${String(raw.default)}' is not a known preset`);
        }
    }

    return { presets, defaultId, sourcePath: file };
}

let cache: { key: string; config: CaptionConfig } | null = null;

/**
 * Built-in presets merged with the runtime override file, if present. Re-read
 * only when the file's mtime or size changes, so renders never pay for I/O they
 * don't need.
 */
export function getCaptionConfig(): CaptionConfig {
    const file = configPath();
    let stat: fs.Stats | undefined;
    try {
        stat = fs.statSync(file);
    } catch {
        cache = null;
        return { presets: CAPTION_PRESETS, defaultId: DEFAULT_PRESET_ID };
    }

    const key = `${file}:${stat.mtimeMs}:${stat.size}`;
    if (cache?.key === key) return cache.config;

    try {
        const config = readConfigFile(file);
        console.log(`🎨 caption presets loaded from ${file}: ${Object.keys(config.presets).join(', ')} (default '${config.defaultId}')`);
        cache = { key, config };
        return config;
    } catch (err) {
        console.warn(`⚠️ caption config at ${file} ignored (${err instanceof Error ? err.message : String(err)}); using built-in presets`);
        const config: CaptionConfig = { presets: CAPTION_PRESETS, defaultId: DEFAULT_PRESET_ID };
        cache = { key, config };
        return config;
    }
}

/** Short digest of the styling a render actually used, for traceability. */
export function presetFingerprint(preset: CaptionPreset): string {
    return crypto.createHash('sha256').update(JSON.stringify(preset)).digest('hex').slice(0, 12);
}

/** Testing seam: drops the mtime cache so the next call re-reads. */
export function resetCaptionConfigCache(): void {
    cache = null;
}

/**
 * The preset a render should use: the requested id when the config knows it,
 * else the default. A plain-object lookup would accept prototype keys such as
 * "constructor" from an untrusted request, so membership is checked with hasOwn.
 */
export function selectPreset(config: CaptionConfig, requestedId: string | undefined): { id: string; preset: CaptionPreset } {
    if (requestedId !== undefined && Object.hasOwn(config.presets, requestedId)) {
        return { id: requestedId, preset: config.presets[requestedId] };
    }
    if (requestedId !== undefined) {
        console.warn(`⚠️ Unknown captionStyle '${requestedId}', falling back to '${config.defaultId}'`);
    }
    return { id: config.defaultId, preset: config.presets[config.defaultId] };
}
