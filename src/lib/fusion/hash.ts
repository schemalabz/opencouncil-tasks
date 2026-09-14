import crypto from "crypto";

/**
 * Deterministic JSON: object keys sorted at every depth, so two structurally
 * equal values always hash to the same string. Cache keys and trace component
 * hashes depend on this — a key that depends on property insertion order would
 * silently split the cache and unpair the benchmark arms.
 */
export function canonicalJson(value: unknown): string {
    return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
    if (value === null || typeof value !== "object") {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map(canonicalize);
    }
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
        if (source[key] === undefined) continue;
        out[key] = canonicalize(source[key]);
    }
    return out;
}

export function sha256Hex(input: string | Buffer): string {
    return crypto.createHash("sha256").update(input).digest("hex");
}

/** sha256 of the canonical JSON encoding of a value. */
export function sha256OfValue(value: unknown): string {
    return sha256Hex(canonicalJson(value));
}

/** Short, human-quotable form used in traces and config identifiers. */
export function shortSha(hex: string): string {
    return hex.slice(0, 16);
}
