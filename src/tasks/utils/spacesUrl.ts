import { isUsingMinIO } from "../../utils.js";

/**
 * Single source of truth for the relationship between a public file URL and our Spaces
 * storage. `uploadToSpaces` builds URLs as `${base}/${key}`, so classification ("is this URL
 * ours?") and key extraction are exact inverses of that construction — they live together
 * here so the boundary logic is defined once and cannot drift between callers.
 *
 * `base` is an explicit parameter on every function so callers/tests can inject it rather
 * than depend on ambient process.env.
 */

/**
 * The public base URL of our own objects, derived from the same variables that configure the
 * S3 client so there is no separate URL to configure — or to get wrong.
 *
 * Production: Spaces serves virtual-hosted URLs, `https://<bucket>.<endpoint-host>/<key>`.
 * Development: MinIO is not publicly reachable, so objects are served through this app's
 * `/dev/files/:bucket/*` proxy, which external services (Pyannote) reach via PUBLIC_URL.
 *
 * These are origin URLs, never the CDN edge: we hand them to services that fetch an object
 * once (Pyannote, Scribe, Mux) and to `overwriteSpacesObject`, where an edge cache could
 * serve a stale copy of an object we just replaced. Consumers that serve files to browsers
 * build their own CDN URLs from the object key.
 */
export function spacesPublicBase(): string | undefined {
    const bucket = process.env.DO_SPACES_BUCKET;
    const endpoint = process.env.DO_SPACES_ENDPOINT;
    if (!bucket || !endpoint) return undefined;

    if (isUsingMinIO()) {
        const appBase = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;
        return `${appBase.replace(/\/+$/, "")}/dev/files/${bucket}`;
    }
    return `https://${bucket}.${new URL(endpoint).host}`;
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
 * Extract the S3 object key from a public URL — the inverse of `${base}/${key}`. The key is
 * whatever follows the base (correct even when base carries a path prefix, e.g. the dev proxy
 * `<ngrok>/dev/files/<bucket>`).
 *
 * A URL that is not under our base has no key here, so this throws rather than guessing one
 * from the URL path: callers write to the key they get back, and guessing would let a foreign
 * URL address — and overwrite — an unrelated object in our own bucket.
 */
export function spacesKeyForUrl(url: string, base = spacesPublicBase()): string {
    const withoutQuery = url.split("?")[0];
    if (!isSpacesUrl(withoutQuery, base)) {
        throw new Error(`Not a URL under our Spaces base, refusing to derive an object key: ${url}`);
    }
    const key = decodeURIComponent(withoutQuery.slice(base!.length).replace(/^\/+/, ""));
    if (!key) {
        throw new Error(`Cannot derive an object key from URL: ${url}`);
    }
    return key;
}

/**
 * Build the public URL for an object key — the inverse of `spacesKeyForUrl`. Throws rather
 * than emitting an `undefined/...` URL, which would otherwise be stored by consumers and only
 * surface as a broken link much later.
 */
export function spacesUrlForKey(key: string, base = spacesPublicBase()): string {
    if (!base) {
        throw new Error("Cannot build a Spaces URL: DO_SPACES_BUCKET and DO_SPACES_ENDPOINT must be set");
    }
    return `${base}/${key}`;
}
