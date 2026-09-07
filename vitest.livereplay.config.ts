import { defineConfig } from "vitest/config";

/** The recorded-live replay only: no network, no credentials, but it needs the
 *  bundle of real vendor responses, which holds transcript text and lives under
 *  ~/.cache/oc-public. */
export default defineConfig({
    test: {
        include: ["src/routes/openaiCompat.livereplay.test.ts"],
        testTimeout: 1_800_000,
        hookTimeout: 300_000,
        fileParallelism: false,
    },
});
