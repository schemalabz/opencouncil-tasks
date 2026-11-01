# Media inspection and downloads

The task server asks yt-dlp to resolve a URL rather than maintaining a list of supported
sites. A dedicated extractor or a known embedded player supplies the source identity;
a Generic direct file uses HTTP download. Spaces objects retain the existing storage path.
The URL supplied by the caller remains the download input, because replacing an embedding
page with its resolved video URL loses the referer that domain-restricted players require.

## Where inspection fits

The primary caller is an agent using OpenCouncil's MCP. Starting a task must work without
a separate inspection tool call:

```mermaid
sequenceDiagram
    participant Agent as Agent through MCP
    participant App as OpenCouncil server
    participant Tasks as Task server
    participant Site as Video source
    Agent->>App: start_task(type=transcribe, videoUrl)
    App->>Tasks: POST /transcribe with URL and callback
    Tasks-->>App: Task accepted or queued
    App-->>Agent: Task id and status
    Tasks->>Site: Resolve URL, then download
    Note over Tasks,Site: Refusals stop early; other failures may retry
    Tasks-->>App: Async success with source, or error with mediaFailure
    Agent->>App: get_meeting to check task status
    App-->>Agent: Status, source on success, mediaFailure on source errors
```

The agent does not get a synchronous video-validation verdict from `start_task`: acceptance
means queued/running, not downloadable. A permanent source refusal happens when the worker
runs its lookup, before uploads or transcription. The callback persists the failure; the
agent learns it on its next status read. Other failures may occupy the existing retry window.

The MCP `inspect_media(url)` tool supports source discovery before choosing a URL or creating
a meeting. It proxies the synchronous `/inspectMedia` endpoint with the app's server-held key.
It requires administrator access but does not require a meeting to exist. It is not a mandatory approval step or a prerequisite to
`start_task`, and successful inspection must not suppress the worker's later lookup.

Inspection is optional. Transcription performs its own lookup even if the app previously
inspected the URL: manifests, availability and duration can change after a live meeting.
The synchronous endpoint is not an asynchronous task and needs no task record or callback.
It can wait for an in-progress binary update. The lookup process has a timeout, but it is
not an end-to-end HTTP response deadline.

A successful inspection means metadata extraction succeeded. It is not a test of all media
fragments, the chosen download format, DRM discovered during transfer, or later availability.
Spaces inspection recognizes the URL without fetching the object. A source timestamp can
be its upload time or HTTP Last-Modified date; it must not automatically set a meeting date.

The OpenCouncil app already accepts HTTP(S) URLs and preserves the complete result JSON.
The companion OpenCouncil branch adds the synchronous inspection client and MCP tool, and
preserves source/error metadata through the existing callback and task-status projection.
The existing task submission (`src/lib/tasks/transcribeInternal.ts` and `src/lib/tasks/tasks.ts`
in the app) stays async. Media metadata is optional in the app contract so older callbacks,
tasks and replays remain readable. Automated discovery is separate: the livestream poller
still discovers YouTube videos. A UI preview could reuse the inspection client later.

### Agent-facing result and recovery

The task server wraps failures only while resolving/downloading media. Its terminal callback
keeps the existing error text and adds `mediaFailure` (reason, retryable, optional hint).
FFmpeg, ASR and other task failures retain their existing error shape; cancellation remains
cancellation. No database schema change is needed. Successful source metadata stays in the
existing result JSON in `responseBody`. A source failure stores a small, namespaced failure
envelope there while keeping `failureReason` as readable error text. The envelope is explicitly
not a successful result: replay, callback-claim and transcript-supersession guards distinguish it.

The status query projects only source/failure metadata out of the existing JSON in PostgreSQL.
It parses at most the bounded newest transcribe rows and does not transfer transcripts to the
app or MCP. This trades some database JSON parsing for avoiding additional columns.

MCP `get_meeting` exposes `mediaFailure` on failed transcribes and `source` on successful
ones, alongside the existing status/error fields. Error prose remains capped at 500 characters;
the structured hint remains available independently. Duplicate and late callbacks retain the
existing guarded-write behavior. These details stay behind existing task-admin access and
are removed from seed exports.

An agent can therefore:

- Start a transcribe directly and poll its accepted task with `get_meeting`.
- Use an `embed_only` hint to find the embedding page and submit that URL instead.
- Stop repeating a permanent refusal and find another recording or report the blocker.
- Use bounded retries or escalation for transient failures. `retryable` means the condition
  might clear later; it is neither permission for an endless loop nor a promise that the
  worker itself automatically retries that transport. A disconnected direct file may be
  recoverable even though only yt-dlp downloads enter the post-live retry loop.
- Inspect candidate URLs first when that avoids creating the wrong meeting or choosing the
  wrong recording. Inspection still does not prove full transfer or the meeting date.

### Rollout

There is no migration or backfill: the app schema remains identical to its main branch.
Deploy the task server endpoint before using the new app's inspection tool. Old callbacks
without metadata remain readable. Legacy result payloads remain replayable, while the new
source-failure envelope cannot be replayed as a transcript result. No deployment is applied
by this implementation work.

Direct transfers publish their cache file only after the stream finishes. Cache keys for
new extractors also distinguish tenant origins and original ids, since page-generated ids
such as `index-1` are not unique across councils. Mutable content at the same URL can still
reuse the cached recording; replacing that recording requires clearing its cache.

## What using yt-dlp means

Supporting yt-dlp's extractor registry is different from exposing every yt-dlp option.
The configured binary's `--list-extractors` and `--help` show its current registry and options.
The server uses its existing quality/container policy, proxy configuration, and post-live
completeness checks. Generic HTML5 players, HLS and DASH should work through extraction.
Authentication cookies, passwords, explicit referers, browser impersonation and provider
extractor arguments require deliberate configuration and matching lookup/download behavior.
They are not available as arbitrary request arguments. The plain HTTP file path does not
inherit yt-dlp cookie/config-file authentication or its proxy; a protected file can resolve
metadata through yt-dlp and still fail its plain transfer. A site needing those features can
fail even though yt-dlp has an extractor for it. A DRM refusal is a failure, not a retry.

Whole-channel/playlist downloads and joining multiple videos remain outside the meeting
pipeline's single-video contract. A watch URL containing a playlist parameter still names
one video; a channel URL must not select an arbitrary meeting.

## Repeating verification

The raw downloader is the same path `/transcribe` uses, stopping before normalization,
audio extraction, uploads, Mux or transcription:

```sh
nix develop --command npm run build
nix develop --command npm run cli -- inspect-media 'https://example.org/meeting'
nix develop --command npm run cli -- download-ytv 'https://example.org/meeting' --download-only
```

The integration matrix pins a private copy of yt-dlp and records its version, then generates real media and serves it locally, testing inspection,
download duration, file size, cache reuse, interrupted-transfer recovery, refusal cases and the synchronous route. Remote
cases use real public URLs; their availability is not a stable unit-test contract. Samples
longer than ten minutes are inspected but skipped for full transfer. Other downloads are complete, and temporary media is removed after recording the report:

```sh
nix develop --command npx tsx scripts/verify-media-sources.ts --output /tmp/media-local.json
nix develop --command npx tsx scripts/verify-media-sources.ts --update-race --output /tmp/media-update.json
nix develop --command npx tsx scripts/verify-media-sources.ts --callback-contract --output /tmp/media-callbacks.json
nix develop --command npx tsx scripts/verify-media-sources.ts \
  --app-root /path/to/opencouncil --output /tmp/media-app-bridge.json
nix develop --command npx tsx scripts/verify-media-sources.ts \
  --remote scripts/fixtures/media-sources.json --output /tmp/media-expanded.json
```

Add new real sources to the JSON fixture rather than writing another probe. An inspection-only
case proves extraction, not downloading; use `download: true` to exercise full transfer and
cache reuse. Use `--only html5,hls` to repeat selected cases. `--update-race` uses a
deterministic updater fixture to prove that inspection waits for a running update.
`--update-timeout` additionally tests a stuck updater that ignores SIGTERM (takes a minute).
`--callback-contract` checks actual local HTTP callbacks. `--app-root` also checks the paired
JSON fixture, the app's actual inspection client against the authenticated local route, and
MCP projection of the serialized failure/source. Database persistence is covered by the app's
integration tests. This matrix does not exercise paid transcription services or claim to validate
every upstream extractor. Use the existing full smoke test for the rest of the pipeline.

A downloader may update the yt-dlp binary at runtime. The server guards its own lookups and
downloads against an in-process update. Separate CLI/server processes sharing a mutable
binary still need operational coordination; the verification matrix avoids this by using a
private copy with `YTDLP_AUTO_UPDATE=false`.
