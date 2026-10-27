import { describe, expect, it } from 'vitest';
import { parseIntOption, parsePositiveIntOption, parseUsdOption } from './cliOptions.js';

describe('parseUsdOption', () => {
    // NaN would never trip the ceiling: `spent >= NaN` is false.
    it('refuses what is not an amount, so a typo cannot lift the spend ceiling', () => {
        for (const bad of ['abc', '', ' ', '-1', 'Infinity']) expect(() => parseUsdOption(bad), bad).toThrow(/USD/);
        expect(parseUsdOption('0.5')).toBe(0.5);
        expect(parseUsdOption('0')).toBe(0);
    });
});

describe('parseIntOption', () => {
    it('refuses a non-number', () => {
        expect(() => parseIntOption('x')).toThrow(/number/);
        expect(parseIntOption('3')).toBe(3);
    });
});

describe('parsePositiveIntOption', () => {
    it('refuses a count that would do nothing or is not whole', () => {
        for (const bad of ['0', '-2', '1.5', '', 'x']) expect(() => parsePositiveIntOption(bad), bad).toThrow(/at least 1/);
        expect(parsePositiveIntOption('4')).toBe(4);
    });
});
