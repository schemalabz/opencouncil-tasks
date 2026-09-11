# -*- coding: utf-8 -*-
"""Freeze what the Python normalizer answers, over real council speech.

The TypeScript port has to agree with `fusion/normalize.py` on every word the
corpus actually contains, not on a handful of examples someone thought of. This
walks the benchmark report, takes every distinct whitespace-separated raw word
and every full hypothesis text, and records `norm()` and `wtoks()` for each.

The vectors hold transcript text, so they are written next to the fixture bundle
in ~/.cache/oc-public/ and never committed. The committed artefact is the index:
counts, hashes, and the Unicode version of the runtime that produced them.

    python3 tests/fusion/normalize_vectors.py
"""
from __future__ import annotations

import hashlib
import json
import platform
import sys
import unicodedata
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(REPO / "tests" / "fusion"))

import conftest  # noqa: E402
from fusion.normalize import norm, wtoks, sdi  # noqa: E402

REPORT = Path.home() / ".cache/oc-public/bench_2026-08-22-post-june-held-out-test-clean-pack-cont-.json"


def main() -> int:
    if not REPORT.is_file():
        print(f"benchmark report not found at {REPORT}", file=sys.stderr)
        return 2

    report = json.loads(REPORT.read_text(encoding="utf-8"))

    # One table of every distinct text, so the reference/hypothesis pairs can
    # point into it instead of carrying two copies of every transcript.
    texts: list[str] = []
    index_of: dict[str, int] = {}

    def text_id(t: str) -> int:
        if t not in index_of:
            index_of[t] = len(texts)
            texts.append(t)
        return index_of[t]

    pairs = []
    for item in report["items"]:
        ref = item.get("referenceText") or ""
        ref_id = text_id(ref)
        for pid, prov in sorted((item.get("perProvider") or {}).items()):
            hyp = prov.get("hypothesisText") or ""
            s, d, i, n = sdi(ref, hyp)
            pairs.append([ref_id, text_id(hyp), s, d, i, n])

    words: dict[str, None] = {}
    for t in texts:
        for w in t.split():
            words.setdefault(w, None)

    word_vectors = {w: [norm(w), wtoks(w)] for w in words}
    text_vectors = [[t, wtoks(t)] for t in texts]
    sdi_vectors = pairs

    out = {
        "schema": "oc-fusion-normalize-vectors/1",
        "python": platform.python_version(),
        "unicodedata": unicodedata.unidata_version,
        "report_sha256": hashlib.sha256(REPORT.read_bytes()).hexdigest(),
        "words": word_vectors,
        "texts": text_vectors,
        "sdi": sdi_vectors,
    }
    body = json.dumps(out, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    path = conftest.bundle_dir() / "normalize_vectors.json"
    path.write_text(body, encoding="utf-8")

    index = {
        "schema": "oc-fusion-normalize-vectors-index/1",
        "file": path.name,
        "sha256": hashlib.sha256(body.encode()).hexdigest(),
        "distinct_words": len(word_vectors),
        "texts": len(text_vectors),
        "sdi_pairs": len(sdi_vectors),
        "python": out["python"],
        "unicodedata": out["unicodedata"],
        "report_sha256": out["report_sha256"],
    }
    (REPO / "tests" / "fusion" / "NORMALIZE_VECTORS.json").write_text(
        json.dumps(index, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    print(f"{len(word_vectors)} distinct words, {len(text_vectors)} texts, "
          f"{len(sdi_vectors)} sdi pairs -> {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
