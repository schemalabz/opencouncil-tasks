# Evaluations

Every LLM call a task makes is recorded, archived, and replayable. Evaluation is built on that: a **suite** runs a task's real code over a set of **cases**, scores each output against human truth, and a **comparison** of two runs says whether a change (a model, a prompt, a code path) is better, worse, or not distinguishable. **Failure modes** name the ways a task goes wrong, and their detectors run both in suites and after every production task.

Agents run all of it. People only create truth that a gate relies on, and decide what ships.

## The pieces

| Piece | Lives in | What it is |
| --- | --- | --- |
| Call record | archive `calls/…` | One per `aiChat` call: the sanitised request, its `cacheKey`, the full response, usage, model served. |
| Response store | archive `responses/…` | Immutable recordings by `cacheKey`. Serves `cache: 'use'` call sites and replays. |
| Run | archive `traces/<traceId>` | One task execution: input, every call, result. Written by the archive telemetry sink in every environment. |
| Case | `evals/cases/<suite>/*.json` | One input plus per-field expectations, each with a truth tier. Split `dev` or `holdout`, assigned once from a hash and never changed. |
| Suite | `src/evals/suites/` | How to build a task request from a case and how to score its output. |
| Variant | `evals/variants/*.yaml` | What to change: per-label model, effort or max-tokens overrides. `production` changes nothing. |
| Gate | `evals/gates/<suite>.yaml` | The thresholds a variant must meet against the baseline to ship. |
| Failure mode | `evals/failure-modes/FM-xxxx-*.yaml` | A named way to go wrong, its boundary, a detector, and cases the detector must and must not fire on. |
| Candidate | archive `candidates/<suite>/…` | A proposed case value or failure-mode occurrence, with the signal that produced it. Reaches git only through a review batch. |
| Review batch | archive `reviews/<batchId>/` | Items for a person to settle (`batch.json`), the page (`page.html`) and the submitted decisions (`results.json`). `open → submitted → applied`. |

### Truth tiers

| Tier | Who wrote it | Used for |
| --- | --- | --- |
| `adjudicated` | A person read the source and settled the value. | Gates |
| `imported` | A person's earlier work in production (a link, a correction). | Gates |
| `drafted` | An agent, or two readings that agreed. | Regression only: a change against the baseline, never a claim of correctness |
| `contested` | Readings disagree and nobody has settled it. | Nothing until reviewed |

Holdout scores are hidden by default (`--show-holdout` reveals them). Tune on dev; let the gate read holdout.

## Run a task once

```bash
npx tsx src/cli.ts eval task run <task> --request req.json --env development --budget-usd 2
npx tsx src/cli.ts eval task run <task> --request req.json --env eval --cassette <traceId>   # replay, no network
npx tsx src/cli.ts eval task run <task> --request req.json --override 'decision-reading.model=claude-haiku-5-5'
```

`scripts/build-task-request.ts` builds a request for any task from the public opencouncil API. `scripts/verify-replay.sh <task> <request>` records a live run, replays it with no network, diffs the results and checks that a model change misses the recording. A run that swallowed a replay miss or hit its budget fails, even when the task itself caught the error.

## Compare a change

```bash
npx tsx src/cli.ts eval run decisions.reading --variant production --split all --reps 2
npx tsx src/cli.ts eval run decisions.reading --variant haiku-5-5  --split all --reps 2
npx tsx src/cli.ts eval compare decisions.reading <runA> <runB>
npx tsx src/cli.ts eval gate decisions.reading <runA> <runB>
```

Runs go to `.eval-runs/<suite>/<runId>/` and the archive. `--reps` takes fresh samples (cache reads are off for live suite runs). `--replay` serves a run from recordings with `--live <glob>` keeping chosen labels live, which is how a prompt change to one phase is tested without paying for the others. A phase suite keeps its own labels live unless told otherwise; `--replay --no-live` serves every call from the recording ($0), and a variant that changes a request then shows up as a replay miss in `errors.jsonl`, never as a scored row. `--resume <runId>` continues an interrupted run. The runner refuses a row whose served model differs from the one requested. `eval report <suite> <runId>` prints a suite's own summary of a run where it has one.

`compare` pairs rows by case and repeat (item fields such as `subject[#3 …]` pool into one family, `subject`, whose units are case × item): per-field accuracy with exact McNemar tests, cluster bootstrap intervals (cases from one body are not independent), Holm correction, and the clusters where regressions concentrate. `gate` applies the suite's thresholds and names what failed. A gate never passes on drafted values alone: with no human-tier holdout values it prints `NEEDS_REVIEW`, as it does while fewer cases carry them than the gate's `minHumanHoldoutCases`. A human-tier holdout unit that A scored and B did not (B errored, was truncated or left it unscored) fails the gate: pairing would otherwise drop exactly the cases B breaks.

## Add a case

A case earns its place when it can break the task in a way no existing case covers. Write the file by hand or with `eval cases migrate`; `eval lint` checks the schema, that splits never change, and that human tiers carry who and when. Drafted expectations are fine to add freely; a gate only reads human tiers.

## Add a failure mode

1. Copy an `FM-*.yaml`, give it the next id, a slug, a definition and a boundary (what it is *not*). `suite` may list several suites (`[summarize.context, agenda.context]`) when one detector serves them all.
2. Write the detector (`src/evals/checks/`) and its cases: `must-fire`, `must-not-fire`, and honestly labelled `known-miss` / `known-false-alarm`. `npm test` runs them all; a known miss that starts passing fails the test until it is relabelled.
3. Measure before alerting: `eval checks backfill <slug> --since 90 --env production` reports the fire rate over archived runs, and why the rest were `unknown`.
4. `eval calibrate <slug> [--json]`: TPR/TNR over the detector cases (known misses count as occurrences, known false alarms as non-occurrences) and the archive's `mode-examples` answers. A judge is only read from its recordings, never called.
5. Promote `status` to `confirmed` (or `guarded` once a fix lands). Monitored statuses run after every successful task.

## Review: candidates become truth

```bash
npx tsx src/cli.ts eval harvest --source monitoring --env production --since 14     # failed checks → candidates
npx tsx src/cli.ts eval harvest decisions.reading --source disagreement --run <runId> # run vs drafted/contested values
npx tsx src/cli.ts eval harvest --source novelty --env production --since 90 --dry-run  # inputs unlike every case
npx tsx src/cli.ts eval harvest --source opencouncil --signals <file>                 # people's corrections → imported cases (below)
npx tsx src/cli.ts eval candidates
npx tsx src/cli.ts eval review build mode-examples --signal check:context_disclaimer_preamble
npx tsx src/cli.ts eval review open <batchId>             # person: the page, with the archived source beside each item
npx tsx src/cli.ts eval review submit <batchId> <file>    # or: a results file downloaded from the page
npx tsx src/cli.ts eval review apply <batchId>            # agent: case / detector-case files, lint, PR body
npx tsx src/cli.ts eval status                            # batches waiting on a person or on the agent
```

| Kind | The person decides | `apply` writes |
| --- | --- | --- |
| `label-confirm` | Confirm, correct, or can't tell, per proposed value | `adjudicated` values (`contested` with a reason for can't tell); new cases get their split here |
| `disagreement` | Which of two values is right, blind and in random order | The chosen value, `adjudicated` |
| `mode-examples` | Whether each flagged call is an occurrence of the mode | `must-fire` detector cases (a "no" becomes `known-false-alarm`) |
| `pairwise` | Which of two runs' outputs for one field is better, blind and in random order | Preference records in the archive (`preferences/<suite>/<batchId>.jsonl`), never case values |

A pairwise batch is built from two runs of a suite, not from candidates: `eval review build pairwise --suite <suite> --run <baseline> --run <candidate>`. It holds the fields where the two outputs differ, sampled up to `--limit`.

The page is one file: opened from disk it downloads the results; served by `eval review open` it also submits them and shows the archived PDF or the call's prompts and response. `apply` only writes the working tree and refuses a batch whose case changed since it was built; merging the PR is the confirmation. A suite proposes values only where it can state them in the case's own shape (`labelValue`; extraction: `subject`, `mayor`, `presidedBy`, `decisionAttendance`).

A monitoring or novelty candidate on a decision call carries the case it would make (`caseFromCall`): the document is found in the run's result by decision number (or its extraction's match), clustered by city and the body it states, with the call's answers as proposals, so `label-confirm` takes it. Readings production normalised away (`notADecision`) name no document and stay occurrences only. `--all-statuses` harvests candidate modes' fires (recorded with `eval checks run --all-statuses --record`).

Novelty is deterministic: a decision call whose city, or whose body in a covered city, no case has; a decision number shaped unlike its cluster's (digit runs → 9, letter runs → a); a summarize run from a city with no case. One candidate per city (or cluster and shape), counting the calls.

## Imported truth from opencouncil

People's corrections in opencouncil are `imported` truth with no review. opencouncil's `scripts/export-eval-signals.ts` reads them from a **local copy** of its database (it refuses any URL that is not a socket or loopback host, and never reads `DATABASE_URL`) and writes JSONL signals `{kind, action, ids, before, after, by, at, evidence}`; `--contexts` adds what a case is rebuilt from (the meeting's poll request, its public payload, the fixTranscript request).

```bash
# in opencouncil
npx tsx scripts/export-eval-signals.ts --db 'postgresql://reader@localhost:5495/<db>?host=/tmp/<socket>' --out .eval-signals/s.jsonl --kinds decision-link --contexts
# here
npx tsx src/cli.ts eval harvest --source opencouncil --signals .eval-signals/signals/s.jsonl
```

The cases hold production content, so they go to `.eval-signals/cases/<suite>/` (gitignored), which every case lookup reads beside `evals/cases`. Only writes a person makes count:

| Signal | Stored as | Why it is a person's |
| --- | --- | --- |
| `decision-link` accept / assign / override | `Decision` with no `taskId`, backed by a `DecisionCandidate` | `assignCandidate` (the decisions page) creates it without a task; the candidate keeps the pipeline's suggestion, so suggestion = subject is an accept, a different subject an override |
| `decision-link` manual | `Decision` with no `taskId` and no suggestion | the decisions PUT route (`upsertDecision`) |
| `decision-link` dismiss | `DecisionCandidate.dismissedAt` | only `dismissCandidate` and the admin conflict dismissal write it |
| `speaker-tag` | `SpeakerTag.personSetBy = 'user'` | `assignSpeaker`, or the 2026-10-02 backfill of tags edited after import |
| `utterance-edit` | `Utterance.lastModifiedBy = 'user'`; `before` from the preceding fixTranscript request | only `editUtterance` writes `'user'` |

Left out: a decision a task made (`taskId` set), one created in the same instant as another (a bulk write), and an admin's reassignment (it keeps the holder's `taskId`, so it cannot be told apart). Deleting a `TaskStatus` nulls its decisions' `taskId`, which would make a task's link look like a person's; that risk is not measured. A person's link marks where the pipeline needed help, so imported matching values are harder than the meeting's other links: read recall on them as recall on the hard cases.

## Monitoring

After each successful non-eval task, the server runs the code detectors of every `confirmed`, `guarded` and `regression` mode over the run. Verdicts go to the archive (`checks/<env>/…`), to Langfuse as boolean scores named by slug on the trace, and to PostHog as `$ai_metric` events named `check:<slug>`, each only when `TELEMETRY_SINKS` names it. Alerts are defined on those in PostHog.

`eval sync --plan` lists the platform objects the monitored modes need (a Langfuse BOOLEAN score config per slug, a PostHog insight `check:<slug>` and alert `check:<slug> alert`, from the structured part of the entry's `alert:` text) against what Langfuse and PostHog hold: create, update, up to date, orphaned, manual. It reads PostHog through HogQL's `system.insights`/`system.alerts`, so a query-scoped key is enough; `--data` also prints the last intervals of each insight's query, before the insight exists.

`eval sync --apply` prints the plan, asks (or takes `--yes`), then writes only what it manages, and a second run has nothing to write:

- **Langfuse**: creates missing score configs. Never updates, archives or deletes one (a config that differs is a manual item).
- **PostHog**: creates insights whose description carries `Managed by eval sync … [eval-sync <fingerprint>]`, and updates them when the registry's query changes; creates and updates the alerts that watch those insights (subscribed: the key's own user). An insight or alert with the name but not the marker is left alone and listed as manual. Needs the key scopes `insight:write` and `alert:write`; a missing scope (preflight) or any 401/403 stops that platform's writes.
- **PostHog destination**: with `DISCORD_ALERT_WEBHOOK` set, one destination, `check alerts → Discord`, posts every firing `check:*` alert to Discord (scope `hog_function:write`). The webhook stays in the environment: only its hash is in the fingerprint. `--test-destination` sends a sample alert through it.
- Nothing is ever deleted: orphaned objects are listed for a person. `--only langfuse|posthog` limits both plan and apply.

The alert is an approximation of the text, printed per item: PostHog compares a period with the one before, not a 30-day baseline; a minimum volume is for the reader to check; whether a city-breakdown alert tests each city is unconfirmed; Langfuse alerts (no API) are set up by hand. Every alert reads the last completed interval, so an "any fail" alert reports within about 70 minutes: PostHog's `check_ongoing_interval` makes it read only the interval still filling up, which misses a fail from earlier in the previous hour.

```bash
npx tsx src/cli.ts eval checks run <traceId> [--all-statuses] [--record] [-v]
npx tsx src/cli.ts eval telemetry verify <traceId> --wait 600   # every call reached Langfuse and PostHog
npx tsx src/cli.ts eval sync --plan [--data]                    # platform mirrors of the registry, read-only
npx tsx src/cli.ts eval sync --apply [--yes] [--only posthog]   # write what eval sync manages
npx tsx src/cli.ts eval sync --plan --test-destination          # a sample alert through the Discord destination
npx tsx src/cli.ts runs call <traceId> '#1' -p request -x       # one call, prompts inlined
```

## Configuration

| Variable | Purpose |
| --- | --- |
| `ARCHIVE_URL` | `s3://bucket` or `file:///path`. Unset, nothing is archived and no responses are stored (a server must not fill its own disk); `eval` commands then default to `archive/` under the data dir. `ARCHIVE_S3_ENDPOINT` / `ARCHIVE_S3_KEY` / `ARCHIVE_S3_SECRET` for S3-compatible storage, falling back to the `DO_SPACES_*` credentials. `scripts/archive-minio.sh start` runs a local MinIO. |
| `TELEMETRY_SINKS` | Comma list of `archive`, `langfuse`, `posthog` (default: all three; each is a no-op without its credentials). |
| `LANGFUSE_*` | See [observability.md](./observability.md). |
| `POSTHOG_PROJECT_TOKEN`, `POSTHOG_HOST` | PostHog ingestion (the `phc_` token). `eval telemetry verify` also needs `POSTHOG_PERSONAL_API_KEY`, `POSTHOG_PROJECT_ID`, `POSTHOG_API_HOST`. |

## Suites

- `decisions.reading` — session date, decision number and body read off page 1. Scoring and labelling conventions: [decision-reading-eval.md](./decision-reading-eval.md).
- `decisions.extraction` — attendance, votes and subject extracted from the minutes. Needs the conventions text production sends (`--hints-file`). Conventions: [decision-extraction-eval.md](./decision-extraction-eval.md).
- `decisions.matching` — a meeting's decision window (its poll request, links hidden) through phase-0 reading, partition and the resolvers. `link[<subjectId>]`: a person's link (`imported`), the task's own or no link (`drafted`); `reject[<ada>]`: a dismissed candidate must not be proposed again. Readings replay from recordings (an unrecorded one is read once); the resolvers stay live. `eval report` prints recall and precision. About $0.1–0.3 per meeting live, resolvers alone ~$0.03.
- `fix.speaker-id` — speaker identification from the transcript text, one meeting per case (`eval cases from-meeting fix.speaker-id <city/meeting | payload.json>`, or harvested). `speaker[<tagId>]`: a reviewer's tag is `imported`, an untouched voiceprint match `drafted`. Variant `params`: `anchor`, `roster`, `chunkChars`; `eval report` prints the backtest tables ([speaker-identification-backtest.md](./speaker-identification-backtest.md)).
- `summarize.contributions`, `summarize.context`, `summarize.e2e` — a case is a recorded summarize run (`replay: <traceId>`; its archived input is the request), cluster = city. `eval cases from-run <suite> <traceId…>` writes one. The phase suites replay the recording with only their own labels live (`contributions:*`, `subject-context-search:*`); `e2e` runs every phase live unless given `--replay --live`. Each subject is scored against the recording's own output (`drafted`) with the `runs compare` verdicts: `identical` and `cosmetic` agree, `structural` disagrees, a lost subject is missing. **These scores measure change against the recording, not correctness**: a structural change can be an improvement, which is what `pairwise` review is for. Cost: replaying everything is free; contributions live is about $0.1–1 per meeting.
- `agenda.extraction` — processAgenda's extraction phase alone (agenda document → items, through `extractAgendaSubjects`; no enrichment runs). Each item, matched by section and number and then by title, is `identical`, `changed` (which of `title`, `number`, `section`, `kind` differ) or missing; `extra` disagrees when the output holds items the recording didn't. The document is downloaded from the request's `agendaUrl` on every run.
- `agenda.context` — processAgenda's subject context search, scored exactly as `summarize.context`; the context failure modes (FM-0001, FM-0002) list both suites, so one detector checks both.
- `fix.transcript` — fixTranscript's text corrections alone (`transcript-fix`, through `correctTranscript`; the speaker identification that reads them is not run). One field per utterance of the request, `utterance[<utteranceId>]`, agreeing only when the output's text equals the expected text once whitespace and Unicode form are normalised; the detail gives the normalised edit distance and whether a miss moved toward the expected text from `before`. A run recorded without a meeting needs `eval cases from-run fix.transcript <traceId> --meeting <cityId/meetingId>`.

All three take their cases from recorded runs (`eval cases from-run`) and replay them with only their own labels live, like the summarize phase suites. **Their expectations are the recording's own output, tier `drafted`: change against the recording, not correctness**, and their gates print `NEEDS_REVIEW` until human-tier holdout cases exist.

### What's needed for gate-grade cases

`evals/gates/agenda.extraction.yaml` and `evals/gates/fix.transcript.yaml` are only meaningful once each suite has at least five holdout cases carrying human-tier values (`minHumanHoldoutCases: 5`). Those values come from people's corrections in opencouncil, imported as `imported` expectations with `by`, `at`, `source` and `signal` (the opencouncil signal source, S5):

| Suite | opencouncil signal | Becomes |
| --- | --- | --- |
| `fix.transcript` | `UtteranceEdit` rows with `editedBy = 'user'`: `beforeText` → `afterText` of one utterance, by `userId` | `utterance[<utteranceId>]` = `{ text: afterText, before: beforeText }`, tier `imported`, `by` the user, `at` the edit's `createdAt`, `signal` the edit id. Only edited utterances carry it; the rest of the case stays `drafted`. Rows with `editedBy = 'task'` are the task's own output and never count. A forced re-transcribe deletes edit history, and the segment editor writes no `UtteranceEdit` yet, so edits made there are invisible. |
| `agenda.extraction` | Subjects a person edited, added or deleted after processAgenda wrote them (`agendaItemTitle`, `agendaItemIndex`, `agendaSectionIndex`/`Title`) | `item[<position> <title>]` = the edited item (`{ number, section, title, kind, name }`), tier `imported`; a deleted item drops out and a person-added one becomes a new expected item, so `extra` and missing are judged against people's list. **opencouncil records no provenance for subject edits today** (`Subject` has only `updatedAt`, no editor, no before/after), so there is no signal to import yet: it needs a subject-edit record (who, when, before, after) in opencouncil first. Until then this suite's truth comes from review batches over the agenda PDFs. |

A case keeps its recorded run as the replay cassette either way: the request is the run's archived input, and only the expectations change tier. The case schema already takes these values (a unit test drives a synthetic imported `UtteranceEdit` through `compare` and the checked-in gate).
