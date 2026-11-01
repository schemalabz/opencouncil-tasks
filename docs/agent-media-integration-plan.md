# Agent media integration implementation plan

Goal: agents can inspect candidate media, start transcribes directly, and recover from failures
using structured MCP status fields instead of interpreting truncated error prose.

Architecture: extend the existing task callback and TaskStatus/MCP summary paths. Keep
inspection synchronous and optional, and keep old callbacks/results readable.

## Existing paths and new seams

- Existing task-server media classifier: add a typed media download error around the raw
  downloader only. Existing TaskManager callback: preserve error text and add mediaFailure.
- Existing app apiTypes contract: add optional media fields and inspection request/response.
- Existing app TaskStatus persistence: no new columns. Keep successful source metadata in
  responseBody; encode source failures as a namespaced response envelope, distinct from a
  replayable successful result. Keep failureReason readable. Update all replay/claim readers.
- Existing app callback handler: persist narrow media fields with the existing guarded claim.
- Existing meeting task projection and MCP taskSummary: extract narrow JSON metadata in a
  bounded PostgreSQL query without transferring transcript bodies. Older tasks omit metadata.
- New synchronous task inspection client: nothing currently does this; reuse task API
  configuration and authorization gates. No task record, callback, upload or DB mutation.
- Existing MCP admin tool registration: add inspect_media; leave start_task unchanged.
- Existing add-city/agent instructions: inspection for candidate selection; poll direct
  starts; no unbounded retry or automatic meeting-date inference from metadata.

## Verifiable slices

1. Task-server contract. Done when: typed download failures reach the terminal callback with
   reason/retryable/hint and original error text; ordinary/cancelled tasks retain old shape.
2. App persistence/status. Done when: callback integration tests save a source failure and
   get_meeting exposes it, successful source metadata is exposed, schema/migrations are
   unchanged, and legacy/replay/duplicate callbacks retain their behavior.
3. MCP inspection. Done when: an authorized in-memory MCP client calls inspect_media and
   gets the synchronous answer; unauthorized/invalid URL calls make no task API request;
   start_task still submits without preflight and creates no extra task record.
4. Compatibility verification. Done when: paired contract fixtures agree, both repos pass
   relevant tests/typechecks/builds, and local cross-service checks cover supported and
   unsupported URLs without uploads, paid services or deployed changes.

No push, PR, release or deployment without the user's approval. App work happens in a
separate worktree on codex/agent-media-sources; the task-server feature stays on its branch.


## Verification record

The initial paired implementation passed 1,648 task-server tests, 244 focused app unit tests,
31 integration tests, both TypeScript checks/builds, and the real local HTTP bridge. Review
fixes removed credentials from producer/app metadata and error prose and protected seed data.

The user subsequently requested no migrations. The dedicated-column approach was removed
before deployment: the app now reuses existing response JSON and explicitly guards failure
envelopes from replay. Its schema and migrations match origin/main exactly.

The migration-free revision passed 262 focused app unit/component tests and 37 integration
tests, Jest-scope TypeScript, and the final app build. Tests cover late success, duplicate
failures/progress, replay/UI guards, transcript supersession, legacy and malformed bodies,
and bounded metadata projection. JSONB-incompatible NUL and unpaired-surrogate fixtures are
safely skipped using PostgreSQL input validation before casts. The real paired HTTP bridge
and the unchanged task server's 1,648 tests also passed. Disposable PostgreSQL was stopped.

No production DB access, push, PR, release, or deployment. The task server endpoint must be
available before using the app's new inspect_media tool; no database migration is required.
