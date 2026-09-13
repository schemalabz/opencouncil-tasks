/**
 * Column classes and disagreement islands, ported from `fusion/islands.py`.
 *
 * The homophone/eligibility half of the research module is deliberately absent
 * there and absent here: the frozen arms never call it and it depends on a
 * Greek phonetics table that is research-only.
 */

export const CLASSES = [
    "invalid", "singleton", "two_present_same", "agree", "exact_2_of_3",
    "unresolved_two", "unresolved_three",
] as const;

export type ColumnClass = (typeof CLASSES)[number];

import type { Column } from "./msa.js";

export function columnClass(col: Column): ColumnClass {
    const present = col.filter((e): e is string => e !== null);
    const n = present.length;
    const distinct = new Set(present).size;
    if (n === 0) return "invalid";
    if (n === 1) return "singleton";
    if (distinct === 1) return n === 3 ? "agree" : "two_present_same";
    if (n === 3 && distinct === 2) return "exact_2_of_3";
    return n === 3 ? "unresolved_three" : "unresolved_two";
}

/**
 * Indices of columns caught in a token-boundary disagreement.
 *
 * Two systems spell the same character string across one adjacent pair of
 * columns but cut it in different places: `(στο, σ, eps)` followed by
 * `(eps, το, στο)`. Voting the two columns independently cannot reconstruct
 * either spelling, so both are marked.
 */
export function splitMergeColumns(cols: readonly Column[]): Set<number> {
    const bad = new Set<number>();
    for (let i = 0; i < cols.length - 1; i++) {
        const joined: [string, [string | null, string | null]][] = [];
        for (let s = 0; s < 3; s++) {
            const a = cols[i][s] ?? "";
            const b = cols[i + 1][s] ?? "";
            joined.push([a + b, [cols[i][s], cols[i + 1][s]]]);
        }
        for (let x = 0; x < 3; x++) {
            for (let y = x + 1; y < 3; y++) {
                const [jx, sx] = joined[x];
                const [jy, sy] = joined[y];
                const samePieces = sx[0] === sy[0] && sx[1] === sy[1];
                if (jx && jx === jy && !samePieces) {
                    bad.add(i);
                    bad.add(i + 1);
                }
            }
        }
    }
    return bad;
}

/**
 * Maximal runs of consecutive non-`agree` columns, as half-open `[start, end)`.
 *
 * This describes the frozen alignment, not a linguistic error span: an `agree`
 * column can sit inside a wider boundary disagreement and cut it in two, and
 * two unrelated errors one column apart merge into a single island.
 */
export function islands(cols: readonly Column[]): [number, number][] {
    const out: [number, number][] = [];
    let s: number | null = null;
    for (let i = 0; i < cols.length; i++) {
        if (columnClass(cols[i]) !== "agree") {
            if (s === null) s = i;
        } else if (s !== null) {
            out.push([s, i]);
            s = null;
        }
    }
    if (s !== null) out.push([s, cols.length]);
    return out;
}
