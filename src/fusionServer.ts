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
 *   - It sizes the HTTP timeouts from the fusion deadline. Node kills any
 *     request at five minutes by default, and a segment given a longer
 *     `FUSION_DEADLINE_MS` -- which the runbook recommends when our own
 *     endpoint is cold -- would be cut off by the HTTP layer while the engine
 *     was still working, after all three providers had been paid.
 *   - It refuses to start with the route off, because a fusion server with no
 *     fusion route is a process that answers health checks and nothing else.
 */
import express from "express";
import { loadFusionConfig } from "./lib/fusion/config.js";
import { getFusionRuntime } from "./lib/fusion/index.js";
import { assertFusionRuntimeUsable } from "./lib/fusion/preflight.js";
import { mountOpenAiCompatRoute } from "./routes/openaiCompat.js";

/** Headroom over the fusion's own deadline, for upload and response time. */
const HTTP_SLACK_MS = 120_000;

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

    // A 15-minute segment is a long request by design, and the caller is
    // expected to wait for it. Node's defaults are not.
    server.requestTimeout = config.deadlineMs + HTTP_SLACK_MS;
    server.headersTimeout = 120_000;
    server.keepAliveTimeout = 120_000;
    // No overall socket deadline: the request timeout is the one that should
    // decide, and it already knows what the fusion was promised.
    server.setTimeout(0);

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
