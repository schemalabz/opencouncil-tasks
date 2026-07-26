/**
 * Single source of truth for the relationship between a public file URL and our Spaces
 * storage. `uploadToSpaces` builds URLs as `${base}/${key}`, so classification ("is this URL
 * ours?") and key extraction are exact inverses of that construction — they live together
 * here so the boundary logic is defined once and cannot drift between callers.
 *
 * `base` defaults to SPACES_PUBLIC_URL (read once, trailing slash trimmed) but is an explicit
 * parameter so callers/tests can inject it rather than depend on ambient process.env.
 */
export function spacesPublicBase(): string | undefined {
    return process.env.SPACES_PUBLIC_URL?.replace(/\/+$/, "");
}

/**
 * True when `url` addresses an object under our Spaces public base. Path-boundary aware:
 * base `https://host` matches `https://host/x` but NOT `https://host.evil.com/x`, and base
 * `.../bucket` matches `.../bucket/x` but NOT `.../bucket2/x`.
 */
export function isSpacesUrl(url: string, base = spacesPublicBase()): boolean {
    if (!base) return false;
    const u = url.split("?")[0];
    return u === base || u.startsWith(base + "/");
}

/**
 * Extract the S3 object key from a public URL — the inverse of `${base}/${key}`. When the URL
 * is under our base, the key is whatever follows it (correct even when base carries a path
 * prefix, e.g. the dev proxy `<ngrok>/dev/files/<bucket>`). Otherwise fall back to the URL
 * path (production Spaces origin, where the bucket is the host and the path is exactly the key).
 */
export function spacesKeyForUrl(url: string, base = spacesPublicBase()): string {
    const withoutQuery = url.split("?")[0];
    const raw = isSpacesUrl(withoutQuery, base)
        ? withoutQuery.slice(base!.length)
        : new URL(withoutQuery).pathname;
    const key = decodeURIComponent(raw.replace(/^\/+/, ""));
    if (!key) {
        throw new Error(`Cannot derive an object key from URL: ${url}`);
    }
    return key;
}

/** Build the public URL for an object key — the inverse of `spacesKeyForUrl`. */
export function spacesUrlForKey(key: string, base = spacesPublicBase()): string {
    return `${base}/${key}`;
}
