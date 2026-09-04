import { describe, it, expect } from 'vitest';
import { msToAssTime, msToCs, hexToAssColorTag, hexToAssStyleColor, escapeAssText } from './assFormat.js';

describe('msToAssTime', () => {
    it('formats zero', () => expect(msToAssTime(0)).toBe('0:00:00.00'));
    it('formats h/m/s/cs with rounding', () => expect(msToAssTime(3_725_456)).toBe('1:02:05.46'));
    it('pads minutes and seconds', () => expect(msToAssTime(61_000)).toBe('0:01:01.00'));
});

describe('msToCs', () => {
    it('rounds to centiseconds', () => expect(msToCs(456)).toBe(46));
});

describe('hexToAssColorTag', () => {
    it('converts RGB hex to BGR tag', () => expect(hexToAssColorTag('#FF6600')).toBe('&H0066FF&'));
    it('accepts lowercase without hash', () => expect(hexToAssColorTag('ffffff')).toBe('&HFFFFFF&'));
    it('falls back to white for 3-digit hex shorthand', () => expect(hexToAssColorTag('#FFF')).toBe('&HFFFFFF&'));
    it('falls back to white for garbage input', () => expect(hexToAssColorTag('not-a-color')).toBe('&HFFFFFF&'));
});

describe('hexToAssStyleColor', () => {
    it('is opaque by default', () => expect(hexToAssStyleColor('#FF6600')).toBe('&H000066FF'));
    it('encodes alpha (255 = fully transparent)', () => expect(hexToAssStyleColor('#000000', 128)).toBe('&H80000000'));
});

describe('escapeAssText', () => {
    it('neutralizes override braces', () => expect(escapeAssText('a {b} c')).toBe('a (b) c'));
    it('converts newlines to \\N', () => expect(escapeAssText('a\nb')).toBe('a\\Nb'));
    // A literal backslash in source text would otherwise be read as a control
    // sequence: '\N' breaks the line, '\h' inserts a hard space.
    it('neutralizes backslashes without touching the newline it emits', () =>
        expect(escapeAssText('a\\Nb\nc')).toBe('a/Nb\\Nc'));
});
