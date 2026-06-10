# Observability (Langfuse)

Every task run can be traced to [Langfuse](https://langfuse.com): one trace per run, with each LLM call recorded as a generation (prompts, output, token usage, cost) and the final task result stored as the trace output. This gives a persistent record of what every run produced — the foundation for comparing runs when experimenting with prompts or pipeline changes.

Tracing is **opt-in and zero-overhead when disabled**: without the env vars below, every instrumentation point is a no-op.

## Setup

Add to `.env`:

```
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_BASEURL=https://cloud.langfuse.com   # or a self-hosted instance
```

The server logs observability status at startup.

## What a traced run looks like

```
trace: summarize                          ← one per task run
├─ span: Phase 1: Batch Processing
│   └─ generation: batch-processing
├─ span: Phase 1.5: Subject Merge
│   └─ generation: subject-merge
├─ span: Phase 2: Speaker Contributions
│   ├─ generation: contributions:<subject name>
│   └─ ... (one per primary subject, parallel)
└─ span: Phase 3: Enrichment
    └─ generation: subject-context-search (per subject)
```

- **Trace input**: a summary of the request (scalar fields + array lengths — full transcripts are not logged).
- **Trace output**: the complete task result (e.g. `SummarizeResult`), plus `resultSizeBytes` in metadata.
- **Spans** group the generations of a pipeline phase, giving per-phase duration and cost rollups in the trace view. Tasks without explicit phases just attach generations directly to the trace.
- **Generations** record the full prompts, raw model output, resolved model, token usage (including cache read/write), and whether the Batch API was used.

## Tags

Traces are tagged for filtering in the UI and via the API:

| Tag | Example | Notes |
|---|---|---|
| `task:<type>` | `task:summarize` | |
| `meeting:<cityId/meetingId>` | `meeting:orestiada/feb11_2026` | derived from the callback URL |
| `city:<cityId>` | `city:orestiada` | |
| `version:<n>` | `version:5` | the task version from `registerTask()` |
| `env:<env>` | `env:production` | from `NODE_ENV` |
| `prompts:<hash>` | `prompts:3fa9c2e81b04` | composite fingerprint of all system prompts used |
| `status:error` | | only present on failed runs |

The `prompts:` tag distinguishes runs at the same task version that used edited prompts — each generation also carries its own `promptHash` in metadata. The trace `sessionId` is `<task>:<cityId/meetingId>`, so Langfuse's session view shows all runs of the same meeting chronologically.

## Instrumentation points

| Where | What |
|---|---|
| `src/lib/observability.ts` | All Langfuse logic: client, AsyncLocalStorage context, trace/span/generation helpers |
| `src/lib/TaskManager.ts` | Wraps task execution in `runWithTaskTrace()` |
| `src/lib/ai.ts` | `aiChat()` opens a generation per call; the optional `label` option names it |
| `src/tasks/summarize.ts` | Wraps each phase in `withPhaseSpan()` |

To instrument a new task's phases, wrap them with `withPhaseSpan('Phase name', () => ...)` and pass `label` to `aiChat()` calls. Nothing else is required — the trace is created by `TaskManager` for every task automatically.

## Notes

- Trace propagation uses `AsyncLocalStorage`, so `aiChat()` finds the active trace without parameter threading. Code paths that run outside a task (CLI commands, tests) simply produce no traces.
- Batch API calls (`batchFirst`) appear as a single generation spanning submission to result retrieval; `metadata.batchMode` marks them.
- The `max_tokens` continuation path produces an additional generation per continuation, labeled `<label>:continuation`.
- Traces are flushed at the end of each task run; a flush failure is logged but never fails the task.
