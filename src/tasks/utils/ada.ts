/**
 * Diavgeia answers 404 for an ΑΔΑ in lowercase or with Latin letters that
 * look Greek, so a hand-typed ΑΔΑ must be brought to Diavgeia's own form
 * before any lookup. The app keeps a copy of this rule
 * (opencouncil `src/lib/utils/ada.ts`); change both together.
 */
const LATIN_TO_GREEK: Record<string, string> = {
    A: 'Α', B: 'Β', E: 'Ε', Z: 'Ζ', H: 'Η', I: 'Ι', K: 'Κ',
    M: 'Μ', N: 'Ν', O: 'Ο', P: 'Ρ', T: 'Τ', Y: 'Υ', X: 'Χ',
};

const ADA_PATTERN = /^[0-9Α-Ω]+(-[0-9Α-Ω]+)+$/;

export function normalizeAda(input: string): string | null {
    const upper = input.trim().toLocaleUpperCase('el');
    const greek = [...upper].map(c => LATIN_TO_GREEK[c] ?? c).join('');
    return ADA_PATTERN.test(greek) ? greek : null;
}
