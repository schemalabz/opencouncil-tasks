# The Python fuse core, and how to get it back

The fusion engine was Python until 2026-09-11. It is gone from this tree. What
follows is everything needed to rebuild the frozen expected outputs that the
TypeScript engine is still tested against, because those files cannot be
regenerated from this repository any more.

## The reference

| | |
|---|---|
| Commit | `7c47040e058c5b182c5edecda9779a88aa52ecdb` |
| Tag | `python-engine-last-known-good` |
| Branch | `backup/fusion-python-engine` |
| Remote | `https://github.com/angelospk/opencouncil-tasks` |

Both refs are pushed. The tag is the one to trust: a branch can move.

## The runtime, exactly

CPython **3.14.6**, Unicode database **16.0.0**. Not "3.11 or later".

The version is part of the specification, not a detail. `sum()` over floats
became compensated in CPython 3.12, which changes the average provider
confidence in the fused output from 0.9000000000000001 to 0.9. An older
interpreter regenerating these files would produce different numbers and the
differential tests would fail against a baseline that was never wrong.

The engine imports nothing outside the standard library, so there is no
dependency lock to preserve.

## The inputs

| Artifact | Hash | Where |
|---|---|---|
| Benchmark report | `e33d5617fc2b1c3088a9f4a137780158a303a49237ca574aed07e0b39400ca85` | `~/.cache/oc-public/bench_2026-08-22-post-june-held-out-test-clean-pack-cont-.json` |
| Fixture bundle | see `tests/fusion/fixtures/MANIFEST.json` | `~/.cache/oc-public/chooser-2026-08-25/` |

Both hold verbatim council speech and are not in git, on the same reasoning as
the 2026-07-21 history purge. `FUSION_FIXTURES_DIR` overrides the bundle path.

## Regenerating

From a checkout of the tag, with the bundle present:

```bash
python3 tests/fusion/oracle_dump.py            # -> oracle_rules_off_391.json
python3 tests/fusion/msa_vectors.py            # -> msa_vectors_391.json
python3 tests/fusion/normalize_vectors.py      # -> normalize_vectors.json
python3 tests/fusion/normalize_edge_vectors.py > src/lib/fusion/engine/normalize.vectors.json
```

Each writes its data next to the fixture bundle and its index into
`tests/fusion/`. The index carries the hashes; compare those, not the files.

## What the baselines mean

The committed indexes record what the Python answered, on those inputs, on that
interpreter. They are a historical observation, not a specification.

- Comparison is **parsed JSON equality** of the complete `oc-fusion/1` output,
  with no numeric tolerance and no excluded fields. `normalize.vectors.json` is
  synthetic and committed; everything else stays in the cache.
- A baseline changes only on purpose. Running the TypeScript engine and
  accepting whatever it prints is not evidence of anything.
- When the fusion is deliberately improved, the old baseline stops describing
  the wanted answer. Keep it, write down what changed and why, and add tests
  that state the new requirement. Do not edit the old numbers.

## Determinism

The Python was checked before its output was trusted as a baseline: identical
results for all 391 windows under `PYTHONHASHSEED=0` and `PYTHONHASHSEED=99999`.
Its sets and dicts do not reach the output.
