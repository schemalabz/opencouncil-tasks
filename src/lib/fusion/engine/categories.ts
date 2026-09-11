/**
 * The island category scheme, ported from `fusion/categories.py`.
 *
 * Which PAIR agrees is part of the signature, because "scribe and soniox agree"
 * is not the same evidence as "soniox and ours agree".
 *
 *   PAIR_x    two identical non-empty spans, third different and non-empty
 *   PAIRE_x   two identical non-empty spans, third empty
 *   SOLO_x    one non-empty span, two empty
 *   TWO_no_x  two different non-empty spans, third empty
 *   THREE     three different non-empty spans
 *
 * Python groups the spans in a `defaultdict` keyed by the span tuple and then
 * takes the first group of two in insertion order. JavaScript has no tuple
 * keys, so the grouping runs through a `Map` keyed by the span's JSON, which
 * keeps both the value semantics and the insertion order the tie depends on.
 */

export const SHORT = ["scribe", "soniox", "ours"] as const;

export const FILLERS: ReadonlySet<string> = new Set([
    "εε", "εεε", "εεεε", "ε", "μμ", "μμμ", "αα", "ααα", "ααμ", "χμ",
    "ε ε", "ναι ναι",
]);

export const UNITS: ReadonlyMap<string, number> = new Map<string, number>([
    ["μηδεν", 0], ["ενα", 1], ["δυο", 2], ["τρια", 3], ["τρεις", 3],
    ["τεσσερα", 4], ["τεσσερις", 4], ["πεντε", 5], ["εξι", 6], ["εφτα", 7],
    ["επτα", 7], ["οχτω", 8], ["οκτω", 8], ["εννια", 9], ["εννεα", 9],
    ["δεκα", 10], ["εντεκα", 11], ["δωδεκα", 12], ["δεκατρια", 13],
    ["εικοσι", 20], ["τριαντα", 30], ["σαραντα", 40], ["πενηντα", 50],
    ["εξηντα", 60], ["εβδομηντα", 70], ["ογδοντα", 80], ["ενενηντα", 90],
    ["εκατο", 100], ["χιλια", 1000],
]);

/**
 * Python's `\d` is Unicode-aware and its `int()` parses any decimal digit, so
 * `٧` is a number there and would not be one under JavaScript's ASCII `\d`.
 * `\p{Nd}` restores that, and each digit is folded to its value before parsing.
 * Unbounded on purpose: Python integers do not overflow, and a long enough
 * digit string would lose its last places as a JavaScript number.
 */
const ALL_DIGITS = /^\p{Nd}+$/u;
const ONE_DIGIT = /^\p{Nd}$/u;
const ASCII_ZERO = 0x30;

/**
 * Code point of the zero of each decimal-digit block this runtime knows.
 *
 * Walking down from a digit to the first non-digit looks like it would find the
 * block's zero, and does not: the mathematical digit blocks sit directly
 * against each other, so U+1D7D8 (double-struck zero) would be read as the
 * tenth digit of the bold block. Measured against Python, that heuristic got 40
 * code points wrong.
 *
 * Runs of consecutive digits are therefore cut into tens, which is what the
 * Unicode rule that every Nd block is exactly ten code points long guarantees.
 * The scan runs to U+20000 because the newest digit block, the segmented digits
 * at U+1FBF0, sits above every range one would otherwise think to stop at.
 */
const DIGIT_ZEROS: ReadonlySet<number> = (() => {
    const zeros = new Set<number>();
    let runStart: number | null = null;
    for (let cp = 0x30; cp <= 0x20000; cp++) {
        const isDigit = cp <= 0x10ffff && ONE_DIGIT.test(String.fromCodePoint(cp));
        if (isDigit) {
            if (runStart === null) runStart = cp;
        } else if (runStart !== null) {
            for (let z = runStart; z < cp; z += 10) zeros.add(z);
            runStart = null;
        }
    }
    return zeros;
})();

/** The value of one decimal digit in any script this runtime classifies. */
function digitValue(ch: string): number {
    const cp = ch.codePointAt(0)!;
    for (let d = 0; d <= 9; d++) {
        if (DIGIT_ZEROS.has(cp - d)) return d;
    }
    return 0;
}

export function numkey(t: string): string {
    // Python's `int(t)` drops leading zeros, so "007" and "7" share a key, and
    // it never overflows, so the parse goes through BigInt.
    if (ALL_DIGITS.test(t)) {
        const ascii = [...t]
            .map((ch) => String.fromCharCode(ASCII_ZERO + digitValue(ch)))
            .join("");
        return "#" + String(BigInt(ascii));
    }
    const unit = UNITS.get(t);
    if (unit !== undefined) return "#" + String(unit);
    return t;
}

export function normNum(span: readonly string[]): string[] {
    return span.map(numkey);
}

export function stripFill(span: readonly string[]): string[] {
    return span.filter((t) => !FILLERS.has(t));
}

export function stripDup(span: readonly string[], ctx: ReadonlySet<string>): string[] {
    return span.filter((t) => !ctx.has(t));
}

export function signature(spans: readonly (readonly string[])[]): string {
    const ne: number[] = [];
    for (let i = 0; i < spans.length; i++) if (spans[i].length) ne.push(i);

    const key = (s: readonly string[]) => JSON.stringify(s);

    if (ne.length === 1) return "SOLO_" + SHORT[ne[0]];
    if (ne.length === 2) {
        const [a, b] = ne;
        if (key(spans[a]) === key(spans[b])) {
            return "PAIRE_" + ne.map((i) => SHORT[i]).join("+");
        }
        const missing = [0, 1, 2].filter((i) => !ne.includes(i))[0];
        return "TWO_no_" + SHORT[missing];
    }

    const groups = new Map<string, number[]>();
    for (let i = 0; i < spans.length; i++) {
        const k = key(spans[i]);
        const g = groups.get(k);
        if (g) g.push(i);
        else groups.set(k, [i]);
    }
    if (groups.size === 2) {
        for (const v of groups.values()) {
            if (v.length === 2) return "PAIR_" + v.map((i) => SHORT[i]).join("+");
        }
    }
    return "THREE";
}
