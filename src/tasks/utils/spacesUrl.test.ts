import { describe, it, expect } from "vitest";
import { isSpacesUrl, spacesKeyForUrl, spacesUrlForKey } from "./spacesUrl.js";

// Every case injects `base` explicitly, so behavior does not depend on process.env.

const ORIGIN = "https://townhalls-gr.fra1.digitaloceanspaces.com";
const DEV_PROXY = "https://abc123.ngrok.app/dev/files/opencouncil-dev";

describe("isSpacesUrl", () => {
    it("matches a URL under the origin base", () => {
        expect(isSpacesUrl(`${ORIGIN}/uploads/a.mp4`, ORIGIN)).toBe(true);
    });

    it("matches a URL under a path-prefixed (dev proxy) base", () => {
        expect(isSpacesUrl(`${DEV_PROXY}/uploads/a.mp4`, DEV_PROXY)).toBe(true);
    });

    it("rejects a same-string-prefix but different host (path boundary)", () => {
        expect(isSpacesUrl(`${ORIGIN}.evil.com/uploads/a.mp4`, ORIGIN)).toBe(false);
    });

    it("rejects a sibling bucket that is a string superset (path boundary)", () => {
        const base = "https://x.app/dev/files/bucket";
        expect(isSpacesUrl("https://x.app/dev/files/bucket2/uploads/a.mp4", base)).toBe(false);
    });

    it("is false when no base is configured", () => {
        expect(isSpacesUrl(`${ORIGIN}/uploads/a.mp4`, undefined)).toBe(false);
    });
});

describe("spacesKeyForUrl", () => {
    it("origin base → key is the path under the base", () => {
        expect(spacesKeyForUrl(`${ORIGIN}/uploads/vrilissia.mp4`, ORIGIN)).toBe("uploads/vrilissia.mp4");
    });

    it("path-prefixed base → strips the prefix to the real key", () => {
        expect(spacesKeyForUrl(`${DEV_PROXY}/uploads/vrilissia.mp4`, DEV_PROXY)).toBe("uploads/vrilissia.mp4");
    });

    it("strips a query string", () => {
        expect(spacesKeyForUrl(`${ORIGIN}/uploads/a.mp4?X-Amz-Signature=xyz`, ORIGIN)).toBe("uploads/a.mp4");
    });

    it("percent-decodes the key", () => {
        expect(spacesKeyForUrl(`${ORIGIN}/uploads/my%20file.mp4`, ORIGIN)).toBe("uploads/my file.mp4");
    });

    it("falls back to the URL path when base is not configured", () => {
        expect(spacesKeyForUrl(`${ORIGIN}/uploads/a.mp4`, undefined)).toBe("uploads/a.mp4");
    });

    it("falls back to the URL path when base is not a prefix of the URL", () => {
        // A mismatched-env footgun: the configured base differs from the URL's host.
        expect(spacesKeyForUrl(`${ORIGIN}/uploads/a.mp4`, "https://other.example.com")).toBe("uploads/a.mp4");
    });

    it("does NOT slice a string-prefix sibling bucket (path boundary)", () => {
        const base = "https://x.app/dev/files/bucket";
        // Buggy string-slice would yield "2/uploads/a.mp4"; boundary-aware falls back to the path.
        expect(spacesKeyForUrl("https://x.app/dev/files/bucket2/uploads/a.mp4", base)).toBe(
            "dev/files/bucket2/uploads/a.mp4",
        );
    });

    it("throws when the URL resolves to an empty key", () => {
        expect(() => spacesKeyForUrl(`${ORIGIN}/`, ORIGIN)).toThrow();
    });
});

describe("spacesUrlForKey", () => {
    it("builds `${base}/${key}`", () => {
        expect(spacesUrlForKey("uploads/a.mp4", ORIGIN)).toBe(`${ORIGIN}/uploads/a.mp4`);
    });

    it("round-trips with spacesKeyForUrl (build then parse returns the key)", () => {
        const key = "uploads/vrilissia_jul22.mp4";
        expect(spacesKeyForUrl(spacesUrlForKey(key, DEV_PROXY), DEV_PROXY)).toBe(key);
    });
});
