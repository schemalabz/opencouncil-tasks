# Paired media preview validation

This CLI checks deployed task HTTP routes and app MCP tools without importing app code or discovering service secret files. The paired previews were exercised on 2026-11-01; the deployed evidence is recorded below. The local self-test alone never counts as deployed coverage.

Use only `https://pr-N.tasks.opencouncil.dev` and `https://pr-N.opencouncil.dev` origins. Redirects are refused, including redirects to production. The operator must pair the app's runtime `TASK_API_URL` and `TASK_API_KEY` with the chosen tasks preview and ensure `NEXTAUTH_URL` points back to the app preview. Matching inspection results alone do not prove which upstream the app called.

## Credentials and identity

An explicit `--credentials-file /private/path.json` may supply operator-approved `tasksToken` and `mcpToken` values; the file must have mode 600. Otherwise supply `PREVIEW_TASK_TOKEN` and `PREVIEW_MCP_TOKEN` through the approved environment injection mechanism, without putting values in command arguments or shell history. Both are required even for inspection-only runs; there is no unauthenticated-only mode. `PREVIEW_APP_COOKIE` optionally adds the app Cookie header. A cookie does not establish MCP identity: the route verifies a personal `mcp_…` bearer token and registers admin tools according to that account's current rights. `/api/mcp` is used directly to avoid the public `/mcp` preview proxy basic-auth path.

Prefer the app's existing seed/test-user tooling for a disposable preview account rather than direct SQL. `prisma/seed.ts` delegates to `ensureTestUsers`; see the app's `docs/database-seeding.md` and `scripts/seed/cli.ts` for the deployed revision's supported setup. Seeding a test user is **not** issuing an MCP token: create a personal MCP token through that preview account's MCP settings and grant appropriate preview city/body administration. This script does not seed users, alter permissions, or mint tokens. An existing approved admin token also works. Discovery fails explicitly if `inspect_media`, `start_task`, or `get_meeting` is absent, or if an opted-in creation/upload tool is missing. Reports list tool names only.

Do not print credentials to inspect their presence. The verifier redacts known environment secrets and URL credentials/queries in reports, does not print tool response bodies on errors, and does not discover or read service `.env` files. Keep raw shell tracing disabled. Nix can print its shell banner; use `--output` for a clean JSON artifact rather than redirecting all shell stdout.

## Inspection and discovery first

From the task-server worktree, with approved credentials already injected:

```bash
nix develop --command npx tsx scripts/verify-media-preview.ts \
  --tasks-url https://pr-121.tasks.opencouncil.dev \
  --app-url https://pr-952.opencouncil.dev \
  --only kextv-page,vimeo-event-embed-only,krakow-file \
  --output /tmp/media-preview-inspection.json
```

Omit `--only` to inspect the entire existing real-URL matrix in `scripts/fixtures/media-sources.json`. Its `download` fields are ignored. Inspection resolves metadata, including bounded direct-file probing; it does not download a full recording or start paid tasks. External metadata requests can still be slow. Calls run sequentially to avoid overload; the default per-request timeout is 180 seconds.

Use `--matrix /tmp/cases.json` for stable expectations:

```json
[
  {"name":"speech-fixture","url":"https://your-public-fixture.example/speech.mp4","supported":true,"kind":"file"},
  {"name":"malformed-youtube","url":"https://www.youtube.com/watch?v=bad","supported":false,"reason":"unsupported"}
]
```

The built-in matrix is observational: a correctly structured refusal passes unless an expectation is specified. This avoids claiming a third-party site must be available forever. Both direct and app inspections must agree on support and source kind, or refusal reason/retryability. Passing inspection never proves every fragment is downloadable, or that DRM is absent.

Done when: run the command and see passed task auth/invalid-input gates, MCP initialize/list/call gates, and paired inspection checks. The task callback check is explicitly skipped. JSON includes per-check statuses/timings, overall status, failure gates, and unexercised flows. Exit 0 means all attempted checks passed, 1 means a gate failed. Setup failures return a JSON error. Skipped flows do not count as verified.

## Real failure callback without inspecting the failing URL first

Use `--create-test-meeting CITY` to create a fresh **disposable, unreleased** meeting through MCP `create_meeting` (`mcpCreateMeeting`), with the current ISO date/time and `processAgenda: false`. Its existing service generates a unique meeting ID; no manual record setup is needed. Creation verifies `released=false` and immediately writes the accepted city/meeting ID to stderr and `--output` as an in-progress checkpoint before any further API call. Creation is never retried automatically. The existing meeting service also runs calendar sync and can send its normal admin alert; this verifier calls no release or subscriber-notification action.

Alternatively, designate an existing fresh meeting with `--test-meeting CITY/MEETING`. The two meeting flags are mutually exclusive. `--test-meeting` is the operator's explicit designation of that test record; `get_meeting` does not expose the release flag, so the tool cannot independently prove it is a draft. A meeting is created only with the explicit creation flag; none is released. Use a different empty meeting for every task attempt; the script refuses any meeting with an existing task or transcript and never passes `force`.

```bash
nix develop --command npx tsx scripts/verify-media-preview.ts \
  --tasks-url https://pr-121.tasks.opencouncil.dev \
  --app-url https://pr-952.opencouncil.dev \
  --only krakow-file \
  --create-test-meeting athens \
  --run-failure-task \
  --output /tmp/media-preview-failure.json
```

This mode calls MCP `start_task` with `transcribe` and a malformed YouTube ID, intentionally bypassing media inspection **for that failing task input**. Auth, discovery and the selected inspection cases still run first. It exercises the real task dispatch and callback persistence path, expecting `get_meeting` to report that same task ID as failed with `mediaFailure.reason=unsupported` and `retryable=false`. It is not callback simulation and should fail before paid transcription. If the app rejects dispatch before a task is created, the gate fails; that does not prove callback handling.

Done when: the callback gate passes with a terminal failed task ID and structured failure. This mode does not inspect raw callback versions because MCP omits them; the callback-guard check below separately verifies persisted version 6.

## Actual short speech success

Host a short public speech fixture first, ideally 5–20 seconds of clear speech. A local file path is not reachable by the preview. Existing long external examples such as `krakow-file` are inspection cases, not short pipeline fixtures. The optional `--upload-fixture FILE` uploads an existing local MP4, MOV or MP3 with MCP `create_upload_url`, using `kind: recording`, a unique lowercase date-based identifier, the matching format, and its exact byte count. It verifies the matching MIME type and preview-only bucket before upload. For MP3, it also verifies that the processed stored recording remains audio-only MP3 with `audio/mpeg`. It accepts only a single-part PUT plan (`completion: null`), sends the returned headers, then uses `publicUrl` as the pipeline input. It never reports signed URLs, storage keys or upload headers. Local fixtures must be nonempty and at most 32 MiB. No media is generated by the verifier. An `espeak` speech WAV muxed with a static video via Nix-provided ffmpeg is a suitable fixture preparation option, if espeak is available in your environment; publishing that file is explicitly authorized by `--upload-fixture`.

```bash
nix develop --command npx tsx scripts/verify-media-preview.ts \
  --tasks-url https://pr-121.tasks.opencouncil.dev \
  --app-url https://pr-952.opencouncil.dev \
  --only krakow-file \
  --create-test-meeting athens \
  --run-pipeline --upload-fixture /tmp/media-preview-fixtures/speech.mp4 \
  --max-duration 60 --wait-ms 900000 \
  --output /tmp/media-preview-success.json
```

Only `--run-pipeline` authorizes the success task. `--upload-fixture` requires it and is mutually exclusive with `--video-url` and `--fixture-file`. For an already hosted fixture, use `--run-pipeline --video-url URL --fixture-file /tmp/media-preview-fixtures/speech.mp4` instead. The direct example is `https://pr-121.tasks.opencouncil.dev/media-test-fixtures/speech.mp4`; its HTML5 wrapper is `/media-test-fixtures/player.html`. Supply the media URL when comparing local bytes, not the HTML wrapper.

Local fixtures are checked with actual local `ffprobe` (30-second timeout), then the public response bytes must exactly match the local bytes, with reads bounded to that local byte count. This also verifies a completed upload is publicly readable. A local positive finite duration at or below the configured ceiling (default 60 seconds, hard maximum 120) can fill missing file/Spaces duration metadata. Known excessive remote duration is still refused. No numeric duration override is accepted. Without a verified local copy, inspection must provide the positive bounded duration. `--fixture-file` requires both `--run-pipeline` and `--video-url`. Duration metadata is a guard, not an absolute billing limit. Credentials and services must permit download, ffmpeg, Spaces upload, Pyannote diarization/callback and Scribe transcription. The transcribe completion can automatically start `fixTranscript`, which may spend more; its completion is not awaited. The app stores this `videoUrl` on the test meeting.

Done when: the exact accepted task ID becomes `succeeded` through `get_meeting`, `hasTranscript=true`, and the MCP task status omits `source`. Source metadata remains available from `inspect_media` and the saved success payload; status polling does not expose it. This gate proves transcript persistence; it does not read the saved source payload or prove real Mux delivery. In `src/lib/mux.ts`, absent `MUX_TOKEN_ID` **or** `MUX_TOKEN_SECRET` deliberately produces `MOCK` IDs; the pipeline can pass with real Mux hosting untested. Playback verification requires real credentials and a separate check.

An accepted task ID is checkpointed to `--output` and emitted to stderr immediately and retained in the final JSON. A timeout or interrupt does not cancel remote work. Poll `get_meeting` for that ID before considering another run; the verifier never retries `start_task`. Failed preflight gates block all task submission.

## Read-only status checks on existing drafts

After deploying the simplified app preview, reuse the designated drafts without either task flag:

```bash
nix develop --command npx tsx scripts/verify-media-preview.ts \
  --tasks-url https://pr-121.tasks.opencouncil.dev --app-url https://pr-952.opencouncil.dev \
  --credentials-file /tmp/private-preview-credentials.json \
  --test-meeting athens/nov1_2026 --only youtube --output /tmp/media-existing-success.json
nix develop --command npx tsx scripts/verify-media-preview.ts \
  --tasks-url https://pr-121.tasks.opencouncil.dev --app-url https://pr-952.opencouncil.dev \
  --credentials-file /tmp/private-preview-credentials.json \
  --test-meeting athens/nov1_2026_2 --only youtube --output /tmp/media-existing-failure.json
```

These commands read existing status and perform inspection/auth gates; they create no meeting,
upload or task and run no paid transcription. `mcp.get_meeting` asserts every task omits
`source`, and any succeeded transcribe requires `hasTranscript=true`. Its report retains the
returned task/error/`mediaFailure` details (subject to credential and URL redaction), so the
failure draft's reason, retryability and hint remain reviewable. Legacy failures may omit
`mediaFailure`; read-only mode does not assume all failed tasks are media failures. The
explicit failure-task mode still asserts the expected reason and retryability.

Done when: both reports pass `mcp.get_meeting` with `statusSourceOmitted=true`, the success
draft has a succeeded transcribe and a transcript, and the designated failure draft retains
its structured failure. `pipeline.callback` is skipped; this reads persisted evidence and does
not claim a new callback or paid pipeline run.

## Local verification and remaining coverage

```bash
nix develop --command npx tsx scripts/verify-media-preview.ts --self-test \
  --fixture-file /tmp/media-preview-fixtures/speech.mp4
nix develop --command npx tsc --noEmit --target es2022 --module NodeNext \
  --moduleResolution NodeNext --strict --skipLibCheck scripts/verify-media-preview.ts scripts/verify-agent-media-client.ts
```

The self-test checks preview-origin rejection, inspection contract validation, JSON/SSE decoding, JSON-RPC errors URL redaction, bounded local duration fallback, exact remote-byte matching/rejection, and success status requiring a transcript while rejecting any `source` field, without network calls. With `--fixture-file`, the self-test also runs actual local ffprobe and reads that fixture (no upload). The explicit typecheck is required because repository `tsconfig.json` includes `src` only.

The deployed run below exercised authenticated inspection, MCP discovery, draft creation, upload, successful transcription, retryable and permanent callbacks, recovery, persisted callback version and duplicate/late-callback guards. Release, real Mux playback, DRM/private-media combinations, genuinely just-ended live streams, legacy-server deployment, downstream correction/summarization and subscriber delivery remain outside the deployed checks.

Done when: run failure and success modes with distinct `--create-test-meeting athens` invocations after the latest app preview is deployed; see saved draft IDs, a failed unsupported-media callback, and a succeeded transcription with a persisted transcript. For uploaded speech, also see the local verified duration/byte count and `remoteBytesMatch: true`. Local checks alone do not claim deployed E2E coverage.


## Historical deployed evidence — 2026-11-01 (prior contract)

These observations predate the approved PR952 simplification. The earlier assertion that successful MCP task status includes `source` is superseded: current status must omit it. Source remains in inspection and saved success payloads; failed transcribes still expose `mediaFailure`. Preserve these results as evidence of the earlier deployment, not verification of the current status contract.

App PR #952 was rebased onto `c1f313688` (feature `5dd2be04f`) and its preview deployment and all CI gates passed. Tasks PR #121 runs the same production source as `2d875b3`; later test/docs commits do not alter the server implementation. Runtime checks confirmed `TASK_API_URL=https://pr-121.tasks.opencouncil.dev`, `NEXTAUTH_URL=https://pr-952.opencouncil.dev`, and the app's bucket `opencouncil-previews`.

The final real-source inspection matrix passed all 36 HTTP/auth/MCP/contract checks. Supported sources are not promises of a full transfer. The two independent lookups can receive different upstream refusals: a follow-up bare Vimeo lookup alternated between login-required and missing-page responses. It remained blocked; the earlier full matrix had matching observations. Wistia returned extractor playlist errors, Facebook `Cannot parse data`, the old Dailymotion sample `Not found`; an alternate Dailymotion player resolved. YouTube channels and Kraków's RSS are correctly refused as meeting recordings. The Vimeo event itself is embed-only; KEX's embedding page resolves.

The 15.4-second synthetic Greek speech fixture (163,492 bytes) was sent through real MCP `start_task`, the deployed downloader, ffmpeg, Spaces, Pyannote, Scribe, signed callback and app persistence. `get_meeting` confirmed successful transcripts with `source.kind=file`, `yt-dlp` (HTML5 page), and `spaces` (own bucket). Permanent failure was submitted without inspection of that URL and returned `unsupported`, `retryable=false`, and guidance. A deliberately truncated HTTP transfer returned `error`, `retryable=true`; it left no partial file. Restoring that exact URL and submitting a fresh test task succeeded.

All test meetings are unreleased drafts in the isolated PR952 database. No meeting release or notifications were exercised. The first app upload used the shared app environment's old `townhalls-gr` bucket: its synthetic object was byte-verified and deleted, and only PR952's storage override was changed to the preview bucket. The foreign-bucket case correctly resolved as `file`; it was not counted as own-Spaces coverage.

Real Mux playback remains unverified: this preview lacks Mux credentials and deliberately produces mock IDs. Authenticated/private/cookie/password/extractor-argument combinations, DRM, a genuinely just-ended livestream, and every yt-dlp extractor are not claimed as covered. Local tests cover post-live retry timing and legacy callback shapes. Transcription can trigger correction tasks; correction, summarization and subscriber delivery are outside these media-source checks.

Detailed reports are generated by the commands above and kept outside Git to avoid retaining transcript/callback credentials. A compact final outcome table follows.


| Deployed check | Result |
| --- | --- |
| Auth, input validation, MCP discovery, 13 real source lookups through both services | 36 checks passed |
| Direct MP4 + HTML5-page full transcription | Succeeded; transcript and source persisted |
| MCP single-PUT upload + own-Spaces full transcription | Succeeded after preview storage alignment; `source.kind=spaces` |
| No-inspection permanent failure | Real callback; `unsupported`, `retryable=false`, guidance visible |
| Interrupted transfer and later recovery at same URL | Retryable failure; no partial cache; later transcription succeeded |
| Signed callback guards on four real tasks | 12 checks passed; version 6, terminal state, result digests and transcript counts unchanged |
| Synthetic MP4 / MP3 / HTML5 / HLS / DASH raw downloads | Passed; positive ffprobe duration/size and cache reuse |
| Empty / multi-video / missing fixtures | Refused |

Real-source full downloads (no paid downstream stages):

| Source | Duration (s) | Bytes | Cache reused |
| --- | ---: | ---: | --- |
| youtube | 213.089524 | 33,905,183 | Yes |
| peertube | 114.062675 | 16,815,344 | Yes |
| kextv-page | 2391.533333 | 826,486,689 | Yes |
| krakow-file | 2625.77 | 363,179,660 | Yes |

`prepare-media-preview.mjs --verify-callback-guards /tmp/report.json` runs bounded signed-callback checks on this run's four designated task records only. It verifies the database identity first and never logs signed callback URLs. Its `--revoke` command revokes the temporary MCP token after testing.

After a preview database refresh, use fresh passed verifier reports instead of the archived task IDs:

```sh
nix develop --command node scripts/prepare-media-preview.mjs \
  --verify-callback-guards /tmp/fresh-callback-guards.json \
  --task-report /tmp/fresh-success.json --task-report /tmp/fresh-failure.json
```

This mode takes exact task and meeting IDs from passed reports for PR121/PR952. It also checks the task creation time, terminal status, version and isolated database identity before sending any callback. A change to main's migrations or seed bundle can refresh the preview database and remove prior test tokens and records. Create the disposable MCP token after the new preview is live. A failed authentication preflight creates no meeting or task.

Additional fault-test options are `--failure-url <synthetic fault URL> --expect-retryable`. For an HTML page whose duration is absent, `--fixture-file local.mp4 --fixture-media-url <public byte-identical MP4>` verifies fixture bytes while passing the page itself as `--video-url`. The test page must embed that verified short fixture. These options do not change task-server behavior. Hosted URLs without metadata or a verified local short fixture are refused by the test runner.

The raw runner `verify-preview-downloads.mjs` executes with the deployed closure's Node and an instance's preview `EnvironmentFile`. It reads runtime executable paths from that closure's `start.sh`, uses a separate `media-verification[-suffix]` directory belonging to the same PR, records ffprobe duration/size, and verifies cache reuse before removing only that test cache. `--concurrency 2` also runs two real preparations, checks independent video/audio paths and verifies that preparation leaves the raw cache unchanged. A case can specify `container: "mp4"` to verify the actual output container with ffprobe, including single-file WebM remuxing. Use only short synthetic fixtures with concurrency enabled. The fault server is loopback-only and scoped to PR121. Its marker `<fixture>.recovered` restores interrupted GETs for the same-URL recovery test. Temporary Caddy fixture routes and fault units are removed after verification; test meeting drafts remain for review.

For the already-authorized PR121/PR952 pair, `prepare-media-preview.mjs --tasks-credentials /tmp/private-tasks.json` reads only the documented tasks-preview env file into a new mode-0600 file. It does not print the token. Create a disposable MCP token with `--output`, then use `--merge-credentials` as above. Revoke the MCP token and delete both private files after testing.


The transport-fault fixture deliberately serves healthy HEAD and Range probes so metadata can resolve before the normal direct downloader's plain GET is cut off. It tests interruption of this application's direct transfer, not arbitrary clients that download/resume via Range. Ranged-transfer faults remain outside the deployed checks. Custom failure tasks require a valid structured reason: `--expected-failure-reason` defaults to `error` for `--failure-url`, or `unsupported` for the built-in malformed YouTube case. `--expect-retryable` changes only the expected retryability.

### Rebase and single-file WebM verification, 2026-11-03

App `5f6dfc592` was rebased onto main `f40c5936f` without changing its feature patch. No migration is added by either feature PR. The task preview with `--remux-video mp4` passed these real downloads and two concurrent preparations per source. Each case retained its raw cache and stable upload basename:

| Source | Downloaded duration | Raw MP4 bytes |
|---|---:|---:|
| Direct MP4 | 15.400 s | 163,492 |
| HTML5 MP4 page | 15.400 s | 163,492 |
| HTML5 single-file WebM page | 15.400 s | 197,253 |
| HLS | 15.446 s | 165,892 |
| DASH | 15.400 s | 163,491 |

The WebM input completed a full transcription through app MCP, the task server, storage, diarization, ASR, signed callback and transcript persistence. Task status omitted `source`; the saved success retained it. A separate task started without inspecting its invalid source returned `unsupported`, `retryable=false` through `get_meeting`. Nine inspection cases matched between the task endpoint and MCP, including empty/multiple/missing media refusals. Six signed-callback checks on the two fresh tasks left terminal state and transcript counts unchanged.

### MP3 recording uploads, 2026-11-03

The shared app upload table now accepts MP3 for browser, HTTP and MCP recording uploads.
Single-part and multipart plans use `.mp3` and `audio/mpeg`. The worker keeps audio-only
preparation as MP3, including inputs with cover art. Video processing retains its MP4 path.

A 60,412-byte, 14.954-second synthetic MP3 passed MCP upload, public byte verification,
normalization, diarization, ASR and callback persistence. The processed stored recording
remained audio-only MP3 (`audio/mpeg`, 240,531 bytes). A separate MP4 upload/transcription
regression also passed. Callback checks tied the verified MP3 object to the saved result
and meeting recording URL. Nine missing-token, duplicate-result and late-progress checks
left the MP3/MP4 success tasks and the designated failure task unchanged.

The verifier tests small and larger MP3 bodies, and rejects invalid bytes. A successful
ffprobe can close stdin early and cause Node to report `EPIPE`; the verifier accepts that
only with exit code zero and valid audio-only MP3 metadata. The initial E2E checker failure
was reproduced locally and fixed without changing the successful worker processing.

Both branches have typechecks and green CI. Local coverage includes 738 app upload/MCP/task
tests, 1,680 task tests after rebasing onto latest main, and real plain/cover-art MP3 and
concurrent MP4/WebM preparation. No migration or new endpoint is needed. Preview Mux IDs
remain mocked; this does not claim real Mux playback verification.

Local checks passed: 1,652 task tests, app typecheck after regenerating main's Prisma client, 829 app task/MCP/status tests, 10 boundary tests, 38 real database tests and the local callback bridge. Both CI and preview builds passed. Real Mux playback, DRM/private-cookie sources and a genuinely just-ended live event remain outside these checks. The revised-upload smoke-cleanup finding remains deferred.

Tooling review additionally verified that malformed private credential JSON cannot echo its contents and that unknown/empty raw-download selections fail before running any case. No production implementation changed during preview verification.
