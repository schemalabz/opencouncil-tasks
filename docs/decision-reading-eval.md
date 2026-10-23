# Decision Reading Evaluation

`pollDecisions` must read two facts out of a Diavgeia decision PDF: the date of the session that produced it, and the decision number the document carries. A wrong read attaches a decision to the wrong meeting. This document explains how the `decisions.reading` cases label the correct answers and how the suite scores the reader against them. The pipeline around it — runs, comparisons, gates — is in [evals.md](./evals.md).

Reader: `readDecisionDocument()`
Cases: `evals/cases/decisions.reading/` (one file per document)
Suite: `src/evals/suites/decisionsReading.ts`

## Run the evaluation

```bash
npx tsx src/cli.ts eval run decisions.reading --variant production --split dev
npx tsx src/cli.ts eval compare decisions.reading <runA> <runB>
```

`--limit` and `--case` narrow the run; `--reps` takes repeated fresh reads. Readings land in the response store, so `eval run --replay` rescores a recorded run for free after a scorer change.

## What a case contains

Each case holds the document (`input.ada`, `input.pdfUrl`) and one expectation per field: `meetingDate`, `decisionNumber`, `body`, and `kind`. The cluster is `city/body`, the unit the comparison's bootstrap resamples. The cases were converted from the golden fixture (`fixture:decision-reading-golden@v3`, removed from the tree once the suite reproduced its scores); all 11 supported Greek municipalities are present. Demo cities outside the Diavgeia realm (`nis`, `rennes`, `vouli`) are out of scope.

## What the suite scores

The suite scores three fields per document, not one.

**1. Session date** — compares the read `meetingDate` against `expected.meetingDate`.

| Outcome | Meaning |
| --- | --- |
| `agree` | The read date matches the label. |
| `disagree` | The read date is wrong. |
| `unread` | The reader returned no date for a decision. |
| `unadjudicated` | The document has no label yet. |

**2. Decision number** — compares the read `decisionNumber` against `expected.decisionNumber`. `sameDecisionNumber()` does the comparison, so `120/2026` and `120` can match. Outcomes are `number-agree`, `number-disagree`, `number-missing` and `number-unlabelled`.

**3. Administrative body** — compares the read body against the case's `body` expectation. `sameBody()` does the comparison. Outcomes are `body-agree`, `body-disagree`, `body-missing` and `body-unlabelled`.

Documents that belong to no tracked body carry no `body` expectation, so the body check is skipped for them.

## The `kind` field inverts the date check

A document with `kind: "other"` is not a deliberative session decision. The reader must return no session date for it. The suite inverts the date check for these documents:

| Read result | Outcome |
| --- | --- |
| No date | `true-negative` — correct |
| A date | `false-positive` — the reader invented a session |

This is how the suite tests that the reader rejects documents it must not read.

## Labels and their tiers

Every expectation carries a tier, who set it, and when ([evals.md](./evals.md#truth-tiers)). The fixture's `verified: true` labels became `adjudicated`, the rest `drafted`. Set `adjudicated` only after you read page 1 of the document yourself.

## Add a document

The suite tests reading. Add a document only when its page 1 can break the reader in a way that no document in the set already covers. Documents that repeat a layout already present make the suite slower and more expensive, and they fail together with the documents they duplicate.

Good reasons to add a document:

- The page prints the decision number in a format the set does not contain.
- The page carries more than one date, and only one is the session date.
- The body is new to the cases, or the municipality changed its template.
- The document is not a session decision, and the reader must return no date. Give it `kind: "other"`.

A different session type is not by itself a reason. Chania holds regular, extraordinary and `Διά Περιφοράς` sittings, but all three print the date in the same position, so one document covers all of them.

## What the cases do not do

Nothing scores the `notes` a case carries. Notes are prose for people and for agents. No test enforces them.

The cases also have no concept of a session. It answers "does the reader extract the right values from this PDF". It cannot express "this session took place and we hold no meeting for it". Session-level gaps need a different structure.

It holds no Diavgeia unit ids either. Unit ids decide which documents we collect; these cases score how we read a document we already hold. Two sources own the collection side: `AdministrativeBody.diavgeiaUnitIds` is what `pollDecisions` queries, and the `opencouncil-seed-data` extract lists every unit of all 337 municipalities with publication counts.

## Score one body against its links

Every decision already linked to a meeting asserts which session produced it — a free second source of labels, at the scale of a whole body. The old `evaluate-decision-reading` command scored opencouncil's per-body export (`scripts/export-decision-reading-eval.ts`, now removed) directly. opencouncil's link signals (`scripts/export-eval-signals.ts`) now feed `decisions.matching`; turning a person's link into a reading case is not built yet. A disagreement against a link is ambiguous by design: read the document to find out which side is wrong before you change anything.
