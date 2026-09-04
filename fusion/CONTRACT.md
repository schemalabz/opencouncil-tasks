# fusion/ contract (frozen 2026-09-02)

Three-system ASR fusion. Python side (this dir, stdlib-only, python3 ≥3.11) does
alignment + island rules; TypeScript side (`src/lib/fusion/`) does provider
orchestration, timing, transcript assembly. The boundary is one subprocess call:

```
python3 fusion/fuse.py   # stdin: oc-fusion-in/1 JSON, stdout: oc-fusion/1 JSON
```

Non-zero exit ⇒ caller must treat the segment as fusion-failed (Scribe fallback).
Diagnostics go to stderr, never stdout.

## Input `oc-fusion-in/1`

```json
{
  "schema": "oc-fusion-in/1",
  "audio_sha256": "…",
  "systems": [
    {"id": "scribe", "params_sha": "…", "words": [{"raw": "Επιτροπή,", "start": 820.11, "end": 820.63, "conf": 0.91}]},
    {"id": "soniox", "params_sha": "…", "words": [{"raw": "επιτροπής", "start": 820.13, "end": 820.66, "conf": 0.44}]},
    {"id": "ours",   "params_sha": "…", "words": [{"raw": "επιτροπή",  "start": 820.10, "end": 820.62, "conf": 0.88}]}
  ],
  "config": {
    "arm": "rules",            // "W" | "rules" | "policy"
    "guard": true,             // ναι/δεν guard (rules_on)
    "llm": null,               // {"model": "..."} only when arm=policy AND caller enabled it
    "chunking": {              // optional; omitted ⇒ fusion/chunking defaults
      "max_tokens": 800, "anchor_n": 3, "search_radius": 200
    }
  }
}
```

- `systems` order is fixed: scribe, soniox, ours. All three must be present.
- `words[].raw` is the provider's raw word (may normalize to 0..n tokens).
- `start`/`end` seconds, `conf` in [0,1] or null. Python never uses times except
  to echo provenance; timing is TS's job.

## Output `oc-fusion/1`

```json
{
  "schema": "oc-fusion/1",
  "audio_sha256": "…",
  "config": {"arm": "rules", "guard": true, "policy_sha": "3e5676d982078979",
             "llm_envelope_sha": null, "code_rev": "…", "normalizer_rev": "…",
             "chunking": {"…": "echoed effective config", "n_chunks": 1, "forced_cuts": 0},
             "components": {"scribe": "<params_sha>", "soniox": "…", "ours": "…"}},
  "tokens": [
    {"i": 0, "text": "Επιτροπή,", "norm": "επιτροπη", "src": "scribe",
     "src_word": 0, "col": 3140, "island": null, "stage": "agree",
     "agreement": 1.0, "alternatives": null}
  ],
  "islands": [
    {"id": "isl_207", "cols": [3141, 3141], "category": "PAIR_soniox+ours|ATOMIC",
     "candidates": {"scribe": ["επιτροπης"], "soniox": ["επιτροπη"], "ours": ["επιτροπη"],
                    "vote": ["επιτροπη"], "r12": ["επιτροπης"]},
     "stage": "rule", "rule": "ψήφος", "chosen_src": "soniox",
     "guard_fired": false, "llm": null}
  ],
  "dropped": [{"island": "isl_300", "src": "soniox", "text": "να πούμε κι εμείς", "rule": "R1"}],
  "stats": {"n_tokens": 0, "n_islands": 0, "by_category": {}, "by_stage": {"agree": 0, "rule": 0, "llm": 0},
            "guard_fired": 0}
}
```

- `stage ∈ {agree, rule, llm}`; non-`agree` tokens carry `alternatives[]`
  (candidates per system with their conf).
- `src` names the system whose raw word supplies `text`; `src_word` indexes into
  that system's input `words`, so TS can attach Scribe-native times where
  `src == "scribe"` and interpolate elsewhere (spec §4.3).
- `agreement`: 1.0 / 0.67 / 0.33 for 3-of-3, 2-of-3, no-majority columns.

## Frozen numbers the conformance suite must reproduce

From the 391-window fixture bundle (`FUSION_FIXTURES_DIR`, never in git):

| arm | S | D | I | N | WER |
|---|---|---|---|---|---|
| W (vote) | 5396 | 1332 | 6577 | 110694 | 0.12020 |
| rules, guard off | 5030 | 1865 | 5452 | 110694 | 0.11154 |
| rules, guard on | 5036 | 1848 | 5519 | 110694 | 0.11205 |

Policy islands: 13,414, routing per `policy.json` (21 categories, 2 llm).

Guard definition (frozen): an island is guarded iff (a) removing every token in
{ναι, δεν} makes the three candidate spans identical, (b) some span contains such
a token, (c) the arm's island output contains none. Then output = the span with
the most critical tokens (ties: longest, then scribe > soniox > ours).

## PII rule

No transcript text ever enters git: fixtures live outside the repo, CI mismatch
output prints window ids and hashes only. `tests/fusion/fixtures/MANIFEST.json`
(hashes, sizes, counts) is the only fixture artifact in git, plus a tiny
synthetic non-PII bundle for PR CI.
