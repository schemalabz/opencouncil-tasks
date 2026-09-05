# -*- coding: utf-8 -*-
"""Score the route gate's HTTP results against the frozen benchmark.

Reads a JSONL of {"id", "text", "matched_frozen"} produced by the Node driver.

It adjudicates two DIFFERENT claims, which the first version of this gate wrongly
merged into one:

  1. Integration. Does the HTTP route produce exactly what fuse.py produces for
     the same input and the same config? This is the claim spec 7 risk 2 is
     about, and it is answered per window, by exact string comparison.
  2. Chunking cost. Production runs max_tokens=120; the frozen totals were
     measured unchunked. Those are two systems, and the difference between them
     is a pre-declared budget (DELTA_GATE, frozen before any of this was
     measured), not something the integration test gets to absorb silently.

So a window whose text differs from the frozen fixture is NOT a pass and NOT a
failure yet: it is re-fused here at the production config, and it passes only if
fuse.py reproduces it byte for byte. Anything else is a TypeScript defect.

Scoring lives here, in Python, on purpose. `wtoks` and `sdi` are the frozen
definitions the 0.11205 was measured with; a TypeScript reimplementation would
be a second stack, and this project does not compare numbers across two stacks.

Never prints transcript text. Mismatches are reported as window id + token-list
hash, which is enough to find the window in the private bundle and useless to
anyone without it.

Usage: python3 tests/fusion/route_gate_score.py results.jsonl
Exit 0 only if every window matches and the totals equal MANIFEST's rules_on.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from fusion.normalize import sdi, wtoks  # noqa: E402
from fusion.fuse import fuse  # noqa: E402
from tests.fusion.helpers import fused_norm, payload_for  # noqa: E402

# Mirrors PRODUCTION_CHUNKING in src/lib/fusion/FusionTranscriber.ts.
PRODUCTION_CHUNKING = {"max_tokens": 120, "anchor_n": 3, "search_radius": 200}
# Declared in the spec before the chunked system was measured. Do not widen it
# to make a run pass; the number is the finding.
DELTA_GATE = 0.002

DEFAULT_DIR = Path.home() / ".cache/oc-public/chooser-2026-08-25"


def bundle_dir() -> Path:
    return Path(os.environ.get("FUSION_FIXTURES_DIR") or DEFAULT_DIR)


def load(name: str):
    return json.loads((bundle_dir() / name).read_text(encoding="utf-8"))


def toks_sha(tokens) -> str:
    return hashlib.sha256(
        json.dumps(list(tokens), ensure_ascii=False).encode()).hexdigest()[:16]


def main(argv) -> int:
    if len(argv) != 2:
        print(json.dumps({"ok": False, "error": "usage: route_gate_score.py results.jsonl"}))
        return 2

    manifest = load("MANIFEST.json")
    inputs = {w["id"]: w for w in load("fixture_inputs_391.json")["windows"]}
    expected = {w["id"]: w for w in load("fixture_rules_on_391.json")["windows"]}

    results = []
    with open(argv[1], encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                results.append(json.loads(line))

    hard_mismatches = []
    chunking_divergences = []
    missing = []
    total = [0, 0, 0, 0]
    frozen_total = [0, 0, 0, 0]

    for row in results:
        wid = row["id"]
        if wid not in expected or wid not in inputs:
            missing.append(wid)
            continue

        want = expected[wid]["tokens"]
        got = wtoks(row["text"])

        if row["text"] != " ".join(want):
            # Re-fuse at the production config. If fuse.py agrees with what came
            # out of HTTP, the route is faithful and the difference is the price
            # of chunking; if it does not, the TypeScript path invented it.
            produced = fused_norm(fuse(payload_for(inputs[wid]["hyps"], "rules_on",
                                                   PRODUCTION_CHUNKING)))
            if row["text"] == " ".join(produced):
                cs, cd, ci, _cn = sdi(" ".join(inputs[wid]["ref"]), " ".join(produced))
                fs_, fd_, fi_, _ = expected[wid]["sidn"]
                chunking_divergences.append({
                    "id": wid, "frozen_n": len(want), "produced_n": len(produced),
                    "frozen_sha": toks_sha(want), "produced_sha": toks_sha(produced),
                    "extra_errors": (cs + cd + ci) - (fs_ + fd_ + fi_),
                })
            else:
                hard_mismatches.append({
                    "id": wid, "want_sha": toks_sha(produced), "got_sha": toks_sha(got),
                    "want_n": len(produced), "got_n": len(got),
                })

        s_, d_, i_, n_ = sdi(" ".join(inputs[wid]["ref"]), " ".join(got))
        total = [total[0] + s_, total[1] + d_, total[2] + i_, total[3] + n_]
        fs, fd, fi, fn = expected[wid]["sidn"]
        frozen_total = [frozen_total[0] + fs, frozen_total[1] + fd,
                        frozen_total[2] + fi, frozen_total[3] + fn]

    frozen = manifest["totals"]["rules_on"]
    n_windows = manifest["n_windows"]

    def wer(t):
        return (t[0] + t[1] + t[2]) / t[3] if t[3] else None

    delta = None
    if total[3] and frozen_total[3]:
        delta = wer(total) - wer(frozen_total)

    # One window supplying the whole delta is a different finding from the same
    # delta spread over 391, and this project has been burned by not looking.
    # Only a divergent window can move the number at all, so the question is how
    # concentrated they are, not whether they are the cause.
    extra = [d["extra_errors"] for d in chunking_divergences]
    total_extra = sum(extra)
    dominance = round(max(extra) / total_extra, 3) if total_extra else None

    ok = (not hard_mismatches and not missing
          and len(results) == n_windows
          and frozen_total == frozen
          and delta is not None and abs(delta) <= DELTA_GATE)

    print(json.dumps({
        "ok": ok,
        "n_results": len(results),
        "n_expected": n_windows,
        "sidn": total,
        "wer": round(wer(total), 5) if total[3] else None,
        "frozen_sidn": frozen,
        "frozen_wer": round(wer(frozen_total), 5) if frozen_total[3] else None,
        "delta_wer": round(delta, 5) if delta is not None else None,
        "delta_gate": DELTA_GATE,
        "n_hard_mismatches": len(hard_mismatches),
        "hard_mismatches": hard_mismatches[:10],
        # Windows where fuse.py at max_tokens=120 reproduced the HTTP text
        # exactly, but the frozen unchunked fixture did not. Expected, priced,
        # and listed by id so the count can never quietly grow.
        "n_chunking_divergences": len(chunking_divergences),
        "chunking_divergences": chunking_divergences[:10],
        "total_extra_errors": total_extra,
        # Can exceed 1.0: one window can supply more than the NET delta when
        # another offsets it. That is the point of reporting it.
        "largest_window_share_of_net_delta": dominance,
        "missing_ids": missing[:10],
    }, ensure_ascii=False))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
