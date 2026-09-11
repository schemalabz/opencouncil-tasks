# tests/fusion

Nothing here is generated from this tree, and nothing here runs.

The Python that produced these baselines was removed on 2026-09-11. What is
committed are **indexes**: hashes, counts, and the interpreter and Unicode
versions behind them. The data they describe holds verbatim council speech and
lives in `~/.cache/oc-public/`, never in git.

| File | Describes |
|---|---|
| `ORACLE_rules_off.json` | the complete `oc-fusion/1` output for 391 windows, one chunk per window |
| `ORACLE_rules_off_production.json` | the same, at the production chunking the service sends |
| `ORACLE_rules_on_production.json` | the same again with the guard on, which is what the route gate scores against |
| `MSA_VECTORS_391.json` | every alignment column of all 391 windows |
| `NORMALIZE_VECTORS.json` | 50,721 distinct words, 3,239 texts, 3,128 edit splits |
| `fixtures/MANIFEST.json` | the fixture bundle's own hashes and frozen totals |
| `fixtures_synthetic/EXPECTED_python.json` | what the Python CLI answered for each synthetic fixture |

To rebuild any of them, check out `python-engine-last-known-good` and follow
`docs/fusion-python-archive.md`. Do not rebuild them from the TypeScript
engine's output: that proves the code equals itself.
