import { defineConfig } from "vitest/config";

/**
 * The live test only. It is excluded from the default suite because it spends
 * money and needs three vendor credentials; a single long timeout because a
 * cold RunPod worker plus two cloud vendors is minutes, not seconds.
 */
export default defineConfig({
    test: {
        include: ["src/routes/openaiCompat.live.test.ts"],
        testTimeout: 900_000,
        hookTimeout: 300_000,
        fileParallelism: false,
    },
});
