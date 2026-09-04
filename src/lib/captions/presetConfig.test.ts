import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getCaptionConfig, presetFingerprint, resetCaptionConfigCache, selectPreset } from './presetConfig.js';
import { CAPTION_PRESETS, DEFAULT_PRESET_ID } from './presets.js';

let dir: string;
let file: string;

const write = (config: unknown) => fs.writeFileSync(file, typeof config === 'string' ? config : JSON.stringify(config));

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caption-config-'));
    file = path.join(dir, 'captions.json');
    process.env.CAPTIONS_CONFIG_PATH = file;
    resetCaptionConfigCache();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    delete process.env.CAPTIONS_CONFIG_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
});

describe('getCaptionConfig', () => {
    it('falls back to the built-ins when no file exists', () => {
        const { presets, defaultId } = getCaptionConfig();
        expect(presets).toBe(CAPTION_PRESETS);
        expect(defaultId).toBe(DEFAULT_PRESET_ID);
    });

    it('merges a partial override onto the built-in preset of the same id', () => {
        write({ presets: { sweep: { colors: { active: '#00FF00' }, position: { yPct: 70 } } } });
        const { presets } = getCaptionConfig();
        expect(presets.sweep.colors.active).toBe('#00FF00');
        expect(presets.sweep.colors.text).toBe(CAPTION_PRESETS.sweep.colors.text); // untouched
        expect(presets.sweep.position.yPct).toBe(70);
        expect(presets.sweep.position.maxWidthPct).toBe(CAPTION_PRESETS.sweep.position.maxWidthPct);
        expect(presets.sweep.emphasis).toEqual(CAPTION_PRESETS.sweep.emphasis);
    });

    it('adds a new preset defined entirely in the file', () => {
        write({
            default: 'team',
            presets: {
                team: {
                    name: 'Team pick',
                    font: { family: 'Inter Black', sizePct: 3, uppercase: false },
                    colors: { text: '#FFFFFF', active: '#FCFF33' },
                    stroke: { width: 8, color: '#111212' },
                    emphasis: { style: 'pop', scalePct: 106 },
                    layout: { maxWordsPerPage: 5, combineWithinMs: 1200, minPageDurationMs: 1400 },
                    position: { yPct: 65, maxWidthPct: 69 },
                    landscape: { font: { sizePct: 5 }, position: { yPct: 84 } },
                },
            },
        });
        const { presets, defaultId } = getCaptionConfig();
        expect(defaultId).toBe('team');
        expect(presets.team.landscape?.font?.sizePct).toBe(5);
        expect(presets.sweep).toBeDefined(); // built-ins still available
    });

    it('drops stroke and shadow when the preset has a container', () => {
        write({ presets: { plate: {
            name: 'Plate',
            font: { family: 'Inter Black', sizePct: 3, uppercase: false },
            colors: { text: '#FFFFFF', active: '#E7FF2E' },
            stroke: { width: 3, color: '#000000' },
            shadow: { depth: 2, color: '#000000' },
            container: { color: '#FFFFFF', opacity: 0.66, paddingPx: 25 },
            emphasis: { style: 'karaoke' },
            layout: { maxWordsPerPage: 3, combineWithinMs: 1200, minPageDurationMs: 1000 },
            position: { yPct: 68, maxWidthPct: 85 },
        } } });
        const { presets } = getCaptionConfig();
        expect(presets.plate.container).toBeDefined();
        expect(presets.plate.stroke).toBeUndefined();
        expect(presets.plate.shadow).toBeUndefined();
    });

    it('ignores an invalid preset but keeps the valid ones', () => {
        write({ presets: {
            sweep: { font: { family: 'Comic Sans' } },
            pop: { position: { yPct: 55 } },
        } });
        const { presets } = getCaptionConfig();
        expect(presets.sweep.font.family).toBe('Inter Black'); // rejected, built-in stands
        expect(presets.pop.position.yPct).toBe(55);            // accepted
    });

    it('rejects out-of-range numbers', () => {
        write({ presets: { sweep: { font: { sizePct: 90 } } } });
        expect(getCaptionConfig().presets.sweep.font.sizePct).toBe(CAPTION_PRESETS.sweep.font.sizePct);
    });

    it('accepts a bare preset exported by the caption studio', () => {
        write({
            id: 'teamB',
            name: 'Team pick',
            font: { family: 'Inter Black', sizePct: 3, uppercase: false },
            colors: { text: '#FFFFFF', active: '#FCFF33' },
            stroke: { width: 8, color: '#111212' },
            emphasis: { style: 'pop', scalePct: 106 },
            layout: { maxWordsPerPage: 5, combineWithinMs: 1200, minPageDurationMs: 1400 },
            position: { yPct: 65, maxWidthPct: 69 },
            landscape: { font: { sizePct: 5 }, position: { yPct: 84 } },
        });
        const { presets, defaultId } = getCaptionConfig();
        expect(defaultId).toBe('teamB');                       // becomes the default on its own
        expect(presets.teamB.colors.active).toBe('#FCFF33');
        expect(presets.teamB.landscape?.position?.yPct).toBe(84);
        expect(presets.sweep).toBeDefined();                   // built-ins still there
    });

    it('converts the legacy position.landscapeYPct to a landscape override', () => {
        write({
            id: 'legacy',
            font: { family: 'Inter Black', sizePct: 3.2, uppercase: false },
            colors: { text: '#FFFFFF', active: '#FCFF33' },
            emphasis: { style: 'pop', scalePct: 106 },
            layout: { maxWordsPerPage: 5, combineWithinMs: 1200, minPageDurationMs: 1400 },
            position: { yPct: 65, landscapeYPct: 84, maxWidthPct: 69 },
        });
        const p = getCaptionConfig().presets.legacy;
        expect(p.position.yPct).toBe(65);
        expect(p.landscape?.position?.yPct).toBe(84);
    });

    it('lets an explicit landscape override win over the legacy field', () => {
        write({ presets: { sweep: { position: { landscapeYPct: 50 }, landscape: { position: { yPct: 88 } } } } });
        expect(getCaptionConfig().presets.sweep.landscape?.position?.yPct).toBe(88);
    });

    it('keys a bare preset with no id under "custom"', () => {
        write({
            font: { family: 'Inter Black', sizePct: 4, uppercase: true },
            colors: { text: '#FFFFFF', active: '#FF8C33' },
            emphasis: { style: 'karaoke' },
            layout: { maxWordsPerPage: 4, combineWithinMs: 1200, minPageDurationMs: 1000 },
            position: { yPct: 63, maxWidthPct: 80 },
        });
        expect(getCaptionConfig().defaultId).toBe('custom');
    });

    it('validates styling fields inside the landscape override', () => {
        write({ presets: { sweep: { landscape: { stroke: { width: 8, color: '#151414' }, colors: { active: '#FFD60A' } } } } });
        const p = getCaptionConfig().presets.sweep;
        expect(p.landscape?.stroke).toEqual({ width: 8, color: '#151414' });
        expect(p.landscape?.colors?.active).toBe('#FFD60A');
    });

    it('rejects a preset whose landscape override is out of range', () => {
        write({ presets: { sweep: { landscape: { stroke: { width: 400, color: '#000000' } } } } });
        expect(getCaptionConfig().presets.sweep.landscape?.stroke).toBeUndefined();
    });

    it('ignores a default naming an unknown preset', () => {
        write({ default: 'nope' });
        expect(getCaptionConfig().defaultId).toBe(DEFAULT_PRESET_ID);
    });

    it('falls back to built-ins on malformed JSON instead of throwing', () => {
        write('{ not json');
        const { presets, defaultId } = getCaptionConfig();
        expect(presets).toBe(CAPTION_PRESETS);
        expect(defaultId).toBe(DEFAULT_PRESET_ID);
    });

    it('picks up edits without a restart, and serves cached config otherwise', () => {
        write({ presets: { sweep: { position: { yPct: 70 } } } });
        expect(getCaptionConfig().presets.sweep.position.yPct).toBe(70);

        const first = getCaptionConfig();
        expect(getCaptionConfig()).toBe(first); // unchanged file → same object, no re-read

        const later = new Date(Date.now() + 2000);
        write({ presets: { sweep: { position: { yPct: 40 } } } });
        fs.utimesSync(file, later, later);
        expect(getCaptionConfig().presets.sweep.position.yPct).toBe(40);
    });
});

describe('presetFingerprint', () => {
    it('changes when any styling value changes', () => {
        const a = presetFingerprint(CAPTION_PRESETS.sweep);
        const b = presetFingerprint({ ...CAPTION_PRESETS.sweep, colors: { text: '#FFFFFF', active: '#123456' } });
        expect(a).not.toBe(b);
        expect(a).toHaveLength(12);
    });
});

describe('config edge cases that must not break a render', () => {
    it('ignores a default that is only a prototype key', () => {
        write({ default: 'constructor' });
        const cfg = getCaptionConfig();
        expect(cfg.defaultId).toBe(DEFAULT_PRESET_ID);
        expect(typeof cfg.presets[cfg.defaultId]).toBe('object');
    });

    it('selectPreset falls back for a prototype key requested by the client', () => {
        const cfg = getCaptionConfig();
        for (const id of ['constructor', '__proto__', 'toString']) {
            expect(selectPreset(cfg, id).id).toBe(cfg.defaultId);
        }
        expect(selectPreset(cfg, 'sweep').id).toBe('sweep');
        expect(selectPreset(cfg, undefined).id).toBe(cfg.defaultId);
    });

    it('rejects a new preset missing a leaf the timeline reads, naming it', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        write({ default: 'mine', presets: { mine: {
            font: { family: 'Inter Black', sizePct: 4, uppercase: true },
            colors: { text: '#FFFFFF', active: '#FF0000' }, emphasis: { style: 'karaoke' },
            layout: { maxWordsPerPage: 4 }, position: { yPct: 70 },
        } } });
        const cfg = getCaptionConfig();
        expect(cfg.presets.mine).toBeUndefined();
        expect(cfg.defaultId).toBe(DEFAULT_PRESET_ID);
        expect(warn.mock.calls.flat().join('\n')).toMatch(/layout\.combineWithinMs.*layout\.minPageDurationMs.*position\.maxWidthPct/);
    });
});

describe('overrides merge field by field', () => {
    it('keeps the built-in landscape siblings when one landscape key is overridden', () => {
        write({ presets: { team: { landscape: { position: { yPct: 80 } } } } });
        expect(getCaptionConfig().presets.team.landscape?.position).toEqual({ yPct: 80, maxWidthPct: 74 });
    });

    it('keeps the built-in landscape stroke colour when only the width changes', () => {
        write({ presets: { team: { landscape: { stroke: { width: 10 } } } } });
        expect(getCaptionConfig().presets.team.landscape?.stroke).toEqual({ width: 10, color: CAPTION_PRESETS.team.landscape!.stroke!.color });
    });

    it('keeps scalePct when only the emphasis style is overridden', () => {
        write({ presets: { team: { emphasis: { style: 'highlight' } } } });
        expect(getCaptionConfig().presets.team.emphasis).toEqual({ style: 'highlight', scalePct: CAPTION_PRESETS.team.emphasis.scalePct });
    });
});
