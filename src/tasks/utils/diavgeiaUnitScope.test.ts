import { describe, it, expect } from 'vitest';
import { parseDiavgeiaUnitScopes, formatDiavgeiaUnitScope } from './diavgeiaUnitScope.js';

describe('parseDiavgeiaUnitScopes', () => {
    it('reads a bare unit as unit-only', () => {
        expect(parseDiavgeiaUnitScopes(['81689'])).toEqual([{ unit: '81689' }]);
    });

    it('reads unit:signer as a pair', () => {
        expect(parseDiavgeiaUnitScopes(['84655:100010590'])).toEqual([
            { unit: '84655', signer: '100010590' },
        ]);
    });

    it('keeps bare and scoped entries side by side', () => {
        expect(parseDiavgeiaUnitScopes(['81689', '84655:100022189'])).toEqual([
            { unit: '81689' },
            { unit: '84655', signer: '100022189' },
        ]);
    });

    it('keeps two signers on the same unit as two queries', () => {
        expect(parseDiavgeiaUnitScopes(['84655:100022189', '84655:129415'])).toEqual([
            { unit: '84655', signer: '100022189' },
            { unit: '84655', signer: '129415' },
        ]);
    });

    it('trims whitespace around either part', () => {
        expect(parseDiavgeiaUnitScopes([' 84655 : 100010590 '])).toEqual([
            { unit: '84655', signer: '100010590' },
        ]);
    });

    it('skips blank entries', () => {
        expect(parseDiavgeiaUnitScopes(['81689', '', '  '])).toEqual([{ unit: '81689' }]);
    });

    it('treats an empty signer part as unit-only', () => {
        expect(parseDiavgeiaUnitScopes(['84655:'])).toEqual([{ unit: '84655' }]);
    });

    it('throws on a malformed entry instead of narrowing the poll silently', () => {
        expect(() => parseDiavgeiaUnitScopes(['84655:100:extra'])).toThrow(/Malformed/);
        expect(() => parseDiavgeiaUnitScopes([':100010590'])).toThrow(/Malformed/);
        expect(() => parseDiavgeiaUnitScopes([':'])).toThrow(/Malformed/);
    });

    it('yields one org-wide query when nothing is configured', () => {
        expect(parseDiavgeiaUnitScopes([])).toEqual([{}]);
        expect(parseDiavgeiaUnitScopes(undefined)).toEqual([{}]);
    });
});

describe('formatDiavgeiaUnitScope', () => {
    it('renders each scope shape', () => {
        expect(formatDiavgeiaUnitScope({ unit: '81689' })).toBe('81689');
        expect(formatDiavgeiaUnitScope({ unit: '84655', signer: '129415' })).toBe('84655:129415');
        expect(formatDiavgeiaUnitScope({})).toBe('org-wide');
    });
});
