/**
 * The normalizer, ported from `fusion/normalize.py` and required to match it
 * exactly. Every frozen WER in `fusion/CONTRACT.md` was measured through the
 * Python; a token this produces differently is a word the fusion may choose
 * differently. Do not "improve" anything here.
 *
 * Two places where the languages do not line up on their own:
 *
 *  - Python's `\w` on a str is Unicode-aware. JavaScript's `\w` is ASCII only,
 *    so the class is spelled out. Measured against Python over every code point
 *    below U+3000 plus samples above it, `[\p{L}\p{N}_]` and Python's `\w`
 *    agree everywhere except U+1C89 and U+1C8A, which this Node's ICU does not
 *    yet classify as letters. Neither can occur in Greek council speech, and
 *    both runtimes' Unicode versions are recorded in the oracle index.
 *  - `unicodedata.category(c) != "Mn"` is `\p{Mn}`, not `\p{M}`: the wider class
 *    would also strip Mc and Me, which the Python keeps.
 *
 * Final sigma needs no special handling: Python's `str.lower()` and JavaScript's
 * `toLowerCase()` both apply the Final_Sigma rule, so `ΟΔΟΣ` ends in `ς` in
 * both. `ς` and `σ` stay distinct tokens, as the Python docstring insists.
 */

export const NORMALIZER_REV = "wtoks/1";

const COMBINING_MARKS = /\p{Mn}/gu;
const WORD = /[\p{L}\p{N}_]+/gu;

export function norm(s: string | null | undefined): string {
    return (s ?? "").normalize("NFD").replace(COMBINING_MARKS, "").toLowerCase();
}

export function wtoks(s: string | null | undefined): string[] {
    return norm(s).match(WORD) ?? [];
}

/** Levenshtein distance over any two sequences. */
export function edist<T>(a: readonly T[], b: readonly T[]): number {
    const n = a.length;
    const m = b.length;
    if (n === 0) return m;

    let prev = Array.from({ length: m + 1 }, (_, j) => j);
    for (let i = 1; i <= n; i++) {
        const cur = new Array<number>(m + 1);
        cur[0] = i;
        for (let j = 1; j <= m; j++) {
            cur[j] = Math.min(
                prev[j] + 1,
                cur[j - 1] + 1,
                prev[j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0),
            );
        }
        prev = cur;
    }
    return prev[m];
}

export interface Sdi {
    s: number;
    d: number;
    i: number;
    nRef: number;
}

/**
 * Levenshtein with a backtrace, returning substitutions, deletions, insertions
 * and the reference length.
 *
 * The tie-break order is load-bearing and is the Python's: when a cell can be
 * reached equally cheaply by more than one edit, substitution wins, then
 * deletion, then insertion. A port that prefers them in another order returns
 * the same distance and a different S/D/I split, and the deletion rate is the
 * number this project watches most closely.
 */
export function sdi(ref: string, hyp: string): Sdi {
    const a = wtoks(ref);
    const b = wtoks(hyp);
    const n = a.length;
    const m = b.length;

    const d: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    const op: string[][] = Array.from({ length: n + 1 }, () => new Array<string>(m + 1).fill(""));

    for (let i = 1; i <= n; i++) {
        d[i][0] = i;
        op[i][0] = "D";
    }
    for (let j = 1; j <= m; j++) {
        d[0][j] = j;
        op[0][j] = "I";
    }

    for (let i = 1; i <= n; i++) {
        const ai = a[i - 1];
        for (let j = 1; j <= m; j++) {
            if (ai === b[j - 1]) {
                d[i][j] = d[i - 1][j - 1];
                op[i][j] = "M";
                continue;
            }
            const sub = d[i - 1][j - 1] + 1;
            const del = d[i - 1][j] + 1;
            const ins = d[i][j - 1] + 1;
            const best = Math.min(sub, del, ins);
            d[i][j] = best;
            op[i][j] = best === sub ? "S" : best === del ? "D" : "I";
        }
    }

    let s = 0;
    let dd = 0;
    let ii = 0;
    let i = n;
    let j = m;
    while (i > 0 || j > 0) {
        const o = op[i][j];
        if (o === "M") {
            i -= 1;
            j -= 1;
        } else if (o === "S") {
            s += 1;
            i -= 1;
            j -= 1;
        } else if (o === "D") {
            dd += 1;
            i -= 1;
        } else {
            ii += 1;
            j -= 1;
        }
    }
    return { s, d: dd, i: ii, nRef: n };
}

export interface TokenizedWords {
    tokens: string[];
    /** `owner[t]` indexes the raw word that produced `tokens[t]`. */
    owner: number[];
}

/**
 * Normalize a provider's raw words into one flat token stream plus the map back.
 *
 * A raw word that normalizes to nothing (pure punctuation) contributes no
 * tokens and never appears in `owner`. One that normalizes to several tokens
 * appears several times. The fused output has to name the raw word each chosen
 * token came from, so this map is what keeps a chosen token attributable.
 */
export function tokenizeWords(raws: readonly string[]): TokenizedWords {
    const tokens: string[] = [];
    const owner: number[] = [];
    for (let r = 0; r < raws.length; r++) {
        for (const t of wtoks(raws[r])) {
            tokens.push(t);
            owner.push(r);
        }
    }
    return { tokens, owner };
}
