# Speaker Identification Backtest

Without voiceprints, diarization tells us that all "speaker 3" lines are the same voice but not whose. Council transcripts carry that information in the text: the chair gives the floor by name, people answer the roll call, replies are addressed by name or role. `identifySpeakers()` in `src/lib/speakerIdentification.ts` asks the model to read those cues and name each speaker from the city's roster.

This command backtests that pass on meetings a human has already reviewed. It compares the model with the voiceprint matching the meeting had at import, using the reviewed record as the answer key for both.

## What the pass acts on

For every speaker it names, the model also says what kind of evidence the name rests on:

| Kind | The cue |
| --- | --- |
| `named` | The speaker is given the floor by name, right before they speak. |
| `rollCall` | A name is read out and the speaker answers. |
| `selfIntroduced` | The speaker states their own name or role. |
| `addressed` | Others address the speaker by name or role title. |
| `roleBehaviour` | Only what the speaker does: chairs, answers as the executive. No name or title is spoken. |

The pass decides for itself which names it acts on (`isActionable` in `src/lib/speakerIdentification.ts`): a name resting on any kind except `roleBehaviour`, on a label no rival candidate contests across chunks. Every other name is returned marked as not actionable, for a reviewer to use as a suggestion. The model's 0–100 confidence travels along for the reviewer to read. Nothing thresholds it: opencouncil compares identities, as it does for voiceprint matches.

The decision lives next to the prompt and the model on purpose. Change either, run this backtest, and read the evidence table before touching `ACTIONABLE_EVIDENCE_KINDS`.

Command: `backtest-speaker-identification` in `src/cli.ts`
Helpers: `src/tasks/utils/speakerBacktest.ts`

## Run it

```bash
npx tsx src/cli.ts backtest-speaker-identification athens/sep14_2026 chania/aug5_2026 --summary-only
```

Each meeting is fetched from opencouncil's public meeting endpoint. Pass a file path instead to read a saved copy of that JSON. With more than one meeting, a table at the end shows each meeting and the total.

| Option | Purpose |
| --- | --- |
| `--anchor none` (default) | Hide every stored identity. This is the no-voiceprint case. |
| `--anchor voiceprint` | Hand the untouched voiceprint matches to the model as known. |
| `--min-confidence <n>` | Score a bare confidence threshold instead of the pass's own decision. For comparison only. |
| `--model <id>` | Model to call. |
| `--effort <level>` | How much the model thinks: `low`, `medium`, `high`, `xhigh` or `max`. Run the same meetings at two levels to choose `DEFAULT_IDENTIFICATION_EFFORT`. |
| `--chunk-chars <n>` | Transcript characters per model call. Long meetings are read in contiguous chunks and the answers merged. |
| `--skip-cache` | Answers are cached per meeting, anchor mode, model, effort, chunk size and the content shown to the model, so a meeting that changed at the same URL is identified again. Pass this after a prompt change. |
| `--dry-run` | Print the exact prompts that would be sent and exit. No model call. |
| `--summary-only` | Skip each meeting's per-person table. The wrong names are still listed. |
| `-O, --output-file <file>` | Write every meeting's scored tags, raw answers and summary as JSON. |
| `--base-url <url>` | Another opencouncil instance. |

## Terms

- **Roster.** Everyone opencouncil has a person record for in the city: mayor, deputy mayors, council and community council members, officials. These are the only names the model may answer with, and the only people a speaker tag can link to.
- **Speaker tag.** A stretch of the transcript attributed to one voice. Reviewers split tags freely, so one person can end up as many tags. The stats therefore never count tags.
- **Off-roster speaker.** Someone with no person record, such as a resident or an employee. A reviewer can only give them a typed label.

## What the record says about each tag

| Source | How it is recognised |
| --- | --- |
| Voiceprint | The tag has the pipeline's `SPEAKER_N` label and a person, and was never edited after import. |
| Voiceprint, corrected | A `SPEAKER_N` tag whose `updatedAt` is later than its `createdAt`: a reviewer changed the matched person. |
| Voiceprint, removed | A `SPEAKER_N` tag with no person, in a meeting imported since 2025-12-16. From then on the import only writes that label for a match, so a reviewer removed it. |
| Reviewer | Linked to a person under any other label. |
| Off roster | No person, and a label a reviewer typed. |
| Unidentified | No person, and a placeholder label: `Άγνωστος Ομιλητής N` or the editor's `New ...`. |

## Reading the report

Each meeting prints one row per roster person who spoke, then the off-roster speakers, then every wrong or unchecked name with the model's evidence, then a summary with three columns:

- **Voiceprints:** the matches made at import.
- **Model:** the names the pass acts on. With `--min-confidence`, the names at or above that confidence instead.
- **Voiceprints, then model:** voiceprints where they matched at import, the model for everyone else. This is what production would show in a city that has voiceprints.

| Line | Meaning |
| --- | --- |
| Roster people named | People with at least one tag the method named correctly. |
| Their speaking time named | Speaking time of the tags named correctly, over all roster speaking time. |
| Wrong names | Tags named against the record, out of all names the method gave. For voiceprints: matches a reviewer later changed or removed. For the model this includes roster names on off-roster speakers. |
| Share of named time wrong | The wrong names' speaking time, over all speaking time the method put a name on. Fairer than the count, since reviewers split tags. |
| Roster speech left to review | Roster speaking time the method did not name correctly: what a reviewer still has to link or fix. |
| Names nobody can check | Names given to speakers nobody identified. |

Below the summary:

- **Roster people found** by both methods, by one only, or by neither.
- **Model on voiceprint matches:** where both answered, whether they agreed, and when they disagreed, which one the reviewer backed. Removed matches are left out, since the true person is unknown.
- **Roster speech the model missed,** split into no answer, held back but right, and held back and wrong. A held-back name is one the pass returned but does not act on. A lot of correct held-back names means the pass is too strict.

With several meetings, a table shows each meeting and the total, with an estimated cost for the run that produced each meeting's answers. It uses list prices.

At the end come two tables that score the same answers again. Neither needs a model call.

- **Evidence.** One row per kind of evidence: the names that rest on that kind and are not contested, scored alone. Then contested labels, then what the pass acts on. A kind belongs in `ACTIONABLE_EVIDENCE_KINDS` only while its share of named time that is wrong stays low.
- **Confidence thresholds.** What a bare threshold of 50, 60, 70, 80 or 90 would do with the same answers, whatever their evidence. The pass does not use one. The table is there to compare against the evidence table.

The figures in both tables come from the meetings they are computed on. A bar chosen from a table is flattered by that same table: check it on meetings that played no part in the choice.

Across meetings a person counts once per meeting.

## Limits

- **Voiceprint errors can only be measured for meetings imported since 2025-12-16.** Before that, the import labelled every speaker `SPEAKER_N`, matched or not. For those meetings an untouched `SPEAKER_N` tag with a person still counts as a voiceprint match, and nothing counts as a voiceprint error.
- **Meetings processed since speaker hints shipped are read through `personSetBy`.** There `fixTranscript` writes its hint onto the tag, which moves `updatedAt` without any reviewer involved, so timestamps mean nothing. A person only the transcript hint assigned is never used as the answer key.
- **With `--anchor voiceprint`, anchored speakers are left out of the model's numbers.** They were given to the model, not found by it.

- **Reviewers are the answer key.** A wrong name that no reviewer noticed counts as correct for whichever method gave it.
- **Voiceprint errors on off-roster speakers are only partly visible.** If a reviewer removes the match and also types a label, the tag no longer looks like a voiceprint match.
- **A no-op edit looks like a correction.** A reviewer who re-selects the same person on a voiceprint tag moves `updatedAt`.
- **The model's input is cleaner than production.** Speech is grouped by the reviewed tags rather than raw diarization, which flatters the model's coverage. Its wrong-name count is not affected.
