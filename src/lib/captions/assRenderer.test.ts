import { describe, it, expect } from 'vitest';
import { parse } from 'ass-compiler';
import { renderAss } from './assRenderer.js';
import { CAPTION_PRESETS, resolveForOrientation } from './presets.js';
import type { CaptionTimeline } from './types.js';

const frame = { width: 1080, height: 1920 };

const timeline: CaptionTimeline = {
    pages: [
        {
            startMs: 100, endMs: 1600,
            tokens: [
                { text: 'Ξεκινάμε', fromMs: 100, toMs: 600 },
                { text: 'την', fromMs: 700, toMs: 900 },
                { text: 'ανάπλαση', fromMs: 950, toMs: 1500 },
            ],
        },
        { startMs: 1600, endMs: 2800, tokens: [{ text: 'σήμερα', fromMs: 1600, toMs: 2100 }] },
    ],
    speakerSpans: [
        { startMs: 100, endMs: 2800, speaker: { name: 'Μαρία Παπαδοπούλου', roleLabel: 'Δήμαρχος', partyColorHex: '#2E86DE' } },
    ],
};

const opts = { includeCaptions: true, includeSpeakerOverlay: false };

describe('renderAss core', () => {
    const output = renderAss(timeline, CAPTION_PRESETS.sweep, frame, opts);

    it('emits a parseable script with correct play resolution', () => {
        const parsed = parse(output);
        expect(parsed.info.PlayResX).toBe('1080');
        expect(parsed.info.PlayResY).toBe('1920');
    });

    it('emits one dialogue per page for karaoke sweep', () => {
        const parsed = parse(output);
        expect(parsed.events.dialogue).toHaveLength(2);
    });

    it('prefixes each word with a \\kf tag in centiseconds', () => {
        // first word: 600-100 = 500ms = 50cs
        expect(output).toContain('{\\kf50}');
        expect(output).toMatch(/\\kf\d+\}ΞΕΚΙΝΑΜΕ/); // uppercase preset
    });

    it('fills inter-word gaps with empty karaoke syllables', () => {
        // gap 600→700 = 10cs between word 1 and 2
        expect(output).toContain('{\\kf10}');
    });

    it('positions pages via \\an5 \\pos at yPct of frame height', () => {
        expect(output).toContain('\\an5');
        expect(output).toContain('\\pos(540,1344)');  // 70% of 1920
    });

    it('applies the landscape override group (lower-third) on 16:9 frames', () => {
        // 82% of 720 = 590.4 -> rounds to 590
        const frame16x9 = { width: 1280, height: 720 };
        const resolved = resolveForOrientation(CAPTION_PRESETS.sweep, frame16x9);
        expect(resolved.position.yPct).toBe(82);
        expect(resolved.position.maxWidthPct).toBe(80); // unset fields keep the base
        const landscape = renderAss(timeline, resolved, frame16x9, opts);
        expect(landscape).toContain('\\pos(640,590)');
    });

    it('resolveForOrientation is identity for portrait frames and presets without overrides', () => {
        expect(resolveForOrientation(CAPTION_PRESETS.sweep, frame)).toBe(CAPTION_PRESETS.sweep);
        const { landscape: _omit, ...noOverride } = CAPTION_PRESETS.sweep;
        expect(resolveForOrientation(noOverride, { width: 1280, height: 720 })).toBe(noOverride);
    });

    it('landscape override can carry stroke and shadow of its own', () => {
        const p = {
            ...CAPTION_PRESETS.pop,
            stroke: { width: 6, color: '#151414' },
            shadow: { depth: 2, color: '#000000' },
            landscape: { stroke: { width: 8, color: '#151414' }, shadow: { depth: 6, color: '#000000' } },
        };
        expect(resolveForOrientation(p, frame).stroke?.width).toBe(6);                        // portrait keeps the base
        expect(resolveForOrientation(p, { width: 1280, height: 720 }).stroke?.width).toBe(8);
        expect(resolveForOrientation(p, { width: 1280, height: 720 }).shadow?.depth).toBe(6);
    });

    it('a landscape container drops the base stroke, as ASS requires', () => {
        const p = {
            ...CAPTION_PRESETS.pop,
            stroke: { width: 6, color: '#000000' },
            landscape: { container: { color: '#FFFFFF', opacity: 0.9, paddingPx: 20 } },
        };
        const land = resolveForOrientation(p, { width: 1280, height: 720 });
        expect(land.container).toBeDefined();
        expect(land.stroke).toBeUndefined();
        expect(resolveForOrientation(p, frame).stroke?.width).toBe(6); // portrait untouched
    });

    it('landscape override can change font size and paging independently', () => {
        const p = { ...CAPTION_PRESETS.sweep, landscape: { font: { sizePct: 5.5 }, layout: { maxWordsPerPage: 6 }, position: { yPct: 80 } } };
        const r = resolveForOrientation(p, { width: 1280, height: 720 });
        expect(r.font.sizePct).toBe(5.5);
        expect(r.font.family).toBe(p.font.family);
        expect(r.layout.maxWordsPerPage).toBe(6);
        expect(r.layout.minPageDurationMs).toBe(p.layout.minPageDurationMs);
        expect(r.position.yPct).toBe(80);
    });

    it('uppercases with Greek locale (tonos dropped per Greek all-caps rules)', () => {
        const withTonos: CaptionTimeline = {
            pages: [{ startMs: 0, endMs: 500, tokens: [{ text: 'ανάπλαση', fromMs: 0, toMs: 400 }] }],
            speakerSpans: [],
        };
        const out = renderAss(withTonos, CAPTION_PRESETS.sweep, frame, opts);
        expect(out).toContain('ΑΝΑΠΛΑΣΗ');
        expect(out).not.toContain('ΑΝΆΠΛΑΣΗ');
    });

    it('omits caption events when includeCaptions is false', () => {
        const out = renderAss(timeline, CAPTION_PRESETS.sweep, frame, { includeCaptions: false, includeSpeakerOverlay: false });
        const parsed = parse(out);
        expect(parsed.events.dialogue ?? []).toHaveLength(0);
    });

    it('matches snapshot', () => {
        expect(output).toMatchSnapshot();
    });
});

describe("renderAss 'none' emphasis", () => {
    const output = renderAss(timeline, { ...CAPTION_PRESETS.pop, emphasis: { style: 'none' } }, frame, opts);

    it('emits one dialogue per page, not per word', () => {
        expect(parse(output).events.dialogue).toHaveLength(2);
    });

    it('applies no per-word color or scale overrides', () => {
        expect(output).not.toContain('\\c&H');
        expect(output).not.toContain('\\fscx');
        expect(output).not.toContain('\\kf');
    });
});

describe('renderAss pop emphasis', () => {
    const output = renderAss(timeline, CAPTION_PRESETS.pop, frame, opts);
    const parsed = parse(output);

    it('emits one dialogue per word window (3 + 1 tokens)', () => {
        expect(parsed.events.dialogue).toHaveLength(4);
    });

    it('wraps only the active word with color + scale bounce', () => {
        // Vertical only: scaling x would re-flow the centred line and shift every word
        expect(output).toContain('{\\c&H0AD6FF&\\t(0,120,\\fscy106)\\t(120,240,\\fscy100)}ΞΕΚΙΝΑΜΕ{\\r}');
    });

    it('keeps the full page text visible in every word event', () => {
        const first = parsed.events.dialogue[0].Text.combined ?? '';
        expect(first).toContain('ΤΗΝ');
        expect(first).toContain('ΑΝΑΠΛΑΣΗ');
    });

    it('matches snapshot', () => expect(output).toMatchSnapshot());
});

describe('renderAss card container', () => {
    const output = renderAss(timeline, CAPTION_PRESETS.card, frame, opts);

    it('uses BorderStyle=4 with the container color', () => {
        const styleLine = output.split('\n').find(l => l.startsWith('Style: Caption'))!;
        const fields = styleLine.replace('Style: ', '').split(',');
        expect(fields[15]).toBe('4'); // BorderStyle
        expect(fields[6]).toMatch(/^&H0AFFFFFF$/); // BackColour: alpha 0A (~0.96 opacity), white
    });

    it('keeps sentence case (uppercase: false)', () => {
        expect(output).toContain('Ξεκινάμε');
    });

    it('flips the active word color without scaling', () => {
        expect(output).toContain('{\\c&H0066FF&}Ξεκινάμε{\\r}');
    });

    it('matches snapshot', () => expect(output).toMatchSnapshot());
});

describe('renderAss speaker chip', () => {
    const output = renderAss(timeline, CAPTION_PRESETS.sweep, frame, { includeCaptions: false, includeSpeakerOverlay: true });

    it('emits a chip event and its accent bar per speaker span', () => {
        const parsed = parse(output);
        expect(parsed.events.dialogue).toHaveLength(2);
        expect(output).toContain('Dialogue: 1,');  // chip text + box
        expect(output).toContain('Dialogue: 2,');  // bar, above the box
    });

    it('includes party-colored accent, name, and role line', () => {
        // Accent is a \p1 rect spanning the whole chip, as the drawtext bar did:
        // 2*padding + name + role line + line spacing = 2*12 + 36 + 26 + 6 = 92.
        expect(output).toMatch(/\\c&HDE862E&\\p1\}m 0 0 l 4 0 l 4 86 l 0 86\{\\p0\}/);
        expect(output).toContain('Μαρία Παπαδοπούλου');
        expect(output).toContain('Δήμαρχος');
    });

    it('shows the role alone and wraps it, as the overlay did', () => {
        const longRole = 'Εντεταλμένος Σύμβουλος για θέματα κυκλικής οικονομίας και διαχείρισης βιοαποβλήτων';
        const out = renderAss(
            { pages: [], speakerSpans: [{ startMs: 0, endMs: 900, speaker: { name: 'Χ', roleLabel: longRole, partyLabel: 'Κόμμα', partyColorHex: '#2E86DE' } }] },
            CAPTION_PRESETS.sweep, frame, { includeCaptions: false, includeSpeakerOverlay: true },
        );
        expect(out).not.toContain('Κόμμα');  // the role wins; the overlay never showed both
        const chip = out.split('\n').find(l => l.startsWith('Dialogue: 1'))!;
        expect(chip.split('\\N').length).toBeGreaterThan(3);  // name plus several wrapped lines
    });

    it('fades in and sits where the legacy overlay did (1080p preset: 30, 525)', () => {
        expect(output).toContain('\\fad(200,0)');
        // Legacy 1080p overlay sat at leftPadding 30 / topPadding 525; the text
        // clears the bar and the box padding.
        expect(output).toContain('\\an7\\pos(46,525)');  // name + role
        // The box starts padV above the text origin, so the bar has to as well
        // to line up with its top edge rather than the first glyph.
        expect(output).toContain('\\an7\\pos(30,513)');  // bar, on the box edge
    });

    it('matches snapshot', () => expect(output).toMatchSnapshot());
});
