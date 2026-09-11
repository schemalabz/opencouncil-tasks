/**
 * `json.dumps(..., ensure_ascii=False, sort_keys=True)`, in JavaScript.
 *
 * This exists for one reason: `row_sha` in `fusion/rules.py` hashes the output
 * of that call, and the hash keys the policy fixtures. `JSON.stringify` writes
 * `{"a":1}` where Python writes `{"a": 1}`, because Python's default separators
 * carry a space after both the comma and the colon. The two hashes then differ
 * for every island, and nothing about the transcript looks wrong.
 *
 * Key order is Python's too: `sort_keys=True` sorts by code point, which is not
 * what `Array.prototype.sort` does above the BMP.
 */

function byCodePoint(a: string, b: string): number {
    const ax = [...a];
    const bx = [...b];
    const n = Math.min(ax.length, bx.length);
    for (let i = 0; i < n; i++) {
        const d = ax[i].codePointAt(0)! - bx[i].codePointAt(0)!;
        if (d !== 0) return d;
    }
    return ax.length - bx.length;
}

function encodeString(s: string): string {
    // `ensure_ascii=False` leaves non-ASCII alone; both languages escape the
    // same C0 controls, the quote and the backslash.
    let out = '"';
    for (const ch of s) {
        switch (ch) {
            case '"': out += '\\"'; break;
            case "\\": out += "\\\\"; break;
            case "\n": out += "\\n"; break;
            case "\r": out += "\\r"; break;
            case "\t": out += "\\t"; break;
            case "\b": out += "\\b"; break;
            case "\f": out += "\\f"; break;
            default: {
                const cp = ch.codePointAt(0)!;
                out += cp < 0x20
                    ? "\\u" + cp.toString(16).padStart(4, "0")
                    : ch;
            }
        }
    }
    return out + '"';
}

function encodeNumber(n: number): string {
    if (Number.isInteger(n) && Object.is(n, Math.trunc(n)) && !Object.is(n, -0)) {
        return String(n);
    }
    if (Number.isNaN(n)) return "NaN";
    if (n === Infinity) return "Infinity";
    if (n === -Infinity) return "-Infinity";
    return String(n);
}

export function pyJsonDumps(value: unknown): string {
    if (value === null || value === undefined) return "null";
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "number") return encodeNumber(value);
    if (typeof value === "string") return encodeString(value);
    if (Array.isArray(value)) {
        return "[" + value.map(pyJsonDumps).join(", ") + "]";
    }
    if (typeof value === "object") {
        const obj = value as Record<string, unknown>;
        const keys = Object.keys(obj).sort(byCodePoint);
        return "{" + keys
            .map((k) => encodeString(k) + ": " + pyJsonDumps(obj[k]))
            .join(", ") + "}";
    }
    throw new TypeError(`cannot serialize ${typeof value}`);
}

/**
 * `sum()` over floats, as CPython does it.
 *
 * Since 3.12 the builtin uses Neumaier compensated summation, so adding seven
 * copies of 0.9 gives exactly 6.3 where a naive loop gives 6.300000000000001.
 * Averaging provider confidences hit this on real windows: the transcript was
 * identical and one field in every alternative was off by one unit in the last
 * place. Measured against Python for every length from 1 to 59, the naive loop
 * diverges from 7 upwards and this does not diverge at all.
 */
export function pySum(values: readonly number[]): number {
    let s = 0;
    let c = 0;
    for (const x of values) {
        const t = s + x;
        c += Math.abs(s) >= Math.abs(x) ? (s - t) + x : (x - t) + s;
        s = t;
    }
    return s + c;
}
