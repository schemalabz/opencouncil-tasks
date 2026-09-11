# -*- coding: utf-8 -*-
"""Freeze what the Python aligner answers, over the real windows.

`align3` is the part of the engine where a port goes wrong quietly: a different
tie-break returns the same cost with different columns, and the text only
changes on some inputs. So the vectors record the columns themselves, not the
transcript they produce, plus the pivot, the per-column vote decisions and the
index map.

Vectors hold transcript text and stay out of git; the committed artefact is the
index of hashes.

    python3 tests/fusion/msa_vectors.py [--limit N]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import platform
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(REPO / "tests" / "fusion"))

import conftest  # noqa: E402
from fusion.msa import (align3, band_for, column_indices, columns_cost,  # noqa: E402
                        compose, consensus_pivot)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    if not conftest.have_bundle():
        print(f"fixture bundle missing at {conftest.bundle_dir()}", file=sys.stderr)
        return 2

    inputs = json.loads(
        (conftest.bundle_dir() / "fixture_inputs_391.json").read_text(encoding="utf-8"))
    windows = inputs["windows"][: args.limit] if args.limit else inputs["windows"]

    records = []
    for win in windows:
        hyps = [list(h) for h in win["hyps"]]
        band = band_for(hyps)
        cols = align3(hyps[0], hyps[1], hyps[2], band)
        pivot = consensus_pivot(hyps)
        toks, decisions = compose(cols, pivot)
        records.append({
            "id": win["id"],
            "hyps": hyps,
            "band": band,
            "pivot": pivot,
            "cols": cols,
            "cols_cost": columns_cost(cols),
            "indices": column_indices(cols),
            "tokens": toks,
            "decisions": decisions,
        })

    out = {
        "schema": "oc-fusion-msa-vectors/1",
        "python": platform.python_version(),
        "windows": len(records),
        "records": records,
    }
    body = json.dumps(out, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    path = conftest.bundle_dir() / f"msa_vectors_{len(records)}.json"
    path.write_text(body, encoding="utf-8")

    index = {
        "schema": "oc-fusion-msa-vectors-index/1",
        "file": path.name,
        "sha256": hashlib.sha256(body.encode()).hexdigest(),
        "windows": len(records),
        "python": out["python"],
        "per_window_sha256": {
            r["id"]: hashlib.sha256(json.dumps(
                r, ensure_ascii=False, sort_keys=True,
                separators=(",", ":")).encode()).hexdigest()[:16]
            for r in records
        },
    }
    (REPO / "tests" / "fusion" / f"MSA_VECTORS_{len(records)}.json").write_text(
        json.dumps(index, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    print(f"{len(records)} windows -> {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
