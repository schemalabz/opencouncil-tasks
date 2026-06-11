import { describe, expect, it } from 'vitest';
import { cleanRefs, esc, wordDiff } from './client.js';

describe('cleanRefs', () => {
    it('strips REF markdown links, keeping the label', () => {
        expect(cleanRefs('Ο [Δήμαρχος](REF:PERSON:abc-123) μίλησε')).toBe('Ο Δήμαρχος μίλησε');
    });

    it('leaves plain text untouched', () => {
        expect(cleanRefs('Κανονικό [κείμενο] (χωρίς ref)')).toBe('Κανονικό [κείμενο] (χωρίς ref)');
    });
});

describe('esc', () => {
    it('escapes HTML special characters', () => {
        expect(esc('<script>"a" & b</script>')).toBe('&lt;script&gt;&quot;a&quot; &amp; b&lt;/script&gt;');
    });

    it('returns empty string for null/undefined', () => {
        expect(esc(null)).toBe('');
        expect(esc(undefined)).toBe('');
    });
});

describe('wordDiff', () => {
    it('returns escaped text without diff marks when identical', () => {
        const out = wordDiff('ίδιο κείμενο', 'ίδιο κείμενο');
        expect(out).toBe('ίδιο κείμενο');
    });

    it('marks added words', () => {
        const out = wordDiff('το έργο εγκρίθηκε', 'το έργο εγκρίθηκε ομόφωνα');
        expect(out).toBe('το έργο εγκρίθηκε <span class="diff-added">ομόφωνα</span>');
    });

    it('marks removed words', () => {
        const out = wordDiff('το έργο εγκρίθηκε ομόφωνα', 'το έργο εγκρίθηκε');
        expect(out).toBe('το έργο εγκρίθηκε <span class="diff-removed">ομόφωνα</span>');
    });

    it('marks replacements as removed plus added', () => {
        const out = wordDiff('η πρόταση απορρίφθηκε χθες', 'η πρόταση εγκρίθηκε χθες');
        expect(out).toBe('η πρόταση <span class="diff-removed">απορρίφθηκε</span> <span class="diff-added">εγκρίθηκε</span> χθες');
    });

    it('handles one side being empty', () => {
        expect(wordDiff('', 'νέο')).toBe('<span class="diff-added">νέο</span>');
        expect(wordDiff('παλιό', '')).toBe('<span class="diff-removed">παλιό</span>');
        expect(wordDiff('', '')).toBe('');
    });

    it('escapes HTML inside diffed words', () => {
        const out = wordDiff('a', 'a <b>bold</b>');
        expect(out).not.toContain('<b>');
        expect(out).toContain('&lt;b&gt;bold&lt;/b&gt;');
    });

    it('diffs through REF links by their labels', () => {
        const out = wordDiff('Ο [Δήμαρχος](REF:PERSON:x) μίλησε', 'Ο Δήμαρχος μίλησε εκτενώς');
        expect(out).toBe('Ο Δήμαρχος μίλησε <span class="diff-added">εκτενώς</span>');
    });
});
