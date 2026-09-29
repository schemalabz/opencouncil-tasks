import { describe, it, expect } from 'vitest';
import { parseBodyHints } from './bodyHints.js';

// What opencouncil's `scripts/conventions-text.ts --all` prints: one `### city/body`
// header per body, its sentences, and a blank line.
const PRINTED = `### argos/Δημοτικό Συμβούλιο
Present and absent lists at the top.
Arrivals and departures are pinned to: the document's own subject.

### zografou/Δημοτική Επιτροπή
Present and absent lists at the top.

`;

describe('parseBodyHints', () => {
    it('reads each body the producer prints, keyed by city and body', () => {
        const hints = parseBodyHints(PRINTED);
        expect([...hints.keys()]).toEqual(['argos/Δημοτικό Συμβούλιο', 'zografou/Δημοτική Επιτροπή']);
        expect(hints.get('argos/Δημοτικό Συμβούλιο')).toBe('Present and absent lists at the top.\nArrivals and departures are pinned to: the document\'s own subject.');
    });
    it('skips a body whose text is empty', () => {
        expect(parseBodyHints('### a/b\n\n### c/d\nText.\n').has('a/b')).toBe(false);
    });
    it('refuses text with no header, which is one body\'s hints and not a per-body file', () => {
        expect(() => parseBodyHints('Present and absent lists at the top.\n')).toThrow(/### /);
    });
});
