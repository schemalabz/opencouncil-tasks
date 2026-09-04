# -*- coding: utf-8 -*-
"""Byte-exact reproduction of the frozen fusion numbers.

Feeds each fixture window's three normalized token streams back in as RAW words
through the full `fuse.py` pipeline (chunking configured so every window is a
single chunk) and checks three things per window and per arm:

  * the pipeline's own consensus pivot equals the fixture's pivot
  * the fused normalized token sequence equals the fixture's token list exactly
  * the recomputed [S, D, I, N] equals the fixture's

then that the aggregate totals equal the CONTRACT.md table.

Fast mode (default) runs the first 30 windows; FUSION_CONFORMANCE_FULL=1 runs
all 391 across a process pool. On mismatch it prints the window id and the
sha256 of the expected/actual token lists — never transcript text.
"""
from __future__ import annotations

import multiprocessing as mp
import os

import pytest

from fusion.msa import consensus_pivot

from .helpers import (fused_norm, run_window, score, toks_sha,
                      assert_tokens_are_atomic)

FULL = os.environ.get("FUSION_CONFORMANCE_FULL") == "1"
FAST_N = 30

ARMS = ("W", "rules_off", "rules_on")

# CONTRACT.md, "Frozen numbers the conformance suite must reproduce".
CONTRACT_TOTALS = {
    "W": [5396, 1332, 6577, 110694],
    "rules_off": [5030, 1865, 5452, 110694],
    "rules_on": [5036, 1848, 5519, 110694],
}


def _check_window(args):
    """(window, {arm: expected}) -> list of failure strings. Top-level so the
    process pool can pickle it."""
    win, expected = args
    fails = []
    for h in win["hyps"]:
        for t in h:
            if [t] != __import__("fusion.normalize", fromlist=["wtoks"]).wtoks(t):
                fails.append(f"{win['id']}: fixture token not wtoks-stable "
                             f"({toks_sha([t])})")
                return fails
    pivot = consensus_pivot(win["hyps"])
    if pivot != win["pivot"]:
        fails.append(f"{win['id']}: pivot {pivot} != fixture {win['pivot']}")
    totals = {}
    for arm in ARMS:
        out = run_window(win, arm)
        got = fused_norm(out)
        exp = expected[arm]["tokens"]
        if got != exp:
            fails.append(f"{win['id']} [{arm}]: tokens differ "
                         f"expected_sha={toks_sha(exp)} actual_sha={toks_sha(got)} "
                         f"(len {len(exp)} vs {len(got)})")
        sidn = list(score(win["ref"], got))
        if sidn != list(expected[arm]["sidn"]):
            fails.append(f"{win['id']} [{arm}]: sidn {sidn} != {expected[arm]['sidn']}")
        totals[arm] = sidn
    return [fails, totals]


def _pairs(fx_inputs, fx_arms, limit):
    by_arm = {a: {w["id"]: w for w in fx_arms[a]["windows"]} for a in ARMS}
    wins = fx_inputs["windows"][:limit] if limit else fx_inputs["windows"]
    return [(w, {a: by_arm[a][w["id"]] for a in ARMS}) for w in wins]


@pytest.fixture(scope="module")
def results(fx_inputs, fx_arms):
    pairs = _pairs(fx_inputs, fx_arms, None if FULL else FAST_N)
    if FULL:
        with mp.get_context("spawn").Pool(min(12, os.cpu_count() or 4)) as p:
            return pairs, list(p.imap(_check_window, pairs, chunksize=1))
        return pairs, None
    return pairs, [_check_window(x) for x in pairs]


def test_fixture_tokens_are_wtoks_stable(fx_inputs):
    for w in fx_inputs["windows"][: (None if FULL else FAST_N)]:
        assert_tokens_are_atomic(w)


def test_pivot_tokens_and_sidn(results):
    pairs, res = results
    fails = [f for r in res for f in r[0]]
    assert not fails, (f"{len(fails)} conformance failure(s) over {len(pairs)} "
                       f"windows:\n" + "\n".join(fails[:20]))


@pytest.mark.skipif(not FULL,
                    reason="aggregate totals are only meaningful over all 391 "
                           "windows; set FUSION_CONFORMANCE_FULL=1")
def test_aggregate_totals_match_contract(results):
    _pairs_, res = results
    tot = {a: [0, 0, 0, 0] for a in ARMS}
    for _fails, per_arm in res:
        for a in ARMS:
            for j in range(4):
                tot[a][j] += per_arm[a][j]
    for a in ARMS:
        assert tot[a] == CONTRACT_TOTALS[a], f"{a}: {tot[a]} != {CONTRACT_TOTALS[a]}"
        wer = sum(tot[a][:3]) / tot[a][3]
        print(f"{a:10s} sidn={tot[a]} WER={wer:.5f}")


def test_manifest_totals_agree_with_contract(fx_manifest):
    for a in ARMS:
        assert fx_manifest["totals"][a] == CONTRACT_TOTALS[a]
    assert fx_manifest["guard"]["critical_tokens"] == ["ναι", "δεν"]


def test_committed_manifest_matches_the_bundle(fixtures_dir):
    """tests/fusion/fixtures/MANIFEST.json is the only fixture artifact in git.
    It must describe the bundle the conformance run just used."""
    import hashlib
    import json as _json
    from pathlib import Path as _Path

    committed = _json.loads(
        (_Path(__file__).parent / "fixtures" / "MANIFEST.json").read_text(encoding="utf-8"))
    live = _json.loads((fixtures_dir / "MANIFEST.json").read_text(encoding="utf-8"))
    assert committed["fixtures"] == live["fixtures"]
    assert committed["totals"] == live["totals"] == {a: CONTRACT_TOTALS[a] for a in ARMS}
    for name, meta in committed["fixtures"].items():
        blob = (fixtures_dir / name).read_bytes()
        assert len(blob) == meta["bytes"], name
        assert hashlib.sha256(blob).hexdigest() == meta["sha256"], name
