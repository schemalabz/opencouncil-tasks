import { describe, it, expect } from 'vitest';
import {
  normalizeUtteranceTimestamps,
  escapeTextForFFmpeg,
  wrapTextByPixelWidth,
  calculateOptimalFontSizeWithStartAndCap,
  getPresetConfig,
  generateSocialFilter,
  generateBlurredMarginFilter,
  generateSolidMarginFilter,
  calculateSpeakerDisplaySegments,
  wrapSpeakerText,
  formatSpeakerInfo,
} from './mediaOperations.js';

describe('normalizeUtteranceTimestamps', () => {
  it('produces sequential timeline from non-sequential sources', () => {
    const utterances = [
      { text: 'a', startTimestamp: 100, endTimestamp: 105 },
      { text: 'b', startTimestamp: 200, endTimestamp: 203 },
      { text: 'c', startTimestamp: 300, endTimestamp: 310 },
    ];
    const result = normalizeUtteranceTimestamps(utterances);

    expect(result[0].normalizedStart).toBe(0);
    expect(result[0].normalizedEnd).toBe(5);
    expect(result[1].normalizedStart).toBe(5);
    expect(result[1].normalizedEnd).toBe(8);
    expect(result[2].normalizedStart).toBe(8);
    expect(result[2].normalizedEnd).toBe(18);
  });

  it('preserves original timestamps', () => {
    const utterances = [{ text: 'x', startTimestamp: 50, endTimestamp: 60 }];
    const result = normalizeUtteranceTimestamps(utterances);
    expect(result[0].originalStart).toBe(50);
    expect(result[0].originalEnd).toBe(60);
  });

  it('returns empty array for empty input', () => {
    expect(normalizeUtteranceTimestamps([])).toEqual([]);
  });
});

describe('escapeTextForFFmpeg', () => {
  it('escapes square brackets', () => {
    expect(escapeTextForFFmpeg('[test]')).toBe('\\[test\\]');
  });

  it('escapes colons', () => {
    expect(escapeTextForFFmpeg('time: 3:00')).toBe('time\\: 3\\:00');
  });

  it('escapes semicolons', () => {
    expect(escapeTextForFFmpeg('a;b')).toBe('a\\;b');
  });

  it('replaces apostrophes with curly quote', () => {
    expect(escapeTextForFFmpeg("it's")).toBe('it\u2019s');
  });

  it('escapes percent signs', () => {
    expect(escapeTextForFFmpeg('100%')).toBe('100\\%');
  });

  it('escapes backslashes before other escapes', () => {
    expect(escapeTextForFFmpeg('a\\b')).toBe('a\\\\b');
  });

  it('escapes commas', () => {
    expect(escapeTextForFFmpeg('a,b')).toBe('a\\,b');
  });
});

describe('wrapTextByPixelWidth', () => {
  it('keeps single short word on one line', () => {
    // fontSize=20, charWidth=12, availableWidth=200 → ~16 chars per line
    const result = wrapTextByPixelWidth('hello', 20, 200);
    expect(result).toBe('hello');
  });

  it('wraps text that exceeds available width', () => {
    // fontSize=20, charWidth=12, availableWidth=120 → ~10 chars per line
    const result = wrapTextByPixelWidth('hello world foo', 20, 120);
    const lines = result.split('\n');
    expect(lines.length).toBeGreaterThan(1);
  });

  it('handles a single word longer than the line width', () => {
    const result = wrapTextByPixelWidth('supercalifragilistic', 20, 60);
    // Should still produce output (word forced onto line)
    expect(result).toContain('supercalifragilistic');
  });
});

describe('calculateOptimalFontSizeWithStartAndCap', () => {
  it('returns start font size when text fits', () => {
    const { fontSize } = calculateOptimalFontSizeWithStartAndCap(
      'short', 'default', 32, 36, 30, 1280,
    );
    expect(fontSize).toBe(32);
  });

  it('shrinks font to fit long text', () => {
    const longText = 'This is a very long text that will definitely need to wrap across multiple lines and probably require a smaller font size to fit within the available space constraints of this narrow frame';
    const { fontSize } = calculateOptimalFontSizeWithStartAndCap(
      longText, 'default', 32, 36, 30, 400, 3,
    );
    expect(fontSize).toBeLessThan(32);
  });

  it('truncates with "..." when text cannot fit even at min font', () => {
    const veryLongText = Array(200).fill('word').join(' ');
    const { wrappedText } = calculateOptimalFontSizeWithStartAndCap(
      veryLongText, 'default', 32, 36, 30, 300, 2,
    );
    expect(wrappedText).toContain('...');
  });
});

describe('getPresetConfig', () => {
  it('returns config for known resolution', () => {
    const { config, dimensions } = getPresetConfig('1280x720', 'default');
    expect(dimensions).toEqual({ width: 1280, height: 720 });
    expect(config.caption['default'].startFont).toBe(32);
  });

  it('falls back to first preset for unknown resolution', () => {
    const { config } = getPresetConfig('9999x9999', 'default');
    expect(config.caption['default']).toBeDefined();
  });

  it('swaps dimensions for social-9x16', () => {
    const { dimensions } = getPresetConfig('1280x720', 'social-9x16');
    // 1280x720 → look up swapped 720x1280 → returns { width: 720, height: 1280 }
    expect(dimensions.width).toBe(720);
    expect(dimensions.height).toBe(1280);
  });
});

describe('generateSocialFilter', () => {
  it('generates blur filter chain', () => {
    const filter = generateSocialFilter(
      { marginType: 'blur', backgroundColor: '#000000', zoomFactor: 1.0 },
      1280, 720,
    );
    expect(filter).toContain('split=2[bg][video]');
    expect(filter).toContain('gblur');
    expect(filter).toContain('overlay');
    expect(filter).toContain('setdar=9/16');
  });

  it('generates solid margin filter chain', () => {
    const filter = generateSocialFilter(
      { marginType: 'solid', backgroundColor: '#ff0000', zoomFactor: 0.8 },
      1280, 720,
    );
    expect(filter).toContain('pad=');
    expect(filter).toContain('0xff0000');
    expect(filter).toContain('setdar=9/16');
  });
});

describe('generateBlurredMarginFilter', () => {
  it('produces filter with split, blur, scale, and overlay', () => {
    const filter = generateBlurredMarginFilter(0.9, 1280, 720);
    expect(filter).toContain('split=2[bg][video]');
    expect(filter).toContain('gblur=sigma=20');
    expect(filter).toContain('0.9');
    expect(filter).toContain('overlay=(W-w)/2:(H-h)/2');
  });
});

describe('generateSolidMarginFilter', () => {
  it('produces filter with scale, pad, and format', () => {
    const filter = generateSolidMarginFilter(1.0, '#00ff00', 1280, 720);
    expect(filter).toContain('scale=');
    expect(filter).toContain('pad=');
    expect(filter).toContain('0x00ff00');
    expect(filter).toContain('format=yuv420p');
  });
});

describe('calculateSpeakerDisplaySegments', () => {
  const utterances = [
    { text: 'a', startTimestamp: 0, endTimestamp: 5, speaker: { id: 's1', name: 'Alice' } },
    { text: 'b', startTimestamp: 5, endTimestamp: 10, speaker: { id: 's1', name: 'Alice' } },
    { text: 'c', startTimestamp: 10, endTimestamp: 15, speaker: { id: 's2', name: 'Bob' } },
  ];

  it('"always" mode shows overlay for all segments', () => {
    const segments = calculateSpeakerDisplaySegments(utterances, 'always');
    expect(segments.every(s => s.showOverlay)).toBe(true);
    expect(segments).toHaveLength(3);
  });

  it('"on_speaker_change" mode shows only on change', () => {
    const segments = calculateSpeakerDisplaySegments(utterances, 'on_speaker_change');
    // First utterance (s1) → show, second (s1 same) → hide, third (s2 different) → show
    expect(segments[0].showOverlay).toBe(true);
    expect(segments[1].showOverlay).toBe(false);
    expect(segments[2].showOverlay).toBe(true);
  });

  it('returns empty for empty input', () => {
    expect(calculateSpeakerDisplaySegments([], 'always')).toEqual([]);
  });
});

describe('wrapSpeakerText', () => {
  it('returns text unchanged when within limit', () => {
    expect(wrapSpeakerText('Short text', false)).toBe('Short text');
  });

  it('wraps long text across lines', () => {
    const long = 'This is a very long role description that should wrap';
    const result = wrapSpeakerText(long, false);
    expect(result).toContain('\n');
  });

  it('forces single long word onto a line', () => {
    const word = 'Superlongwordthatexceedslimit';
    const result = wrapSpeakerText(word, true);
    // Should contain the word even though it exceeds max chars
    expect(result).toContain(word);
  });
});

describe('formatSpeakerInfo', () => {
  it('returns "Unknown Speaker" when no speaker provided', () => {
    expect(formatSpeakerInfo(undefined).name).toBe('Unknown Speaker');
  });

  it('extracts name, role, party, and color', () => {
    const info = formatSpeakerInfo({
      id: '1',
      name: 'Alice',
      roleLabel: 'Minister',
      partyLabel: 'Party A',
      partyColorHex: '#ff0000',
    });
    expect(info.name).toBe('Alice');
    expect(info.role).toBe('Minister');
    expect(info.party).toBe('Party A');
    expect(info.partyColor).toBe('#ff0000');
  });
});
