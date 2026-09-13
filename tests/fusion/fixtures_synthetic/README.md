# Synthetic fusion fixtures

Invented Greek-looking words only (`αλφα βητα γαμμα` …). No council speech, no
PII, nothing derived from a transcript. This is the only fusion input bundle
that is allowed in git, and it exists so PR CI can exercise the `oc-fusion-in/1`
/ `oc-fusion/1` contract without the 391-window bundle.

| file | what it is |
|---|---|
| `tiny_valid.json` | three short streams with one agreement run and one disagreement island |
| `guard_island.json` | a constructed island where the ναι/δεν guard must fire |
| `empty_systems.json` | all three systems empty |
| `one_empty.json` | scribe and soniox have words, `ours` is empty |
| `malformed_missing_system.json` | only two systems — must exit 2 |
| `malformed_bad_schema.json` | wrong `schema` — must exit 2 |
| `malformed_bad_order.json` | systems out of the frozen order — must exit 2 |
