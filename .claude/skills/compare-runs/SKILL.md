---
name: compare-runs
description: Compare two traced summarize runs from Langfuse and produce a qualitative evaluation of how subjects, descriptions, and speaker contributions changed.
argument-hint: "<cityId/meetingId> [traceA traceB]"
allowed-tools: Bash, Read
---

# SKILL: Compare Summarize Runs

Compare two traced summarize runs and evaluate whether the differences are improvements, regressions, or generation noise. Use after re-running summarize on a meeting (e.g. to evaluate a prompt or pipeline change).

Requires `LANGFUSE_*` env vars in `.env` (see [docs/observability.md](../../../docs/observability.md)).

## Phase 1: Generate the comparison

```bash
npm run cli -- runs compare --meeting <cityId/meetingId>     # two most recent successful runs
npm run cli -- runs compare <traceA> <traceB>                # or explicit trace IDs
```

This writes `data/comparisons/compare-<meeting>-<a>-<b>.{json,html}` and prints a per-subject verdict summary (`identical` / `cosmetic` / `structural`).

Interpret the verdict summary first:
- **Mostly cosmetic/identical** → the runs differ only by generation variance. If the user was testing a prompt change, that change had no behavioral effect. Say so and stop unless asked to dig deeper.
- **Structural verdicts present** → these are the subjects worth evaluating. Continue.

Check the runs' `prompts:` fingerprints (shown by `runs list --meeting <...>`): identical fingerprints mean any difference is pure generation variance — the noise floor.

Tell the user: where the HTML is (open in browser; Review Mode with ←/→ for skimming).

## Phase 2: Qualitative evaluation

The comparison JSON can be large (hundreds of KB for big meetings) — do NOT read it whole. Extract a summary first:

```bash
node -e '
const d = JSON.parse(require("fs").readFileSync("<json path>", "utf8"));
console.log(JSON.stringify({
  sources: d.sources, stats: d.stats, verdictSummary: d.verdictSummary,
  matched: d.subjects.matched.map(m => ({ idx: m.agendaItemIndex, matchedBy: m.matchedBy, verdict: m.verdict, name: m.from.name.slice(0,80), changes: m.changes })),
  fromOnly: d.subjects.fromOnly.map(s => ({ name: s.name, reason: s.nonAgendaReason })),
  toOnly: d.subjects.toOnly.map(s => ({ name: s.name, reason: s.nonAgendaReason })),
}, null, 2))'
```

Then, for each `structural` subject (and the largest `cosmetic` ones if few structural), extract its full data with a targeted node one-liner (filter `d.subjects.matched` by index) and analyze:

- **Description**: what information was added, removed, or rephrased? Quote specific phrases (Greek is fine). Did the new version gain concrete facts (amounts, dates, names) or lose them?
- **Contributions**: per shared speaker, did the position/references (votes, proposals, objections) get more or less precise? Note added/removed speakers and whether their content was lost or absorbed elsewhere.
- **Utterance assignment**: shifts >20% mean discussion boundaries moved — check whether a neighboring subject absorbed them.
- **Verdict per subject**: better, worse, or trade-off — with the *why*.

Also check `fromOnly`/`toOnly` leftovers for semantic correspondence the name-matching missed (renames with little token overlap), and `segmentSamples` for summaries that became null or changed type.

## Phase 3: Overall verdict

Structured markdown, to the terminal:

- **Better / Mixed / Worse / Noise** (Noise = identical config, differences within expected variance)
- Top improvements and top regressions, each with specific subject references and quoted evidence
- Confidence: high / medium / low

## Notes

- `matchedBy: "name"` entries indicate the agenda classification flipped between runs — always report these; classification stability is a known weak point.
- For comparisons against **database state** (ingestion bugs, runs predating Langfuse), use the `/compare-summarize` skill in the opencouncil repo instead.
