/**
 * The fusion engine on its own port, speaking the OpenAI transcription API.
 *
 *   node dist/fusionServer.js
 *
 * Same image, same code, different entrypoint. It mounts the route the task
 * runner already exposes behind `FUSION_OPENAI_ROUTE=on` and nothing else: no
 * task manager, no queues, no callbacks. That makes the fusion usable from
 * outside as an ordinary transcription provider -- anything that can talk to
 * OpenAI can talk to this -- without a second build, a second engine, or a
 * second copy of the frozen policy to drift.
 *
 * Two things it does that the shared server does not:
 *
 *   - It raises the upload clock. Node gives a client five minutes to finish
 *     sending a request, and 200 MB of audio over a 5 Mbps link needs 336
 *     seconds. A municipality uploading a meeting from an office connection
 *     would lose the upload before the fusion ever started.
 *   - It refuses to start with the route off, because a fusion server with no
 *     fusion route is a process that answers health checks and nothing else.
 */
import express from "express";
import { loadFusionConfig } from "./lib/fusion/config.js";
import { getFusionRuntime } from "./lib/fusion/index.js";
import { assertFusionRuntimeUsable } from "./lib/fusion/preflight.js";
import { mountOpenAiCompatRoute } from "./routes/openaiCompat.js";

/**
 * How long a client has to finish sending a request.
 *
 * This bounds the UPLOAD, not the work. Node's `server.timeout` is 0 by
 * default, so processing time is already unbounded and nothing here changes
 * that; `requestTimeout` is the clock on receiving the bytes, which was
 * measured rather than assumed.
 *
 * The cap on an audio upload is 200 MB. At 5 Mbps that takes 336 seconds and
 * the 300-second default cuts it off mid-upload; at 2 Mbps, fourteen minutes.
 * A municipality uploading a meeting from an office connection is exactly the
 * case that loses. The figure below is 200 MB at 1 Mbps, which is the slowest
 * link worth serving, plus a minute.
 *
 * It is deliberately not derived from FUSION_DEADLINE_MS: how long the fusion
 * is allowed to think has nothing to do with how long the file takes to arrive.
 */
const UPLOAD_TIMEOUT_MS = 30 * 60_000;

export async function main(): Promise<void> {
    const config = loadFusionConfig();

    if (config.mode === "off") {
        throw new Error(
            "FUSION_MODE is off, so this server would answer every request with "
            + "a fallback. Set FUSION_MODE=on to serve the fusion.");
    }
    if (config.openaiRoute !== "on") {
        throw new Error(
            "FUSION_OPENAI_ROUTE is off, so there would be no route to serve. "
            + "Set FUSION_OPENAI_ROUTE=on.");
    }

    // The same check the task runner runs: with fusion enabled and an engine
    // that cannot run, every segment pays three providers and returns a
    // fallback that looks normal. Failing to start is the cheap failure.
    await assertFusionRuntimeUsable(config);

    // Imported here rather than at the top: the auth module builds its
    // middleware on load and throws without credentials, and the checks above
    // should be able to fail without a secret in the environment.
    const { createAuthMiddleware } = await import("./lib/auth.js");

    const app = express();
    app.get("/health", (_req, res) => {
        res.json({ ok: true, mode: config.mode, engine: getFusionRuntime().config.engine });
    });
    app.use(createAuthMiddleware());
    mountOpenAiCompatRoute(app);

    const port = Number(process.env.PORT || 3100);
    const server = app.listen(port, () => {
        console.log(`🔀 Fusion server on :${port} — POST /v1/audio/transcriptions`);
        console.log(`   mode=${config.mode} deadline=${config.deadlineMs}ms`);
    });

    // Only the upload clock is raised. Processing is unbounded by default and
    // is left that way on purpose: a fused segment takes as long as it takes,
    // and the fusion's own deadline is what stops it, not the HTTP layer.
    server.requestTimeout = UPLOAD_TIMEOUT_MS;

    const stop = (signal: string) => {
        console.log(`${signal}: draining`);
        server.close(() => process.exit(0));
    };
    process.on("SIGTERM", () => stop("SIGTERM"));
    process.on("SIGINT", () => stop("SIGINT"));
}

const invokedDirectly = process.argv[1]?.endsWith("fusionServer.js");
if (invokedDirectly) {
    main().catch((error) => {
        console.error(`fusion server failed to start: ${error instanceof Error ? error.message : error}`);
        process.exit(1);
    });
}
