---
name: eval
description: Evaluate a model or prompt change, investigate a quality alert, triage a "this output is wrong" report, or grow the case set for an opencouncil-tasks LLM task. Use for any question of the form "is this better/worse/broken?" about task output.
argument-hint: "<evaluate|alert|sighting|grow> [details or issue link]"
allowed-tools: Bash, Read, Edit, Write
---

# SKILL: Evaluation playbooks

Read [docs/evals.md](../../../docs/evals.md) first: tiers, suites, variants, gates, failure modes. All commands are `npx tsx src/cli.ts …` inside `nix develop`. Set `--budget-usd` on every live command and report spend.

## Never

- Merge, push or deploy. A PR with the gate result is where you stop.
- Write `adjudicated` or `imported` values by hand. They come from `eval review apply` or harvested signals only.
- Look at per-case holdout outputs while iterating (`compare` hides them; don't pass `--show-holdout` until the final gate).
- Downgrade a tier without writing why.
- Judge a change from one run. Compare runs of a suite.

## Evaluate a change (model, prompt, code path)

1. Write the variant: `evals/variants/<name>.yaml` with per-label overrides, or a prompt/code change on a branch.
2. Iterate on dev, cheaply: `eval run <suite> --variant production --split dev --reps 2` once, then your variant. For one phase, run its suite (`summarize.contributions`, `summarize.context`, `agenda.extraction`, `agenda.context`, `fix.transcript`) with `--split all`: it replays the recorded meetings with only that phase live (`--replay --no-live` checks the plumbing for $0). Its scores are change against the recording, so follow a structural difference with `eval review build pairwise`.
3. `eval compare <suite> <runA> <runB>`. Read the clusters, not only the totals: a significant change concentrated in one body is a finding about that body.
4. Final: both variants on `--split all`, then `eval gate`. PASS → open a PR containing the gate output, the cost per attempt, and the compare table. FAIL → report which fields and clusters, and stop.

**Ends at:** human merges the PR.

## Investigate an alert (a `check:<slug>` fire rate moved)

1. `eval harvest --source monitoring --env production --since 14`, then `eval candidates --signal check:<slug>`.
2. Read each occurrence with `runs call <traceId> <label> -x`. Group them: the same mode, a neighbouring mode, or a false alarm.
3. Real occurrences: reproduce them as failing dev cases (or detector cases), then fix via *Evaluate a change*.
4. False alarms: `eval review build mode-examples --signal check:<slug>`. The person's "no" answers become `known-false-alarm` detector cases.
5. Alert definitions drifted? `eval sync --plan` (read-only). Never create platform objects yourself; list them for the person.

**Ends at:** a review batch (if labels are drafted) or a PR.

## Triage a sighting ("this is wrong" + a link)

1. Find the run: `runs list --meeting <city/meeting> --task all`, then `runs show` and `runs call`.
2. Dedupe against `evals/failure-modes/`. A match → add the occurrence as a detector case candidate and stop.
3. New mode → sweep the archive for siblings (high recall): write the detector (code first, `src/evals/checks/`) and run `eval checks backfill <slug> --since 90 --env production`. Run `eval archive import-langfuse` first if the archive lacks the history.
4. Write the `FM-xxxx` entry with `status: candidate`, its definition and boundary; report the backfill rate (never store it in the entry). `eval calibrate <slug>` for TPR/TNR. Then `eval review build mode-examples` from the occurrences.

**Ends at:** the person reviews the batch and merges the entry PR (= confirmed).

## Grow the case set

1. `eval harvest <suite> --source disagreement --run <runId>` over recent suite runs, and `eval harvest --source novelty --dry-run` for cities, bodies and number layouts no case covers. For `decisions.matching` and `fix.speaker-id`, `eval harvest --source opencouncil --signals <file>` turns an export of people's corrections into `imported` cases (docs/evals.md, *Imported truth*).
2. `eval review build label-confirm --suite <suite>`. Splits are assigned on apply; never choose them.
3. After the person submits: `eval review apply <batchId>`, `eval lint`, then a PR with the printed body.

**Ends at:** the person reviews the batch.

## Handoffs

`eval status` lists everything waiting on a person. Resume an `open` batch only after it reads `submitted`.
