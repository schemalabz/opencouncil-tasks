import { escapeAssText, hexToAssColorTag, hexToAssStyleColor, msToAssTime, msToCs } from './assFormat.js';
import type { CaptionPage, CaptionPreset, CaptionTimeline, SpeakerSpan } from './types.js';

interface Frame { width: number; height: number }
interface RenderOpts {
    includeCaptions: boolean;
    includeSpeakerOverlay: boolean;
    /** Family for the speaker chip; resolved by ensureFonts() at render time. */
    chipFont?: string;
}

const CHIP_FONT_DEFAULT = 'Inter Medium';

/** px values in presets are calibrated for a 1920-high frame; scale linearly. */
const scale = (px: number, frame: Frame) => Math.max(1, Math.round(px * (frame.height / 1920)));

function styleSection(preset: CaptionPreset, frame: Frame, chipFont: string): string {
    const fontSize = Math.round(frame.height * (preset.font.sizePct / 100));
    const marginX = Math.round((frame.width * (1 - preset.position.maxWidthPct / 100)) / 2);
    const isKaraoke = preset.emphasis.style === 'karaoke';

    // Karaoke fill: PrimaryColour = after-sweep (active), SecondaryColour = before-sweep (base).
    // All other styles: PrimaryColour = base text; active color applied via inline \c.
    const primary = hexToAssStyleColor(isKaraoke ? preset.colors.active : preset.colors.text);
    const secondary = hexToAssStyleColor(preset.colors.text);

    const hasCard = preset.container !== undefined;
    const borderStyle = hasCard ? 4 : 1;
    const outline = hasCard ? 0 : scale(preset.stroke?.width ?? 0, frame);
    const shadowDepth = hasCard ? scale(preset.container!.paddingPx, frame) : scale(preset.shadow?.depth ?? 0, frame);
    const outlineColor = hexToAssStyleColor(preset.stroke?.color ?? '#000000');
    // BorderStyle=4 draws the box with BackColour; alpha from container opacity.
    const backAlpha = hasCard ? Math.round((1 - preset.container!.opacity) * 255) : 128;
    const backColor = hexToAssStyleColor(preset.container?.color ?? '#000000', backAlpha);

    // Legacy drawtext overlay proportions: portrait name = 24px/1280 (1.875%),
    // landscape name = 33.6px/720 (4.67%) — the chip must not shrink vs production.
    const chip = chipGeometry(frame);

    return [
        '[V4+ Styles]',
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
        `Style: Caption,${preset.font.family},${fontSize},${primary},${secondary},${outlineColor},${backColor},0,0,0,0,100,100,0,0,${borderStyle},${outline},${shadowDepth},5,${marginX},${marginX},0,1`,
        `Style: Chip,${chipFont},${chip.nameSize},${hexToAssStyleColor('#E0E0E0')},${hexToAssStyleColor('#E0E0E0')},${hexToAssStyleColor('#000000')},${hexToAssStyleColor('#000000', 51)},0,0,0,0,100,100,0,0,4,0,${chip.padV},7,0,0,0,1`,
        `Style: Accent,${chipFont},${chip.nameSize},${hexToAssStyleColor('#E0E0E0')},${hexToAssStyleColor('#E0E0E0')},${hexToAssStyleColor('#000000')},${hexToAssStyleColor('#000000')},0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
    ].join('\n');
}

function displayText(text: string, preset: CaptionPreset): string {
    const escaped = escapeAssText(text);
    return preset.font.uppercase ? escaped.toLocaleUpperCase('el') : escaped;
}

function captionPos(preset: CaptionPreset, frame: Frame): string {
    const x = Math.round(frame.width / 2);
    // Preset is orientation-resolved by resolveForOrientation() before it gets here.
    const y = Math.round(frame.height * (preset.position.yPct / 100));
    return `{\\an5\\pos(${x},${y})}`;
}

/** One event per page; each word prefixed with \kf; inter-word gaps as empty syllables. */
function sweepEvents(pages: CaptionPage[], preset: CaptionPreset, frame: Frame): string[] {
    return pages.map(page => {
        let cursor = page.startMs;
        let body = '';
        for (const token of page.tokens) {
            const gapCs = msToCs(token.fromMs - cursor);
            if (gapCs > 0) body += `{\\kf${gapCs}}`;
            body += `{\\kf${msToCs(token.toMs - token.fromMs)}}${displayText(token.text, preset)} `;
            cursor = token.toMs;
        }
        return `Dialogue: 0,${msToAssTime(page.startMs)},${msToAssTime(page.endMs)},Caption,,0,0,0,,${captionPos(preset, frame)}${body.trimEnd()}`;
    });
}

/** One event per page, no per-word styling — the 'none' emphasis. */
function plainEvents(pages: CaptionPage[], preset: CaptionPreset, frame: Frame): string[] {
    return pages.map(page => {
        const body = page.tokens.map(t => displayText(t.text, preset)).join(' ');
        return `Dialogue: 0,${msToAssTime(page.startMs)},${msToAssTime(page.endMs)},Caption,,0,0,0,,${captionPos(preset, frame)}${body}`;
    });
}

/**
 * One event per word window: full page text, active word wrapped in override
 * tags. Used by 'highlight' (color flip) and 'pop' (color + \t scale bounce).
 */
function perWordEvents(pages: CaptionPage[], preset: CaptionPreset, frame: Frame): string[] {
    const events: string[] = [];
    const activeColor = hexToAssColorTag(preset.colors.active);
    for (const page of pages) {
        for (let i = 0; i < page.tokens.length; i++) {
            const from = page.tokens[i].fromMs;
            const to = i + 1 < page.tokens.length ? page.tokens[i + 1].fromMs : page.endMs;
            if (to <= from) continue;
            const body = page.tokens.map((token, j) => {
                const text = displayText(token.text, preset);
                if (j !== i) return text;
                // Vertical scale only: \fscx changes the glyph advance, so scaling the
                // active word horizontally re-flows the line and — because the line is
                // centred on \pos — visibly shifts every other word with it.
                const pop = preset.emphasis.style === 'pop' && preset.emphasis.scalePct
                    ? `\\t(0,120,\\fscy${preset.emphasis.scalePct})\\t(120,240,\\fscy100)`
                    : '';
                return `{\\c${activeColor}${pop}}${text}{\\r}`;
            }).join(' ');
            events.push(`Dialogue: 0,${msToAssTime(from)},${msToAssTime(to)},Caption,,0,0,0,,${captionPos(preset, frame)}${body}`);
        }
    }
    return events;
}

interface ChipGeometry {
    x: number; y: number; nameSize: number; roleSize: number;
    padV: number; accentW: number;
}

function chipGeometry(frame: Frame): ChipGeometry {
    const portrait = frame.height > frame.width;
    const px = (landscape: number, port: number) =>
        Math.max(1, Math.round(frame.height * (portrait ? port : landscape)));
    const base = frame.height * (portrait ? 0.015625 : 0.0389);
    return {
        x: Math.round(frame.width * (portrait ? 0.0278 : 0.015625)),
        y: Math.round(frame.height * (portrait ? 0.2734 : 0.0278)),
        nameSize: Math.round(base * 1.2),   // SPEAKER_NAME_FONT_RATIO
        roleSize: Math.round(base * 0.85),  // PARTY_INFO_FONT_RATIO
        padV: px(0.0111, 0.00625),
        accentW: px(0.004167, 0.00234),
    };
}

/**
 * The overlay wrapped its second line at a character budget rather than letting
 * a long title run the width of the frame — a councillor's full remit can be a
 * sentence.
 */
function wrapChipLine(text: string, portrait: boolean): string[] {
    const max = portrait ? 25 : 35;
    if (text.length <= max) return [text];
    const lines: string[] = [];
    let current = '';
    for (const word of text.split(' ')) {
        const candidate = current ? `${current} ${word}` : word;
        if (candidate.length <= max) {
            current = candidate;
        } else if (current) {
            lines.push(current);
            current = word;
        } else {
            lines.push(word); // single word longer than the budget
        }
    }
    if (current) lines.push(current);
    return lines;
}

function chipEvents(spans: SpeakerSpan[], frame: Frame): string[] {
    const portrait = frame.height > frame.width;
    const g = chipGeometry(frame);
    // Bar on the box's left edge and above it (layer 2). The box starts padV
    // above the text origin, so the bar is offset up by the same amount to line
    // up with the box top rather than the first glyph. The text clears the bar
    // by the box padding, as the overlay's drawbox + drawtext pair did.
    const textX = g.x + g.accentW + g.padV;
    return spans
        .filter(s => s.speaker.name)
        .map(s => {
            // The overlay showed the role, falling back to the party — never both,
            // which is what made this line long enough to span the frame.
            const subtitle = s.speaker.roleLabel || s.speaker.partyLabel;
            const roleLines = subtitle ? wrapChipLine(subtitle, portrait) : [];
            const roleText = roleLines.length
                ? `\\N{\\fs${g.roleSize}}${roleLines.map(escapeAssText).join('\\N')}`
                : '';
            // libass stacks lines at exactly their \fs height with no gap, so this
            // is the box's height: padding above and below plus one size per line.
            const barH = g.padV * 2 + g.nameSize + roleLines.length * g.roleSize;
            const events = [
                `Dialogue: 1,${msToAssTime(s.startMs)},${msToAssTime(s.endMs)},Chip,,0,0,0,,{\\an7\\pos(${textX},${g.y})\\fad(200,0)}${escapeAssText(s.speaker.name!)}${roleText}`,
            ];
            if (s.speaker.partyColorHex) {
                events.unshift(
                    `Dialogue: 2,${msToAssTime(s.startMs)},${msToAssTime(s.endMs)},Accent,,0,0,0,,{\\an7\\pos(${g.x},${g.y - g.padV})\\fad(200,0)\\c${hexToAssColorTag(s.speaker.partyColorHex)}\\p1}m 0 0 l ${g.accentW} 0 l ${g.accentW} ${barH} l 0 ${barH}{\\p0}`
                );
            }
            return events;
        }).flat();
}

export function renderAss(
    timeline: CaptionTimeline,
    preset: CaptionPreset,
    frame: Frame,
    opts: RenderOpts,
): string {
    const header = [
        '[Script Info]',
        'ScriptType: v4.00+',
        `PlayResX: ${frame.width}`,
        `PlayResY: ${frame.height}`,
        'WrapStyle: 3',
        'ScaledBorderAndShadow: yes',
    ].join('\n');

    const events: string[] = [];
    if (opts.includeCaptions) {
        const byStyle = {
            karaoke: sweepEvents,
            none: plainEvents,
        }[preset.emphasis.style as string] ?? perWordEvents;
        events.push(...byStyle(timeline.pages, preset, frame));
    }
    if (opts.includeSpeakerOverlay) {
        events.push(...chipEvents(timeline.speakerSpans, frame));
    }

    return [
        header,
        '',
        styleSection(preset, frame, opts.chipFont ?? CHIP_FONT_DEFAULT),
        '',
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
        ...events,
        '',
    ].join('\n');
}
