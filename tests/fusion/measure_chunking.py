# -*- coding: utf-8 -*-
"""Wall clock and peak RSS against max_tokens, on a segment-sized input.

Not a test: the number this produces chooses a production config value, and
test_resource.py then holds it. Reads the private fixture bundle, builds one
~2500-token-per-system input (roughly a 20-minute council segment), and runs it
through the fuse.py subprocess once per max_tokens.

    python3 tests/fusion/measure_chunking.py [max_tokens ...]

Prints a table. Never prints transcript text.
"""
from __future__ import annotations

import json
import resource
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tests.fusion.conftest import bundle_dir, have_bundle  # noqa: E402
from tests.fusion.helpers import as_words  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
FUSE = REPO / "fusion" / "fuse.py"
TARGET_TOKENS = 2500
DEFAULT_GRID = [800, 400, 240, 160, 120, 80]


def big_streams(fx_inputs):
    streams = [[], [], []]
    for w in fx_inputs["windows"]:
        for k in range(3):
            streams[k] += w["hyps"][k]
        if min(len(s) for s in streams) >= TARGET_TOKENS:
            break
    return [s[:TARGET_TOKENS] for s in streams]


def run(streams, max_tokens):
    ids = ("scribe", "soniox", "ours")
    payload = {
        "schema": "oc-fusion-in/1",
        "audio_sha256": "0" * 64,
        "systems": [{"id": ids[k], "params_sha": None, "words": as_words(streams[k])}
                    for k in range(3)],
        "config": {"arm": "rules", "guard": True, "llm": None,
                   "chunking": {"max_tokens": max_tokens, "anchor_n": 3,
                                "search_radius": 200}},
    }
    before = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
    t0 = time.monotonic()
    p = subprocess.run([sys.executable, str(FUSE)],
                       input=json.dumps(payload, ensure_ascii=False),
                       capture_output=True, text=True, cwd=str(REPO))
    wall = time.monotonic() - t0
    after = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
    if p.returncode != 0:
        raise SystemExit(f"fuse.py exited {p.returncode}: {p.stderr[-400:]}")
    out = json.loads(p.stdout)
    return {
        "max_tokens": max_tokens,
        "wall_s": round(wall, 1),
        "peak_rss_mb": round(max(after, before) * 1024 / 1e6),
        "n_chunks": out["config"]["chunking"]["n_chunks"],
        "forced_cuts": out["config"]["chunking"]["forced_cuts"],
        "n_tokens": out["stats"]["n_tokens"],
        "n_islands": out["stats"]["n_islands"],
    }


def main(argv):
    if not have_bundle():
        raise SystemExit(f"fixture bundle not found at {bundle_dir()}")
    grid = [int(a) for a in argv[1:]] or DEFAULT_GRID
    fx = json.loads((bundle_dir() / "fixture_inputs_391.json").read_text(encoding="utf-8"))
    streams = big_streams(fx)
    print(f"{[len(s) for s in streams]} tokens/system, one fuse.py call each\n")
    print(f"{'max_tokens':>10} {'wall s':>8} {'RSS MB':>7} {'chunks':>7} {'forced':>7} {'islands':>8}")
    rows = []
    for mt in grid:
        r = run(streams, mt)
        rows.append(r)
        print(f"{r['max_tokens']:>10} {r['wall_s']:>8} {r['peak_rss_mb']:>7} "
              f"{r['n_chunks']:>7} {r['forced_cuts']:>7} {r['n_islands']:>8}", flush=True)
    print("\n" + json.dumps(rows))


if __name__ == "__main__":
    main(sys.argv)
