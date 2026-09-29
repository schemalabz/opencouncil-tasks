import { describe, it, expect } from 'vitest';
import { normalizeAda } from './ada.js';

describe('normalizeAda', () => {
    it('keeps a canonical ΑΔΑ', () => {
        expect(normalizeAda('9ΩΡΤΩΞ1-0ΥΣ')).toBe('9ΩΡΤΩΞ1-0ΥΣ');
    });
    it('trims and uppercases Greek', () => {
        expect(normalizeAda('  9ωρτωξ1-0υσ ')).toBe('9ΩΡΤΩΞ1-0ΥΣ');
    });
    it('maps Latin look-alike letters to Greek', () => {
        expect(normalizeAda('9ΩPTΩΞ1-0YΣ')).toBe('9ΩΡΤΩΞ1-0ΥΣ');
        expect(normalizeAda('91yΔΩPΦ-ΓY6')).toBe('91ΥΔΩΡΦ-ΓΥ6');
    });
    it('rejects an empty or malformed value', () => {
        expect(normalizeAda('')).toBeNull();
        expect(normalizeAda('hello')).toBeNull();
        expect(normalizeAda('9ΩΡΤΩΞ1')).toBeNull();
        expect(normalizeAda('9ΩΡΤΩΞ1--0ΥΣ')).toBeNull();
    });
});
