# -*- coding: utf-8 -*-
"""Freeze what the Python engine answers, so a port can be held to it.

Runs every fixture window through `fuse.py` and writes the complete
`oc-fusion/1` output for each one. The TypeScript engine is then required to
reproduce this file exactly: not the transcript alone, but every island,
candidate, deciding rule and index in it. A WER budget would let a port change
words and still pass.

The outputs hold council speech, so the dump lands next to the fixture bundle
in ~/.cache/oc-public/ and never in git. What is committed is the index: the
hashes, the engine revision and the runtime versions that produced it.

    python3 tests/fusion/oracle_dump.py [--arm rules_off] [--limit N]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import sys
import unicodedata
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(REPO / "tests" / "fusion"))

import conftest  # noqa: E402
from helpers import payload_for  # noqa: E402
from fusion.fuse import fuse  # noqa: E402


def engine_revision() -> str:
    """Same content hash the TypeScript cache key uses: every engine file."""
    files = sorted(list((REPO / "fusion").glob("*.py"))
                   + list((REPO / "fusion").glob("*.json")))
    h = hashlib.sha256()
    for f in files:
        h.update(f.name.encode())
        h.update(hashlib.sha256(f.read_bytes()).digest())
    return h.hexdigest()


def canonical(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--arm", default="rules_off")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    if not conftest.have_bundle():
        print(f"fixture bundle missing at {conftest.bundle_dir()}", file=sys.stderr)
        return 2

    inputs = json.loads(
        (conftest.bundle_dir() / "fixture_inputs_391.json").read_text(encoding="utf-8"))
    windows = inputs["windows"][: args.limit] if args.limit else inputs["windows"]

    records = {}
    for win in windows:
        out = fuse(payload_for(win["hyps"], args.arm))
        records[win["id"]] = out

    out_path = Path(args.out) if args.out else (
        conftest.bundle_dir() / f"oracle_{args.arm}_{len(records)}.json")
    payload = {
        "schema": "oc-fusion-oracle/1",
        "arm": args.arm,
        "engine_revision": engine_revision(),
        "python": platform.python_version(),
        "unicodedata": unicodedata.unidata_version,
        "hash_seed": os.environ.get("PYTHONHASHSEED", "unset"),
        "windows": len(records),
        "outputs": records,
    }
    body = canonical(payload)
    out_path.write_text(body, encoding="utf-8")

    index = {
        "schema": "oc-fusion-oracle-index/1",
        "arm": args.arm,
        "windows": len(records),
        "engine_revision": payload["engine_revision"],
        "python": payload["python"],
        "unicodedata": payload["unicodedata"],
        "file": out_path.name,
        "sha256": hashlib.sha256(body.encode()).hexdigest(),
        "per_window_sha256": {
            wid: hashlib.sha256(canonical(o).encode()).hexdigest()[:16]
            for wid, o in sorted(records.items())
        },
    }
    index_path = REPO / "tests" / "fusion" / f"ORACLE_{args.arm}.json"
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=1) + "\n",
                          encoding="utf-8")

    print(f"{len(records)} windows -> {out_path}")
    print(f"index -> {index_path.relative_to(REPO)}  sha256={index['sha256'][:16]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
