# Speaker Identification Backtest

Without voiceprints, diarization tells us that all "speaker 3" lines are the same voice but not whose. Council transcripts carry that information in the text: the chair gives the floor by name, people answer the roll call, replies are addressed by name or role. `identifySpeakers()` in `src/lib/speakerIdentification.ts` asks the model to read those cues and name each speaker from a roster of people.

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

The pass decides for itself which names it acts on (`isActionable` in `src/lib/speakerIdentification.ts`). A name must rest on any kind except `roleBehaviour`, on a label no rival candidate contests across chunks, at a confidence of 75 or more (`MIN_ACTIONABLE_CONFIDENCE`). Every other name is returned marked as not actionable, for a reviewer to use as a suggestion. The model's 0–100 confidence travels along for the reviewer to read. Nothing outside this task thresholds it: opencouncil compares identities, as it does for voiceprint matches.

The floor is there because the kind alone does not carry the model's doubt. When a cue is real but may point at someone else, such as a surname two people share or a reply that may have come from another voice, the model keeps the kind, lowers the number and says so in its note.

The decision lives next to the prompt and the model on purpose. Change either, run this backtest, and read the evidence table before touching `ACTIONABLE_EVIDENCE_KINDS`, and the threshold table before touching `MIN_ACTIONABLE_CONFIDENCE`. The 75 was chosen on the meetings it was measured on, so it flatters itself, and it belongs to this prompt and this model.

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
| `--roster meeting` (default) | The model may answer with the people who may speak at the meeting, as in production. |
| `--roster city` | The model may answer with everyone in the city. |
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

- **Roster.** The people the model may answer with. By default these are the people who may speak at the meeting, which is what opencouncil sends `fixTranscript`: the members of the body that is meeting, the municipal council, city-level roles (mayor, deputy mayors, general secretary), community heads and people with no body. `--roster city` hands it everyone opencouncil has a person record for in the city instead.
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
- **Both, reconciled:** the two methods put together the way opencouncil does it. Where both name the same person, or only one names anyone, that name; where the voiceprint matched and the model would act on a different person, nobody. This is what production would show in a city that has voiceprints. For a match a reviewer later corrected or removed, the record no longer holds who the voiceprint named: when the model names the reviewer's person, the two disagreed and the speaker is withheld; every other case counts as the voiceprint's wrong name published, which is the upper bound.

| Line | Meaning |
| --- | --- |
| Roster people named | People with at least one tag the method named correctly. |
| Their speaking time named | Speaking time of the tags named correctly, over all roster speaking time. |
| Wrong names | Tags named against the record, out of all names the method gave. For voiceprints: matches a reviewer later changed or removed. For the model this includes roster names on off-roster speakers. |
| Share of named time wrong | The wrong names' speaking time, over all speaking time the method put a name on. Fairer than the count, since reviewers split tags. |
| Roster speech left to review | Roster speaking time the method did not name correctly: what a reviewer still has to link or fix. |
| Names nobody can check | Names given to speakers nobody identified. |
| Withheld, the methods disagree | Speakers the reconciled column leaves unnamed because the methods named different people. A reviewer is alerted to these. |

Below the summary:

- **Roster people found** by both methods, by one only, or by neither.
- **Model on voiceprint matches:** where both answered, whether they agreed, and when they disagreed, which one the reviewer backed. Removed matches are left out, since the true person is unknown.
- **Roster speech the model missed,** split into no answer, held back but right, and held back and wrong. A held-back name is one the pass returned but does not act on. A lot of correct held-back names means the pass is too strict.

With several meetings, a table shows each meeting and the total, with an estimated cost for the run that produced each meeting's answers. It uses list prices.

A meeting where a chunk of the transcript got no answer is listed as failed and left out of every table: its missing speakers would count as missed. Nothing is cached for it, so running it again asks the model again.

At the end come two tables that score the same answers again. Neither needs a model call.

- **Evidence.** One row per kind of evidence: the names that rest on that kind and are not contested, scored alone. For a kind the pass acts on, those are the names at a confidence of 75 or more. Then `under 75`, the names on those kinds that the confidence floor holds back, then contested labels, then what the pass acts on. A kind belongs in `ACTIONABLE_EVIDENCE_KINDS` only while its share of named time that is wrong stays low, and the floor earns its place only while the `under 75` row is wrong more often than the rows above it.
- **Confidence thresholds.** What a bare threshold of 50, 60, 70, 80 or 90 would do with the same answers, whatever their evidence. The pass acts on the kind of evidence with a floor on the confidence, not on a bare threshold. The table is there to compare against the evidence table.

The figures in both tables come from the meetings they are computed on. A bar chosen from a table is flattered by that same table: check it on meetings that played no part in the choice.

Across meetings a person counts once per meeting.

## Limits

- **Voiceprint errors can only be measured for meetings imported since 2025-12-16.** Before that, the import labelled every speaker `SPEAKER_N`, matched or not. For those meetings an untouched `SPEAKER_N` tag with a person still counts as a voiceprint match, and nothing counts as a voiceprint error.
- **A tag that records who set its person is read through `personSetBy`.** An automatic pass moves `updatedAt` without any reviewer involved, so there the timestamps mean nothing. A person only the transcript hint assigned is never used as the answer key. A tag with no recorded source is read from its label and timestamps as above: that is every tag of an earlier meeting that no reviewer edited, an import's voiceprint match included.
- **With `--anchor voiceprint`, anchored speakers are left out of the model's numbers.** They were given to the model, not found by it.

- **The roster rule is a copy.** `maySpeakAtMeeting` in `speakerBacktest.ts` repeats opencouncil's rule of the same name, from the roles the public meeting endpoint returns. If opencouncil's rule changes, this one has to follow. Each meeting's header says how many of the city's people are on the roster, and how much recorded speech belongs to people it leaves out.
- **Reviewers are the answer key.** A wrong name that no reviewer noticed counts as correct for whichever method gave it.
- **Voiceprint errors on off-roster speakers are only partly visible.** If a reviewer removes the match and also types a label, the tag no longer looks like a voiceprint match.
- **A no-op edit looks like a correction.** A reviewer who re-selects the same person on a voiceprint tag moves `updatedAt`.
- **The model's input is cleaner than production.** Speech is grouped by the reviewed tags rather than raw diarization, which flatters the model's coverage. Its wrong-name count is not affected.
- **The text is corrected text.** The public endpoint returns the transcript after the task's corrections and the reviewers' edits. In production the identification reads the task's corrected text, which is close. A segment whose correction failed keeps its raw text, and the identification reads that segment as transcribed. The raw text survives only in `UtteranceEdit`, so a backtest on it would have to read the database.
- **The corrector is not told who is speaking.** Until this change the correction prompt carried the name the speaker tag pointed to, on a first run usually the voiceprint match, and a corrector told that name could resolve a garbled self-introduction toward it, so the identification reading the corrected text would confirm the guess it was meant to check. The line is gone: the corrector sees the roster and the agenda only. Measured before removing it (2026-10-06) on a staging meeting of 12 speakers, 7 of them linked by a reviewer, by correcting the raw text with their real name, with another linked speaker's name on every one of them, and with no name at all: each run differed from the stored run on 35–37 of their 852 utterances and from each other by 27–42, the model's own variation; the told name never entered a speaker's text; the garbled surnames in their segments were recovered from the roster the same way in every run; and the hints were the same two actionable names, both right. So on that meeting the name bought nothing. Nobody there says their own name, so the self-introduction case, the one the name could decide, is not covered, which is why the line is gone rather than measured further.
