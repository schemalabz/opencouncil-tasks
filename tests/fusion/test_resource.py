# -*- coding: utf-8 -*-
"""Wall clock and peak RSS on a segment-sized input.

~2500 normalized tokens per system, built by concatenating fixture windows —
roughly a 20-minute council segment. Run end-to-end through the fuse.py
subprocess so the numbers include interpreter startup and JSON I/O, and read
the child's peak RSS from `resource.getrusage(RUSAGE_CHILDREN)`.

Gates: wall < 60 s, peak RSS < 1 GB. Both are printed either way.
"""
from __future__ import annotations

import json
import resource
import subprocess
import sys
import time
from pathlib import Path

from .helpers import as_words

REPO = Path(__file__).resolve().parents[2]
FUSE = REPO / "fusion" / "fuse.py"

TARGET_TOKENS = 2500
WALL_GATE_S = 60.0
RSS_GATE_BYTES = 1 << 30


def _big_streams(fx_inputs):
    streams = [[], [], []]
    for w in fx_inputs["windows"]:
        for k in range(3):
            streams[k] += w["hyps"][k]
        if min(len(s) for s in streams) >= TARGET_TOKENS:
            break
    return [s[:TARGET_TOKENS] for s in streams]


def test_segment_sized_input_time_and_memory(fx_inputs, capsys):
    streams = _big_streams(fx_inputs)
    ids = ("scribe", "soniox", "ours")
    payload = {
        "schema": "oc-fusion-in/1",
        "audio_sha256": "0" * 64,
        "systems": [{"id": ids[k], "params_sha": None,
                     "words": as_words(streams[k])} for k in range(3)],
        "config": {"arm": "rules", "guard": True, "llm": None,
                   "chunking": {"max_tokens": 800, "anchor_n": 3,
                                "search_radius": 200}},
    }
    blob = json.dumps(payload, ensure_ascii=False)

    before = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
    t0 = time.monotonic()
    p = subprocess.run([sys.executable, str(FUSE)], input=blob,
                       capture_output=True, text=True, cwd=str(REPO))
    wall = time.monotonic() - t0
    after = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
    # ru_maxrss is kilobytes on Linux; RUSAGE_CHILDREN reports the max over all
    # children, so the delta is a lower bound and `after` an upper bound.
    peak_bytes = max(after, before) * 1024

    assert p.returncode == 0, p.stderr[-500:]
    out = json.loads(p.stdout)

    with capsys.disabled():
        print(f"\n  resource: {[len(s) for s in streams]} tokens/system  "
              f"wall {wall:.1f}s  peak child RSS {peak_bytes/1e6:.0f} MB  "
              f"chunks {out['config']['chunking']['n_chunks']}  "
              f"forced {out['config']['chunking']['forced_cuts']}  "
              f"tokens {out['stats']['n_tokens']}  "
              f"islands {out['stats']['n_islands']}")

    assert out["stats"]["n_tokens"] > 0
    assert wall < WALL_GATE_S, f"wall {wall:.1f}s >= {WALL_GATE_S}s"
    assert peak_bytes < RSS_GATE_BYTES, f"peak RSS {peak_bytes/1e6:.0f} MB >= 1 GB"
