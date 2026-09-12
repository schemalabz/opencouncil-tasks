import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { fusionEngineRevision } from "./engineProcess.js";

/**
 * The revision is half the cache key, so what it hashes decides what
 * invalidates a fused result. It must be everything that can change the
 * output, and nothing that cannot.
 */
describe("fusionEngineRevision hashes what runs", () => {
    /** A repo root carrying a built engine and the frozen policy beside it. */
    function repoWith(engineFiles: Record<string, string>): string {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-rev-"));
        const engineDir = path.join(root, "dist/lib/fusion/engine");
        fs.mkdirSync(engineDir, { recursive: true });
        fs.mkdirSync(path.join(root, "fusion"), { recursive: true });
        fs.writeFileSync(path.join(root, "fusion/policy.json"), '{"policy":{}}');
        for (const [name, body] of Object.entries(engineFiles)) {
            fs.writeFileSync(path.join(engineDir, name), body);
        }
        return root;
    }

    const roots: string[] = [];
    const rev = (files: Record<string, string>) => {
        const root = repoWith(files);
        roots.push(root);
        // Memoization is keyed by repo root, so each call gets its own.
        return fusionEngineRevision(root);
    };
    afterEach(() => {
        while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
    });

    it("changes when the engine changes", () => {
        expect(rev({ "fuse.js": "a" })).not.toBe(rev({ "fuse.js": "b" }));
    });

    it("ignores the tests that sit beside the engine in the build output", () => {
        // `tsc` emits `src/**/*.test.ts` into the same directory, and the filter
        // was every `.js`. That made the production cache key depend on test
        // code: editing an assertion threw away every fused segment on disk,
        // each of which cost minutes of compute to produce.
        expect(rev({ "fuse.js": "a", "fuse.test.js": "one" }))
            .toBe(rev({ "fuse.js": "a", "fuse.test.js": "two" }));
    });

    it("ignores a test file appearing or disappearing", () => {
        expect(rev({ "fuse.js": "a" }))
            .toBe(rev({ "fuse.js": "a", "fuse.differential.test.js": "anything" }));
    });
});
