# Decision Reading Evaluation

`pollDecisions` must read two facts out of a Diavgeia decision PDF: the date of the session that produced it, and the decision number the document carries. A wrong read attaches a decision to the wrong meeting. This document explains the golden fixture that labels the correct answers, and the CLI command that scores the reader against it.

Reader: `readDecisionDocument()`
Fixture: `fixtures/decision-reading-golden.json`
Command: `evaluate-decision-reading` in `src/cli.ts`

## Run the evaluation

```bash
npx tsx src/cli.ts evaluate-decision-reading fixtures/decision-reading-golden.json
```

| Option | Purpose |
| --- | --- |
| `-c, --concurrency <n>` | Parallel document reads. The default is 4. |
| `-l, --limit <n>` | Read only the first N documents. Use this to control cost. |
| `--skip-cache` | Ignore cached reads. The command calls the model again. |
| `-O, --output-file <file>` | Write per-document results as JSON, for adjudication. |

The command reads every document in the file, compares the result against the labels, and prints the model usage. Reads are cached, so a second run over the same documents is cheap. Add `--skip-cache` when you change the reader and you want fresh reads.

The command also accepts a per-body export file. See [Score one body against its links](#score-one-body-against-its-links).

## What the fixture contains

The fixture groups documents per city, then per administrative body.

```
cities[]
  cityId, orgUid          orgUid is optional; some cities omit it
  bodies[]
    name          the administrative body; this is also a label (see below)
    unitIds       the Diavgeia unit ids that publish for this body
    notes         publishing behaviour on Diavgeia, for human readers
    documents[]
      ada, pdfUrl
      kind        "decision" or "other"
      expected    { meetingDate, decisionNumber }
      verified    true = a person confirmed the labels
      notes       why this document is in the set, when that is not obvious
  otherDocuments[]   documents of the city that belong to no tracked body (optional)
  bodiesNotCovered[] bodies the fixture leaves out, with the reason (optional)
```

All 11 supported Greek municipalities are present. Demo cities outside the Diavgeia realm (`nis`, `rennes`, `vouli`) are out of scope.

## What the command scores

The command scores three fields per document, not one.

**1. Session date** — compares the read `meetingDate` against `expected.meetingDate`.

| Outcome | Meaning |
| --- | --- |
| `agree` | The read date matches the label. |
| `disagree` | The read date is wrong. |
| `unread` | The reader returned no date for a decision. |
| `unadjudicated` | The document has no label yet. |

**2. Decision number** — compares the read `decisionNumber` against `expected.decisionNumber`. `sameDecisionNumber()` does the comparison, so `120/2026` and `120` can match. Outcomes are `number-agree`, `number-disagree`, `number-missing` and `number-unlabelled`.

**3. Administrative body** — compares the read body against the `bodies[].name` that the document sits under. The grouping is the answer key. `sameBody()` does the comparison. Outcomes are `body-agree`, `body-disagree`, `body-missing` and `body-unlabelled`.

Documents under `otherDocuments` carry no body label, so the command skips the body check for them.

## The `kind` field inverts the date check

A document with `kind: "other"` is not a deliberative session decision. The reader must return no session date for it. The command inverts the date check for these documents:

| Read result | Outcome |
| --- | --- |
| No date | `true-negative` — correct |
| A date | `false-positive` — the reader invented a session |

This is how the fixture tests that the reader rejects documents it must not read.

## Labels and the `verified` flag

`verified: true` means a person opened the PDF and confirmed the labels. `verified: false` means the labels are trusted but nobody reviewed them. The command reports this as the `provenance` of each row, so you can tell a real disagreement from an unreviewed label.

Set `verified: true` only after you read page 1 of the document yourself.

## Add a document to the fixture

The fixture tests reading. Add a document only when its page 1 can break the reader in a way that no document in the set already covers. Documents that repeat a layout already present make the suite slower and more expensive, and they fail together with the documents they duplicate.

Good reasons to add a document:

- The page prints the decision number in a format the set does not contain.
- The page carries more than one date, and only one is the session date.
- The body is new to the fixture, or the municipality changed its template.
- The document is not a session decision, and the reader must return no date. Give it `kind: "other"`.

A different session type is not by itself a reason. Chania holds regular, extraordinary and `Διά Περιφοράς` sittings, but all three print the date in the same position, so one document covers all of them.

## What the fixture does not do

The command never reads the `notes` fields. Notes are prose for people and for agents. No test enforces them.

The fixture also has no concept of a session. It answers "does the reader extract the right values from this PDF". It cannot express "this session took place and we hold no meeting for it". Session-level gaps need a different structure.

## Score one body against its links

The golden fixture is small and hand-labelled. A second source of labels costs nothing: every decision already linked to a meeting asserts which session produced it. If the reader then names a different session, either the reading or the link is wrong. Both are worth knowing.

The exporter lives in the `opencouncil` repository, because it needs database access. The scorer lives here. The pipeline crosses the two repositories:

```bash
# in opencouncil
npx tsx scripts/export-decision-reading-eval.ts --body <administrativeBodyId> --out /tmp/eval.json

# in opencouncil-tasks
npx tsx src/cli.ts evaluate-decision-reading /tmp/eval.json
```

The export contains one administrative body. It labels each document with the meeting date of the meeting its link points to, converted to the city's local timezone. The command marks these rows `from-link`, not `verified`.

Use the two sources for different jobs:

| | Golden fixture | Per-body export |
| --- | --- | --- |
| Size | every body-labelled document plus the `otherDocuments`, all 11 cities | Every linked decision of one body |
| Labels | Manual review | Existing links, free |
| Scores | Date, number and body | Date and body |
| Use it to | Catch a reader regression across municipalities | Measure the reader at scale on one body |

A disagreement in the export is ambiguous by design. Read the document to find out which side is wrong before you change anything.
