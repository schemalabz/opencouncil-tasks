# Observability (Langfuse)

Every task run is one telemetry run: each LLM call becomes a call record, and the records go to the sinks `TELEMETRY_SINKS` names (default `archive,langfuse,posthog`), each a no-op without its credentials. The archive (`ARCHIVE_URL`) is the record of truth, read by the `runs` and `eval` commands; see [evals.md](./evals.md). This page covers the Langfuse sink.

## Setup

Add to `.env`:

```
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_BASEURL=https://cloud.langfuse.com   # or a self-hosted instance
LANGFUSE_TRACING_ENVIRONMENT=production        # or staging
```

A run's environment is `production` or `staging` when `LANGFUSE_TRACING_ENVIRONMENT` (else `NODE_ENV`) says so, `eval` for eval runs, and `development` otherwise. It is set on every span of the run, so Langfuse's environment selector keeps them apart.

At startup the server logs the active sinks, the archive, and whether Langfuse is enabled.

## What a traced run looks like

```
trace: summarize                          ← one per task run, under the run's trace id
├─ span: Phase 1: Batch Processing
│   └─ generation: batch-processing
├─ span: Phase 2: Speaker Contributions
│   ├─ generation: contributions:<subject name>
│   └─ ... (one per primary subject)
└─ span: Phase 3: Enrichment
    └─ generation: subject-context-search (per subject)
```

- A run reaches Langfuse once it ends, as a back-dated trace whose id is the run's own trace id (the same in the archive and in PostHog). A run that never ends (the process is killed) is not traced.
- **Trace input**: a summary of the request (scalar fields and array lengths). **Trace output**: the task result, or a summary of it above 800 KB.
- **Generations**: the system prompt and the messages (documents shown as `[pdf <hash> <bytes>]`), the output text, model and parameters, token usage and cost. Metadata carries `cacheKey`, `promptHash`, `stopReason`, `batchMode`, `promoted`, `cacheHit` and `replayed`. A failed call, a refusal or a context-window stop included, is marked `ERROR`.
- A call served from a recording or the response store costs nothing and is marked `cacheHit`.

## Tags

| Tag | Example | Notes |
|---|---|---|
| `task:<type>` | `task:summarize` | |
| `version:<n>` | `version:7` | the task version in `src/tasks/registry.ts` |
| `meeting:<cityId/meetingId>` | `meeting:orestiada/feb11_2026` | derived from the callback URL |
| `city:<cityId>` | `city:orestiada` | |
| `status:<status>` | `status:error`, `status:cancelled` | only on runs that did not succeed |
| `env:eval`, `eval-run:<runId>` | | only on eval runs |

The trace `sessionId` is `<task>:<cityId/meetingId>`, so Langfuse's session view lists the runs of one meeting.

After a successful production run, each monitored failure-mode check adds a BOOLEAN score, named by the mode's slug, to the trace (see [Monitoring](./evals.md#monitoring)).

## Instrumentation points

| Where | What |
|---|---|
| `src/lib/TaskManager.ts` | Runs every task inside `runWithTaskTrace()` |
| `src/lib/ai.ts` | `aiChat()` emits one call record per call; its `label` option names the generation |
| `src/tasks/*.ts` | `withPhaseSpan('Phase name', () => ...)` groups a phase's calls |

## Commands

```bash
npm run cli -- observability-check                       # one small call through TaskManager, traced under tag task:observability-check
npm run cli -- eval telemetry verify <traceId>           # every archived call of a run reached Langfuse and PostHog
npm run cli -- eval archive import-langfuse --since 30   # copy Langfuse traces into the archive
```

The `runs list | show | call | compare` commands read the archive, not Langfuse. `runs compare` matches subjects by agenda section and item, then by name, and writes a JSON comparison and an HTML diff to `data/comparisons/`; each subject is `identical`, `cosmetic` (rewording: same speakers, similar sizes) or `structural` (a behavioural difference worth reading).

## Notes

- The run is carried by `AsyncLocalStorage`, so `aiChat()` finds it without parameter threading. Calls made outside a run (CLI commands) are archived as ad-hoc calls and are not traced.
- The `max_tokens` continuation path adds a generation per continuation, labelled `<label>:continuation`.
- Sinks are flushed at the end of each run, each within 10 seconds; a sink failure is logged and never fails the task.
