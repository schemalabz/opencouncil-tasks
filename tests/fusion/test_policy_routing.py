# -*- coding: utf-8 -*-
"""Policy routing conformance, plus the LLM failure path.

Per island the ported analysis must agree with the frozen fixture on
(cat, route, rule, candidates, row_sha16). `row_sha16` replicates
make_fixtures.row_sha: sha256 of json.dumps({"L","R","spans","r12"},
ensure_ascii=False, sort_keys=True)[:16].
"""
from __future__ import annotations

import json
import os
import urllib.request

import pytest

from fusion import rules as R
from fusion.msa import align3, band_for, consensus_pivot
from fusion.policy import LLM_CATEGORIES, POLICY, POLICY_SHA16

from .helpers import run_window, toks_sha

FULL = os.environ.get("FUSION_CONFORMANCE_FULL") == "1"
FAST_N = 30


def _analyse(win):
    cols = align3(*win["hyps"], band=band_for(win["hyps"]))
    parts, _tail, _wsel, _wsrc = R.window_parts(cols, consensus_pivot(win["hyps"]))
    return parts


def test_policy_sha_and_shape(fx_policy):
    assert fx_policy["policy_sha16"] != ""
    assert POLICY_SHA16 == "3e5676d982078979"
    assert len(POLICY) == 21
    assert len(LLM_CATEGORIES) == 2


def test_island_routing_matches_fixture(fx_inputs, fx_policy):
    by_id = {w["id"]: w for w in fx_policy["windows"]}
    wins = fx_inputs["windows"][: (None if FULL else FAST_N)]
    fails, n = [], 0
    for w in wins:
        exp = by_id[w["id"]]["islands"]
        got = _analyse(w)
        if len(got) != len(exp):
            fails.append(f"{w['id']}: {len(got)} islands != {len(exp)}")
            continue
        for k, (g, e) in enumerate(zip(got, exp)):
            n += 1
            route, rule = R.island_route(POLICY, g["cat"])
            if (g["s"], g["e"]) != (e["s"], e["e"]):
                fails.append(f"{w['id']}#{k}: span {(g['s'], g['e'])} != "
                             f"{(e['s'], e['e'])}")
            if g["cat"] != e["cat"]:
                fails.append(f"{w['id']}#{k}: cat {g['cat']} != {e['cat']}")
            if route != e["route"] or rule != e["rule"]:
                fails.append(f"{w['id']}#{k}: route/rule {(route, rule)} != "
                             f"{(e['route'], e['rule'])}")
            cand = {"scribe": list(g["spans"][0]), "soniox": list(g["spans"][1]),
                    "ours": list(g["spans"][2]), "vote": list(g["vote"]),
                    "r12": list(g["r12"])}
            if cand != e["candidates"]:
                fails.append(f"{w['id']}#{k}: candidates differ "
                             f"({toks_sha(sorted(cand.items(), key=str))} vs "
                             f"{toks_sha(sorted(e['candidates'].items(), key=str))})")
            if R.row_sha(g) != e["row_sha16"]:
                fails.append(f"{w['id']}#{k}: row_sha16 {R.row_sha(g)} != "
                             f"{e['row_sha16']}")
    assert not fails, (f"{len(fails)} routing failure(s) over {n} islands:\n"
                       + "\n".join(fails[:20]))


@pytest.mark.skipif(not FULL, reason="island count is only exact over all 391")
def test_total_island_count(fx_policy, fx_manifest):
    n = sum(len(w["islands"]) for w in fx_policy["windows"])
    assert n == 13414 == fx_manifest["n_islands"]


class _Garbage:
    """Stands in for the urlopen context manager, returning junk."""

    def __init__(self, body):
        self._body = body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return self._body


def test_llm_garbage_falls_back_to_r12(fx_inputs, monkeypatch):
    """A garbage LLM response must not fail the run: every llm island falls
    back to R1+R2 and carries llm.error."""
    calls = []

    def fake_urlopen(req, timeout=None):
        calls.append(req)
        return _Garbage(json.dumps({"type": "message", "stop_reason": "end_turn",
                                    "content": [{"type": "text",
                                                 "text": "[not json at all"}]}
                                   ).encode())

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setenv("FUSION_LLM_API_KEY", "test-key-not-real")

    # A window with at least one llm island.
    win = None
    for w in fx_inputs["windows"][:60]:
        cats = {i["cat"] for i in _analyse(w)}
        if cats & set(LLM_CATEGORIES):
            win = w
            break
    assert win is not None, "no llm-routed island in the first 60 windows"

    from .helpers import payload_for
    p = payload_for(win["hyps"], "rules_off")
    p["config"]["arm"] = "policy"
    p["config"]["guard"] = False
    p["config"]["llm"] = {"model": "claude-opus-5"}
    from fusion.fuse import fuse
    out = fuse(p)

    assert calls, "the llm arm never called the API"
    llm_islands = [i for i in out["islands"] if i["category"] in LLM_CATEGORIES]
    assert llm_islands
    for i in llm_islands:
        assert i["llm"] is not None and "error" in i["llm"], i["llm"]
        assert i["stage"] == "rule" and i["rule"] == R.RULE_R12
        assert i["candidates"]["r12"] == [
            t["norm"] for t in out["tokens"] if t["island"] == i["id"]]
    assert out["stats"]["by_stage"]["llm"] == 0
    assert out["config"]["llm_envelope_sha"] is not None


def test_llm_never_called_without_config(fx_inputs, monkeypatch):
    def boom(*a, **k):                                     # pragma: no cover
        raise AssertionError("network touched without config.llm")

    monkeypatch.setattr(urllib.request, "urlopen", boom)
    out = run_window(fx_inputs["windows"][0], "rules_off")
    assert out["config"]["llm_envelope_sha"] is None
