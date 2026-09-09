# QA — fusion provider, shipping changes

Branch `feat/fusion-provider`. Plan: [`plans/fusion-provider-shipping.md`](../fusion-provider-shipping.md).
Commits `4f7e3b4` … `95aadca` (7 commits on top of `94a91b6`).

## What changed

**1. The fusion can now run in a built image at all.** It could not before.
`Dockerfile`'s runner stage installed `tini ffmpeg curl gosu unzip` and copied
only `dist`, `VERSION` and `assets` — no Python, no `fusion/`. With
`FUSION_MODE=on` that image bills ElevenLabs, Soniox and RunPod for every
segment, fails to spawn the subprocess, discards two of the three results, and
returns a Scribe transcript that looks completely normal.

- `Dockerfile`: `python3` in the runner stage, with a version assertion (the
  fuse core states ≥ 3.11; bookworm gives 3.11.2), and
  `COPY --from=builder /app/fusion ./fusion`.
- `Dockerfile.dev` + `docker-compose.dev.yml`: the same `python3`, and a
  `./fusion:/app/fusion` mount — Dockerfile.dev copies no source at all, so dev
  had nothing to run either.
- `src/lib/fusion/preflight.ts` + `src/server.ts`: at startup, when the mode is
  not `off`, run `fusion/fuse.py` once on a synthetic payload through the same
  `runFusionPython` the pipeline uses, and throw if it does not answer with a
  valid `oc-fusion/1`. Before `app.listen`, so the process dies instead of
  accepting a job. With fusion off it probes nothing.
- **No compose service was added.** See the plan for why: the Python boundary is
  a subprocess, the pipeline already calls it in-process, and the "separate
  service" impression came from the untracked `fusion_bench_server.mjs`
  benchmark host.

**2. The three raw per-system word streams are kept.**
`src/lib/fusion/rawLog.ts`. One JSON file per segment attempt under
`FUSION_RAW_LOG_DIR` (unset ⇒ nothing written), sharing its `attemptId` with the
existing trace. Carries the identity fields and the normalized word streams;
carries no provider error strings and no raw provider responses, because a
vendor error can hold a signed URL or a key. Never throws. Not in the database.

**3. A way to compare staging against production.**
`src/lib/fusion/diffTranscripts.ts` + `npm run cli -- fusion-diff <a> <b>`.
Token-level alignment (patience anchors + exact Levenshtein inside the gaps, so
a 25k-word meeting is ~90 ms rather than a 2.5-billion-cell table), fixed
normalization, output labelled as agreement-with-production and explicitly not a
fidelity claim. Also `npm run cli -- fusion-preflight`.

**4. Two pre-existing defects that blocked shipping.**
- `src/lib/ScribeTranscribe.ts`: `ScribeTranscriber` was not exported, so
  `declaration: true` could not name the type of the exported instance and the
  image build failed with seven `TS4094` errors. `npm run typecheck` uses
  `--noEmit`, which does not need the name, so it passed. Reproduced at
  `94a91b6` before any change in this branch: `npx tsc --outDir /tmp/x` → 7
  errors. **`docker compose up app --build` could not build this branch.**
- `.dockerignore`: `__pycache__` matches only a top-level directory, so
  `fusion/__pycache__` shipped in the image. Now `**/__pycache__`. Also added
  `logs` and `tests/fusion/fixtures` — the fixture bundle is verbatim council
  speech and must not be able to reach an image layer.

`FUSION_LLM` is untouched and still defaults to off. No existing test was
changed or removed; `FusionTranscriber.test.ts` gained cases.

## Verify locally in under 5 minutes

```bash
# 1. The new logic (45 tests, ~3 s)
npx vitest run src/lib/fusion/rawLog.test.ts src/lib/fusion/preflight.test.ts \
               src/lib/fusion/diffTranscripts.test.ts src/lib/fusion/index.test.ts \
               src/lib/fusion/FusionTranscriber.test.ts

# 2. Whole suite — compare against the baseline below, not against green
npm test

# 3. This environment can run the engine
npm run build && node dist/cli.js fusion-preflight
# {"checked":true,"ok":true,"pythonBin":"python3", … "engineRev":"8433e6143acef7b2"}

# 4. The diff tool, on two synthetic transcripts you make yourself
node dist/cli.js fusion-diff a.json b.json
```

Image-level, ~4 minutes on a warm cache:

```bash
docker build -t oc-tasks-fusion-check:local .
mkdir -p /tmp/ocdata /tmp/oclogs /tmp/empty-fusion

# python3 3.11.2 and the fuse core, as the runtime user
docker run --rm --entrypoint gosu oc-tasks-fusion-check:local apify \
  sh -c 'id -un; python3 --version; ls fusion'

# preflight passes
docker run --rm -e FUSION_MODE=on -e NO_AUTH=true -e PORT=3999 \
  -v /tmp/ocdata:/app/data -v /tmp/oclogs:/app/logs \
  oc-tasks-fusion-check:local timeout 30 node dist/server.js
# → 🔀 Fusion engine preflight passed (python3, engine 8433e6143acef7b2, 73 ms)

# preflight fails when the engine is missing — the bug it exists for
docker run --rm -e FUSION_MODE=on -e NO_AUTH=true -e PORT=3999 \
  -v /tmp/ocdata:/app/data -v /tmp/oclogs:/app/logs \
  -v /tmp/empty-fusion:/app/fusion \
  oc-tasks-fusion-check:local node dist/server.js
# → Error: [fusion] FUSION_MODE=on but the fusion engine cannot run: …

# and with fusion off, a missing engine changes nothing
docker run --rm -e NO_AUTH=true -e PORT=3999 \
  -v /tmp/ocdata:/app/data -v /tmp/oclogs:/app/logs \
  -v /tmp/empty-fusion:/app/fusion \
  oc-tasks-fusion-check:local timeout 20 node dist/server.js
# → Server running at http://localhost:3999
```

All four image checks were run and passed on 2026-09-09.

## Test results

| Command | Before (`94a91b6`) | After |
|---|---|---|
| `npm test` | 6 files failed, 1 test failed, 909 passed | 6 files failed, 1 test failed, **954 passed** |
| `npm run typecheck` | 29 errors | 29 errors, **none in `src/lib/fusion/`** |
| `npx tsc --outDir /tmp/x` (declaration emit) | +7 `TS4094` | 0 `TS4094` |
| `docker build .` | **fails** at `npm run build` | **succeeds** |
| `npm run test:fusion-route-gate` | not re-measured | **15 passed, 0 failed** (1522 s) |

**The pre-existing failures are a stale local `node_modules`, not the repo.**
`@anthropic-ai/sdk` is installed at `0.71.2` while `package-lock.json` pins
`0.124.0`, and `mammoth`, `@remotion/captions`, `ass-compiler` and `fontkit` are
not installed at all. That accounts for all 29 typecheck errors
(`src/lib/ai.ts`, `ai.test.ts`, `observability.ts`, `usageLogging.ts`,
`captions/*`, `documentConversion.ts`), for the 5 test files that fail to load,
and for the one real assertion failure in `src/lib/ai.test.ts`
("Claude declined this request" without its category). `npm ci` should clear
them; it was not run here because it would have wiped `node_modules` under a
long-running gate. The Docker build installs from the lock, and it now succeeds
— which is the evidence that these are local.

### Route gate

`npm run test:fusion-route-gate` on the final commit: **15 passed, 0 failed**, 1522 s.
Note it is 15 tests, not the 13 from `52b33a2`; two were added later on this branch.
The scorer's verdict:

```json
{"ok":true,"n_results":391,"n_expected":391,
 "sidn":[5030,1861,5520,110694],"wer":0.11212,
 "frozen_sidn":[5036,1848,5519,110694],"frozen_wer":0.11205,
 "delta_wer":0.00007,"delta_gate":0.002,
 "n_hard_mismatches":0,"n_chunking_divergences":2,"total_extra_errors":8,
 "largest_window_share_of_net_delta":1.25,
 "missing_ids":[],"unexpected_ids":[],"duplicate_ids":[]}
```

Zero hard mismatches: the production route reproduces fuse.py's text exactly for
every window. The two chunking divergences and the +0.00007 WER are the frozen
`max_tokens=120` cost, well inside the pre-declared 0.002 budget, and they are
not new to this change.

## What I could not verify, and why

- **The staging run itself.** Nothing here has touched a real meeting. It needs
  credentials, a staging host and a chosen meeting — the open questions in the
  plan. The rollout steps are in the plan, in order.
- **`docker compose up` end to end.** No local `.env` exists, so both compose
  files were only validated by `docker compose config`. The `app` service image
  was exercised directly with `docker run`, above.
- **RunPod cold start inside the 240 s deadline.** The most likely cause of an
  aux-provider timeout on a real meeting, and it cannot be measured without
  calling the real endpoint.
- **Whether `/app/logs` has room for the raw log.** ~0.6 MB per segment attempt,
  ~30 MB per meeting, with no retention policy. Open question 1 in the plan.
- **Shadow mode writes two raw records per segment** (one for the Scribe-only
  answer, one for the background fusion), which doubles disk in that mode. It is
  deliberate — a record whose existence depends on the mode loses evidence — but
  it has not been measured against a real meeting's volume.

## PR title

```
Make the fusion provider deployable, and keep the three raw transcripts
```

## PR body

```markdown
Implements the 2026-09-09 decision to ship the three-system fusion. The plan and
the rejected options are in `plans/fusion-provider-shipping.md`; verification
commands are in `plans/qa/fusion-provider-pr.md`.

### No separate compose service

The meeting decided to run the fusion "as a separate service inside the docker
compose, next to redis and pgsync". The code says it already is one: a
subprocess, not a peer container. `src/lib/fusion/fusePy.ts` spawns
`fusion/fuse.py` with the repo root as its cwd, `src/tasks/transcribe.ts` calls
the transcriber in-process, and the only HTTP surface
(`src/routes/openaiCompat.ts`) is already mounted on the app's own port and
exists for the benchmark harness. The thing people saw running beside the
other containers is `fusion_bench_server.mjs`, an untracked script that hosts
that route on a personal mini-PC.

So this PR does not extract anything. It makes the app image able to run the
Python it already shells out to.

### The image could not run the Python

The runner stage installed no Python and never copied `fusion/`. With
`FUSION_MODE=on`, `spawn` fails on every segment, and the failure matrix turns
that into an exact Scribe fallback. All three providers have already been billed
by then, and the returned transcript carries no marker distinguishing it from a
successful fusion.

- `python3` and `COPY --from=builder /app/fusion ./fusion` in the runner stage,
  and the same in the dev stack so the two environments match.
- A startup preflight that runs the real engine on a synthetic payload and
  throws if it does not answer with a valid `oc-fusion/1`. It runs before
  `app.listen`, and it probes nothing when fusion is off.

### Keeping the three raw transcripts

`FUSION_RAW_LOG_DIR` (unset by default) gets one JSON file per segment attempt
holding the three normalized word streams, sharing its id with the existing
trace. Provider error strings and raw provider responses are deliberately left
out: a vendor error can carry a signed URL, and errors already live in the
trace. The directory holds transcript text, so it points at a mounted volume and
is gitignored, on the same reasoning as the 2026-07-21 history purge.

### Comparing staging against production

`npm run cli -- fusion-diff <staging.json> <production.json>` aligns the two word
sequences and reports what changed and where. The output is labelled as
agreement with production, not as accuracy: neither side is a human reference, so
the number says what moved, not which side is right. Conflating those two is the
measurement mistake this project has paid for before. There is also
`npm run cli -- fusion-preflight` for checking a deployed environment.

### Two pre-existing defects in the way

`ScribeTranscriber` was not exported, so declaration emit could not name the type
of the exported instance and `npm run build` failed with seven `TS4094` errors.
`npm run typecheck` uses `--noEmit`, which does not need the name, so it never
saw them. `docker build .` failed at that step for me on this branch, and the
same seven errors reproduce at `94a91b6`, before any commit here.

`.dockerignore`'s `__pycache__` matched only the top level, so
`fusion/__pycache__` shipped inside the image. It is now `**/__pycache__`, plus
`logs` and `tests/fusion/fixtures`, since the fixture bundle is verbatim council
speech.

### With fusion off

The preflight probes nothing, no raw log is constructed, and the app starts
normally in an image with no fuse core in it at all. There is a test for each of
those. `FUSION_LLM` still defaults to off, so this runs the rules arm with the
vote/negation guard and no LLM chooser.

### Tests

45 new tests across `rawLog`, `preflight`, `diffTranscripts` and the composition
root, plus new failure-matrix cases in `FusionTranscriber.test.ts`. Every fixture
uses synthetic words. No existing test was changed or removed.

`npm test` goes from 909 to 954 passing with the same six pre-existing file
failures. My local `node_modules` is stale: `@anthropic-ai/sdk` 0.71.2 installed
against 0.124.0 locked, and `mammoth`, `@remotion/captions`, `ass-compiler` and
`fontkit` not installed. The Docker build runs `npm ci` from the lock and gets
through `npm run build`, so I have not seen these failures anywhere but this
checkout. Worth a second pair of eyes if they show up in CI.

`npm run test:fusion-route-gate` passes 15/15 on the final commit (1522 s). The
scorer reports `ok:true`, zero hard mismatches against fuse.py, and WER 0.11212
against the frozen 0.11205, inside the pre-declared 0.002 budget.

### Still needed before staging can run

Credentials, a staging host, a chosen meeting, and a decision on where the raw
log should live long term. These are listed as open questions at the end of
`plans/fusion-provider-shipping.md`.
```
