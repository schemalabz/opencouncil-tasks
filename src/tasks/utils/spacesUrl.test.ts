import { describe, it, expect, afterEach } from "vitest";
import { isSpacesUrl, spacesKeyForUrl, spacesPublicBase, spacesUrlForKey } from "./spacesUrl.js";

// Except for the spacesPublicBase block, every case injects `base` explicitly, so behavior
// does not depend on process.env.

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

    it("throws when base is not configured", () => {
        expect(() => spacesKeyForUrl(`${ORIGIN}/uploads/a.mp4`, undefined)).toThrow(/refusing/);
    });

    it("throws for a foreign URL rather than guessing a key in our bucket", () => {
        // Guessing "uploads/a.mp4" here would let a URL we do not own address one of our
        // objects — and overwriteSpacesObject writes to whatever key it is handed.
        expect(() => spacesKeyForUrl("https://someone-else.com/uploads/a.mp4", ORIGIN)).toThrow(/refusing/);
    });

    it("throws for a string-prefix sibling bucket (path boundary)", () => {
        const base = "https://x.app/dev/files/bucket";
        // A buggy string-slice would yield the key "2/uploads/a.mp4" in the wrong bucket.
        expect(() => spacesKeyForUrl("https://x.app/dev/files/bucket2/uploads/a.mp4", base)).toThrow(/refusing/);
    });

    it("throws when the URL resolves to an empty key", () => {
        expect(() => spacesKeyForUrl(`${ORIGIN}/`, ORIGIN)).toThrow();
    });
});

describe("spacesPublicBase", () => {
    const saved = { ...process.env };
    afterEach(() => {
        process.env = { ...saved };
    });

    it("derives the virtual-hosted origin from bucket + endpoint", () => {
        process.env.DO_SPACES_BUCKET = "townhalls-gr";
        process.env.DO_SPACES_ENDPOINT = "https://fra1.digitaloceanspaces.com";
        expect(spacesPublicBase()).toBe(ORIGIN);
    });

    it("derives the dev proxy base from PUBLIC_URL when the endpoint is MinIO", () => {
        // MinIO is not publicly reachable, so objects are addressed through this app.
        process.env.DO_SPACES_BUCKET = "opencouncil-dev";
        process.env.DO_SPACES_ENDPOINT = "http://localhost:9100";
        process.env.PUBLIC_URL = "https://abc123.ngrok.app";
        expect(spacesPublicBase()).toBe(DEV_PROXY);
    });

    it("is undefined when the bucket or endpoint is not configured", () => {
        delete process.env.DO_SPACES_BUCKET;
        process.env.DO_SPACES_ENDPOINT = "https://fra1.digitaloceanspaces.com";
        expect(spacesPublicBase()).toBeUndefined();
    });
});

describe("spacesUrlForKey", () => {
    it("builds `${base}/${key}`", () => {
        expect(spacesUrlForKey("uploads/a.mp4", ORIGIN)).toBe(`${ORIGIN}/uploads/a.mp4`);
    });

    it("throws rather than emitting an `undefined/...` URL when unconfigured", () => {
        expect(() => spacesUrlForKey("uploads/a.mp4", undefined)).toThrow(/DO_SPACES_BUCKET/);
    });

    it("round-trips with spacesKeyForUrl (build then parse returns the key)", () => {
        const key = "uploads/vrilissia_jul22.mp4";
        expect(spacesKeyForUrl(spacesUrlForKey(key, DEV_PROXY), DEV_PROXY)).toBe(key);
    });
});
