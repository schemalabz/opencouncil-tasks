# Shipping the fusion provider — deployment, raw transcripts, staging rollout

**Branch:** `feat/fusion-provider`
**Decision it implements:** the 2026-09-09 meeting decision to ship the three-system
fusion (ElevenLabs Scribe v2 + Soniox `stt-async-v5` + our RunPod-served whisper
adapter, combined by deterministic rules). Measured WER 0.09913 against Scribe's
0.14027 on the frozen 391-window benchmark.

Three requirements came out of that meeting: settle the deployment shape, keep the
three raw per-system transcripts, and be able to run staging against one real
meeting and diff it against production. This plan does those three and nothing else.

## 1. Deployment shape — the meeting's premise was wrong

The meeting decided to run the fusion "as a separate service inside the
opencouncil-tasks docker compose, next to redis and pgsync, the same in
development and production". The code says that service already exists as a
subprocess, not a peer container. **Chosen: option (b) — the app image needs a
Python runtime and `fusion/` present, and nothing else.**

Evidence, in the order it settles the question:

1. **The Python boundary is a subprocess, not a socket.** `src/lib/fusion/fusePy.ts`
   spawns `config.pythonBin` with `<repoRoot>/fusion/fuse.py`, `cwd: repoRoot`,
   payload on stdin, result on stdout. There is no HTTP client for a fusion
   service anywhere in `src/` — no base URL, no env var, no retry policy for one.
   `fusion/CONTRACT.md` states the boundary as one subprocess call and the Python
   side is stdlib-only.
2. **The pipeline already calls it in-process.** `src/tasks/transcribe.ts`
   dynamically imports `../lib/fusion/index.js` when `FUSION_MODE` is set and calls
   `transcribeSegmentFused` / `transcribeSegmentShadow` inside the `app` process.
   Nothing about that path crosses a container boundary.
3. **The one HTTP surface is the benchmark's, and it is already inside `app`.**
   `src/routes/openaiCompat.ts` is mounted onto the existing express app by
   `mountOpenAiCompatRoute(app)` in `src/server.ts`, on the app's own port, behind
   the app's own bearer auth, only when `FUSION_OPENAI_ROUTE=on` (default off). Its
   header comment says outright that it exists because the benchmark harness speaks
   that protocol.
4. **Where the "separate service" impression came from.** The untracked
   `fusion_bench_server.mjs` at the repo root is a personal-machine host for that
   same route: it hardcodes `/home/harold/projects/...` absolute paths, binds
   `127.0.0.1:8787`, takes `BENCH_PROVIDER_TOKEN`, and points its cache and traces
   at `~/.cache/oc-public/`. That is the mini-PC benchmark host, not a deployment
   topology. It is what people saw running "next to" things.

So the deployment work is not extraction. It is that **the fusion cannot run in the
production image at all today**, for two reasons, both in `Dockerfile`:

- the `runner` stage installs `tini ffmpeg curl gosu unzip` and no Python;
- the `runner` stage copies `dist`, `VERSION` and `assets` from the builder, and
  never `fusion/`.

Left as is, a deployment with `FUSION_MODE=on` pays Scribe *and* Soniox *and*
RunPod for every segment, then throws the two aux results away and returns the
Scribe transcript, because `fusionEngineRevision()` returns `absent` and `spawn`
fails. That is the expensive silent failure this change exists to prevent.

### Rejected: (a) a separate compose service

Rejected because it buys nothing and costs a second implementation of the failure
matrix. `FusionTranscriber` owns one shared deadline across the three providers and
the subprocess, one cache, and one documented fallback table; putting an HTTP hop
in the middle of that means a second timeout budget, a second retry policy, and a
second opinion about what "Scribe fallback" means — the exact "two implementations
that agree today" the route's own comment warns about. It also moves audio bytes
between containers for a call whose Python side is stdlib-only and CPU-bound.
Recorded here so nobody re-derives it: the reason it looked necessary was
`fusion_bench_server.mjs`, above.

### What changes

- `Dockerfile` runner stage: `python3` from the Debian package set (bookworm ships
  3.11; `fusion/__init__.py` requires ≥ 3.11), and
  `COPY --from=builder /app/fusion ./fusion`. `fusion/` holds only `*.py`, `*.json`
  and `CONTRACT.md` — no fixtures, no audio, no transcript text.
- `.dockerignore`: `__pycache__`, `logs`, `tests/fusion/fixtures`. The last one
  matters: the fixture bundle is verbatim council speech, and a developer with a
  local copy would otherwise bake it into an image layer.
- `.gitignore`: the raw-transcript log path, because `.dockerignore` keeps things
  out of an image and has never kept anything out of a commit.
- **A startup preflight that runs the real thing.** New `src/lib/fusion/preflight.ts`.
  When the effective mode is not `off`, it runs `fusion/fuse.py` once with a
  synthetic three-word payload through `runFusionPython` — the same function, the
  same `pythonBin`, the same `repoRoot`, a bounded deadline — and throws if it does
  not come back with a valid `oc-fusion/1`. An existence check would pass on a
  Python that is too old, a script the runtime user cannot read, or a `fusion/`
  that is missing one module. Called from `src/server.ts` next to the existing
  `loadFusionConfig()`, which is before `app.listen`, so the process fails before
  it accepts a job rather than after it has billed three vendors.
  With `FUSION_MODE` unset or `off` — production's state on day one — the preflight
  probes nothing and the process starts exactly as it does today.
- **The dev stack gets the same treatment**, because the meeting asked for "the
  same in development and production". `Dockerfile.dev` had no Python either, and
  `docker-compose.dev.yml` bind-mounts `./src` but not `./fusion`, while
  `Dockerfile.dev` copies no source at all — so `/app/fusion` did not exist in
  development at any point. Both fixed.

### Two pre-existing defects found on the way, and fixed

Neither is caused by anything above; both block shipping, so they are in this change.

1. **The image could not be built.** `ScribeTranscriber` in
   `src/lib/ScribeTranscribe.ts` was not exported, so with `declaration: true`
   TypeScript could not name the type of the exported `scribeTranscriber`
   instance and `npm run build` failed with seven `TS4094` errors — which is the
   `RUN npm run build` step of the Dockerfile. `npm run typecheck` is
   `tsc --noEmit`, and declaration emit is the only thing that needs the name, so
   the typecheck passed the whole time. Reproduces at `94a91b6`:
   `npx tsc --outDir /tmp/x`. Fixed by exporting the class.
2. **`fusion/__pycache__` shipped inside the image.** `.dockerignore` patterns
   match relative to the context root, so a bare `__pycache__` only excludes a
   top-level one. Now `**/__pycache__`.

## 2. The three raw transcripts

The decision: do **not** put the three per-system transcripts in the database yet;
write them out so they are not thrown away. They may later feed an LLM-as-judge or
a human correction UI.

New `src/lib/fusion/rawLog.ts`, `RawTranscriptLog`:

- **Off unless configured.** `FUSION_RAW_LOG_DIR` unset ⇒ nothing is written and
  nothing is constructed. Staging sets it to `/app/logs/fusion-raw`, which is
  already a bind-mounted volume in both compose files, and `/logs/` is already
  gitignored.
- **One file per segment attempt**, `<audioSha256>.<attemptId>.json`, written to a
  temp name and renamed — the same shape and the same durability rule as the
  existing `TraceWriter`, and it shares the attempt id with the trace, so a trace
  and a raw record join without a database. A single daily JSONL was considered and
  dropped: it needs a serialized append chain, a bounded queue, a poisoned-chain
  policy and a truncated-last-line policy, all to solve a problem one file per
  attempt does not have.
- **What a record carries:** schema, attempt id, UTC timestamp, `audioSha256`,
  segment label, mode, arm, engine revision, config sha, outcome, and per provider
  `{providerId, status, model, paramsSha, schemaRev, rawSha256, wordCount, words}`
  where `words` is the normalized `{raw, start, end, conf}` stream that fuse.py was
  fed. Word times are **segment-relative**, like every other time on this path.
- **What a record must never carry:** provider error strings and raw provider
  responses. A vendor error can contain a signed URL or an echoed request, and the
  trace already records errors for diagnosis. The raw log carries successful word
  streams and a per-provider `status` from a closed set, nothing else.
- **Never throws.** A write failure returns `false` and warns; the warning contains
  the path and the error, never any part of the payload. Failing a transcription
  because a log file could not be written would trade the product for a record of it.
- **An explicit size valve.** A record whose serialized form exceeds
  `FUSION_RAW_LOG_MAX_BYTES` (default 32 MB; a 20-minute segment is ~0.6 MB) is
  written with its `words` arrays dropped and `omitted: "record_too_large"` set, so
  an oversized attempt leaves a marker rather than a silently shortened transcript.
- **Emitted once per attempt, after the outcome is known**, including when the
  attempt throws, so a record exists for `fused`, `scribe-fallback`, `scribe-only`
  and `failed` alike. A provider that failed does not take a provider that
  succeeded down with it: whatever streams were collected are recorded.

Not in the database, and no schema change anywhere. Each record is written
compact and gzipped, because three systems emit mostly the same words and a word
record is short. Measured at the rate the benchmark saw, 9,800 words per audio
hour per system: a 2.5-hour meeting is 9.7 MB indented, 4.9 MB compact and
0.75 MB gzipped, doubled in shadow mode because that writes a record for the
Scribe answer and one for the background fusion. Read one with
`gunzip -c <file> | jq`.

Records expire after `FUSION_RAW_LOG_RETENTION_DAYS`, default 14 days. The
default is finite on purpose: a deployment that sets the directory and forgets
about it must not accumulate council speech indefinitely, and keeping it for
good has to be asked for with `0`. The sweep runs after a successful write and
at most once an hour, deletes only `.json.gz` files so a shared directory keeps
its other logs, and fails silently, like the write path.

## 3. Staging first, and diffing against production

New pure `src/lib/fusion/diffTranscripts.ts` plus a `fusion-diff <a.json> <b.json>`
CLI subcommand. It aligns the two full word sequences with a token-level
Levenshtein alignment over normalized words and reports substitutions, deletions,
insertions, matched count, and the changed pairs with their timestamps.

Deliberate choices: token-level rather than utterance-level, because aligning
utterances by time overlap turns one utterance split into two into a pile of false
insertions and deletions; and the normalization policy (casefold, strip
punctuation, NFC) is fixed in code rather than passed in, so two runs of the tool
give the same number.

What the output **is**: *agreement-with-production*. It records whether the fusion
changed the published text and where. What it is **not**: a fidelity claim. Neither
side is a human reference, so a "worse" diff is not evidence of worse audio
fidelity — that question was already answered by the 391-window benchmark, on one
machine with one decoder.

### Rollout steps

1. Merge to staging's checkout with `FUSION_MODE` unset. Confirm the app starts and
   `/transcribe` still behaves. This proves the image change is inert when fusion
   is off.
2. Set staging's `.env` (section 4), redeploy, confirm the startup log line and
   that the preflight passed.
3. Run one council meeting on staging. Run the *same* meeting on production, which
   is still Scribe-only.
4. Pull both transcripts and run `npm run cli -- fusion-diff staging.json prod.json`.
5. Read staging's traces (`FUSION_TRACE_DIR`) for the fallback rate and reasons,
   and confirm `outcome: "fused"` dominates. A meeting that fell back on every
   segment produces a clean-looking diff and proves nothing.
6. Only then consider production, at a canary percent, in a separate change.

## 4. Config a deployer must set

| Variable | Staging | Production (day one) | Notes |
|---|---|---|---|
| `FUSION_MODE` | `on` | unset | `off`/`shadow`/`on`. Invalid value stops the process. |
| `FUSION_CANARY_PERCENT` | `100` | unset (0) | `on` with 0 transcribes nothing with fusion. |
| `FUSION_LLM` | `off` | `off` | Stays off. The shipped arm is rules + the vote/negation guard. |
| `FUSION_OPENAI_ROUTE` | `off` | `off` | Benchmark-only surface. Not needed to ship. |
| `FUSION_RAW_LOG_DIR` | `/app/logs/fusion-raw` | unset | Requirement 2. Volume-mounted, gitignored. |
| `FUSION_TRACE_DIR` | `/app/logs/fusion-traces` | — | Default is `$TMPDIR`, which a container restart discards. |
| `FUSION_CACHE_DIR` | `/app/data/fusion-cache` | — | Same reason; a warm cache is what makes a retry free. |
| `FUSION_DEADLINE_MS` | default (240000) | — | Shared by all three providers and the subprocess. |
| `SONIOX_API_KEY` | required | — | Must be the paid `stt-async-v5` account, not the free realtime one. |
| `RUNPOD_API_KEY` | required | — | For our own adapter. |
| `OC_ASR_ENDPOINT_ID` | required | — | The serverless endpoint serving the adapter. |
| `ELEVENLABS_API_KEY` | already set | already set | Unchanged. |
| `FUSION_PYTHON_BIN` | unset | unset | Defaults to `python3`; set only if the image's Python moves. |

## 5. Test plan (written first, watched fail)

| File | Asserts |
|---|---|
| `src/lib/fusion/rawLog.test.ts` | disabled ⇒ no directory and no write; record shape and schema; provider error strings and raw responses are absent from the record; a provider that failed does not remove one that succeeded; two concurrent attempts produce two complete files; an unwritable directory returns `false` and does not throw; an oversized record drops `words` and sets `omitted`; the filename contains no transcript text. |
| `src/lib/fusion/preflight.test.ts` | mode `off` probes nothing; a `pythonBin` that does not exist fails; a `repoRoot` with no `fusion/fuse.py` fails; a Python that exits non-zero fails and the message carries its stderr; the real `fusion/fuse.py` passes; the probe respects its deadline. |
| `src/lib/fusion/diffTranscripts.test.ts` | identical inputs give zero changes; substitution, insertion, deletion each counted once; an utterance split into two does not register as a change; casing and punctuation are normalized away; repeated words; empty on either side; determinism on re-run. |
| `src/lib/fusion/FusionTranscriber.test.ts` (extended) | a raw record is emitted for `fused`, for `scribe-fallback`, and when Scribe is unusable and the attempt throws. |
| `src/lib/fusion/index.test.ts` (new) | `createFusionRuntime` with `FUSION_RAW_LOG_DIR` set actually constructs the log and hands it to the transcriber; unset ⇒ disabled. |

All fixtures use synthetic Greek-looking words. No fixture, snapshot or assertion
message may contain real transcript text or a path into a real bundle.

Then: `npm run test:fusion-route-gate` must still be 13/13, and `npm test` must
gain no new failures against the recorded baseline (see `plans/qa/fusion-provider-pr.md`
for the baseline — this repo has pre-existing typecheck and test failures unrelated
to fusion, and they are not an exemption for anything here).

Not covered by automated tests, and why: building the runner image and executing
the packaged Python as the `apify` user needs a Docker build, so it is a manual
step in the QA doc. Quality acceptance is not re-litigated here — that is the
391-window benchmark's job, and the route gate is what keeps this code equal to it.

## OPEN QUESTIONS FOR HAROLD

1. **Raw-transcript log destination.** Disk for now, by Harold's call on
   2026-09-09: files go to `/app/logs/fusion-raw` on the existing bind-mounted
   volume, gzipped, about 1.5 MB per long meeting in shadow mode. Two things are
   still open: whether it should later move to DigitalOcean Spaces (the
   `DO_SPACES_*` credentials and an uploader already exist) so it survives the
   droplet and can be pulled without SSH, and whether 14 days is the right
   window. Deletion itself is implemented: records expire after
   `FUSION_RAW_LOG_RETENTION_DAYS`, default 14.
2. **Staging credentials.** Does the staging `.env` already have `SONIOX_API_KEY`,
   `RUNPOD_API_KEY` and `OC_ASR_ENDPOINT_ID`, or do they need to be put there — and
   is the Soniox key the paid `stt-async-v5` account rather than the free realtime one?
3. **Which meeting.** Which council meeting should the staging run use? It needs to
   be one production has already transcribed with Scribe, so the two are comparable,
   and short enough that a failure costs an hour rather than a day.
4. **Staging host and access.** DeepWiki says staging is
   `/root/staging-opencouncil-tasks/` on `134.122.74.255`, port 3006. Is that still
   right, and do I have (or should the deploy runbook get) a way to trigger a
   `/transcribe` there and pull the resulting transcript JSON?
5. **RunPod endpoint availability during the run.** Our adapter is served by a
   scale-to-zero serverless endpoint. A cold start inside the shared 240 s deadline
   is the most likely cause of an aux-provider timeout, which silently degrades the
   whole meeting to Scribe. Should the endpoint be pinned warm for the staging run,
   or should `FUSION_DEADLINE_MS` be raised for it?
6. **`docs/fusion-provider.md` does not exist.** `src/tasks/transcribe.ts` points at
   it for the canary rationale. Should this branch write it, or is the plan document
   plus `fusion/CONTRACT.md` enough for now?
