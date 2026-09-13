import express from "express";
import path from "path";
import { createAuthMiddleware } from "/home/harold/projects/opencouncil/opencouncil-tasks/dist/lib/auth.js";
import { createFusionRuntime } from "/home/harold/projects/opencouncil/opencouncil-tasks/dist/lib/fusion/index.js";
import { loadFusionConfig } from "/home/harold/projects/opencouncil/opencouncil-tasks/dist/lib/fusion/config.js";
import { mountOpenAiCompatRoute } from "/home/harold/projects/opencouncil/opencouncil-tasks/dist/routes/openaiCompat.js";

const REPO = "/home/harold/projects/opencouncil/opencouncil-tasks";
const TOKEN = process.env.BENCH_PROVIDER_TOKEN;
const PORT = Number(process.env.PORT || 8787);
if (!TOKEN) { console.error("BENCH_PROVIDER_TOKEN unset"); process.exit(1); }

const rt = createFusionRuntime(loadFusionConfig({
  FUSION_MODE: "on",
  FUSION_OPENAI_ROUTE: "on",
  FUSION_AUDIO_TRANSPORT: "bytes",
  // Persistent on purpose: a timed-out first pass must leave the vendor
  // answers on disk so the benchmark's retry is a cache hit, not a second bill.
  FUSION_CACHE_DIR: "/home/harold/.cache/oc-public/fusion-bench-cache",
  FUSION_TRACE_DIR: "/home/harold/.cache/oc-public/fusion-bench-traces",
  FUSION_DEADLINE_MS: "900000",
}, REPO));

const app = express();
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.use(createAuthMiddleware({ skipAuth: false, publicPaths: ["/healthz"], tokens: [TOKEN], additionalPublicPaths: ["/healthz"] }));

// `/slowtest` lived here, unauthenticated, and held a request open for up to 600
// seconds on request. It answered its question -- the "~100 s benchmark limit"
// was Cloudflare's 524 origin timeout, and a 130 s request returns 524 through
// Cloudflare and 200 through Tailscale -- and then stayed behind a public
// tunnel, where anyone could hold ten-minute connections open on a home line.
// Removed rather than authenticated: it has no use left. Restore from git if the
// timeout question ever reopens, and put it behind the token that time.
mountOpenAiCompatRoute(app, rt);
app.listen(PORT, "127.0.0.1", () => console.log(`fusion route on 127.0.0.1:${PORT}`));
