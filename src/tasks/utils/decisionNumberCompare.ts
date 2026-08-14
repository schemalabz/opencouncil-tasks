/**
 * Comparison of decision numbers as printed (issue #617). Verified labels are
 * verbatim and legitimately vary in form — "67/17-07-2026", "142", "1487/2026",
 * "206", "123-2024" can all be the same class of identifier. Two numbers agree
 * when their numeric core matches, and, when BOTH sides state a year, the years
 * match too. A year stated on only one side is not a disagreement.
 */

interface ParsedDecisionNumber {
    core: string | null;
    year: string | null;
}

function parseDecisionNumber(value: string): ParsedDecisionNumber {
    const coreMatch = value.match(/\d+/);
    if (!coreMatch) return { core: null, year: null };
    const rest = value.slice(coreMatch.index! + coreMatch[0].length);
    const yearMatch = rest.match(/(?:^|[^\d])((?:19|20)\d{2})(?:[^\d]|$)/);
    return { core: coreMatch[0], year: yearMatch ? yearMatch[1] : null };
}

export function sameDecisionNumber(a: string, b: string): boolean {
    const pa = parseDecisionNumber(a);
    const pb = parseDecisionNumber(b);
    if (!pa.core || !pb.core) return false;
    if (pa.core !== pb.core) return false;
    if (pa.year && pb.year && pa.year !== pb.year) return false;
    return true;
}
