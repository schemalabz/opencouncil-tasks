# -*- coding: utf-8 -*-
"""The oc-fusion-in/1 -> oc-fusion/1 contract, on synthetic non-PII input.

These run in PR CI without the 391-window bundle.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from fusion.fuse import fuse
from fusion.policy import POLICY_SHA16

SYN = Path(__file__).parent / "fixtures_synthetic"
REPO = Path(__file__).resolve().parents[2]
FUSE = REPO / "fusion" / "fuse.py"

STAGES = {"agree", "rule", "llm"}
AGREEMENTS = {1.0, 0.67, 0.33}
TOKEN_KEYS = {"i", "text", "norm", "src", "src_word", "col", "island", "stage",
              "agreement", "alternatives"}
ISLAND_KEYS = {"id", "cols", "category", "candidates", "stage", "rule",
               "chosen_src", "guard_fired", "llm"}


def load(name):
    return json.loads((SYN / name).read_text(encoding="utf-8"))


def run_cli(payload_text: str):
    return subprocess.run([sys.executable, str(FUSE)], input=payload_text,
                          capture_output=True, text=True, cwd=str(REPO))


@pytest.mark.parametrize("name", ["malformed_missing_system",
                                  "malformed_bad_schema",
                                  "malformed_bad_order"])
def test_malformed_input_exits_2(name):
    p = run_cli((SYN / f"{name}.json").read_text(encoding="utf-8"))
    assert p.returncode == 2, p.stderr
    assert p.stdout == ""
    line = p.stderr.strip().splitlines()
    assert len(line) == 1, p.stderr
    err = json.loads(line[0])
    assert "error" in err


def test_invalid_json_exits_2():
    p = run_cli("{not json")
    assert p.returncode == 2
    assert json.loads(p.stderr.strip())["error"]


def test_valid_tiny_input_is_schema_valid():
    p = run_cli((SYN / "tiny_valid.json").read_text(encoding="utf-8"))
    assert p.returncode == 0, p.stderr
    out = json.loads(p.stdout)
    assert out["schema"] == "oc-fusion/1"
    assert out["audio_sha256"] == "a" * 64
    cfg = out["config"]
    for k in ("arm", "guard", "policy_sha", "llm_envelope_sha", "code_rev",
              "normalizer_rev", "chunking", "components"):
        assert k in cfg, k
    assert cfg["policy_sha"] == POLICY_SHA16
    assert cfg["llm_envelope_sha"] is None
    assert cfg["components"] == {"scribe": "p-scribe", "soniox": "p-soniox",
                                 "ours": "p-ours"}
    assert set(cfg["chunking"]) >= {"rev", "max_tokens", "anchor_n",
                                    "search_radius", "n_chunks", "forced_cuts",
                                    "seams"}
    for n, t in enumerate(out["tokens"]):
        assert set(t) == TOKEN_KEYS
        assert t["i"] == n
        assert t["stage"] in STAGES
        assert t["agreement"] in AGREEMENTS
        assert t["src"] in ("scribe", "soniox", "ours")
        assert isinstance(t["src_word"], int)
        if t["stage"] == "agree":
            assert t["alternatives"] is None and t["island"] is None
        else:
            assert t["alternatives"] is not None and t["island"] is not None
    for i in out["islands"]:
        assert set(i) == ISLAND_KEYS
        assert set(i["candidates"]) == {"scribe", "soniox", "ours", "vote", "r12"}
        assert i["stage"] in STAGES
    st = out["stats"]
    assert st["n_tokens"] == len(out["tokens"])
    assert st["n_islands"] == len(out["islands"])
    assert set(st["by_stage"]) >= {"agree", "rule", "llm"}
    assert sum(st["by_stage"].values()) == st["n_tokens"]


def test_guard_fires_on_constructed_island():
    payload = load("guard_island.json")
    on = fuse(payload)
    off = fuse({**payload, "config": {**payload["config"], "guard": False}})
    assert on["stats"]["guard_fired"] == 1
    assert off["stats"]["guard_fired"] == 0
    assert "δεν" in [t["norm"] for t in on["tokens"]]
    assert "δεν" not in [t["norm"] for t in off["tokens"]]
    assert on["islands"][0]["guard_fired"] is True
    assert on["islands"][0]["chosen_src"] == "soniox"
    # guard off deletes the island entirely -> it must be recorded as dropped
    assert off["dropped"] and off["dropped"][0]["src"] == "soniox"
    assert off["dropped"][0]["text"] == "δεν"


def test_empty_systems():
    out = fuse(load("empty_systems.json"))
    assert out["tokens"] == [] and out["islands"] == []
    assert out["stats"]["n_tokens"] == 0
    assert out["config"]["chunking"]["n_chunks"] in (0, 1)


def test_one_system_empty():
    out = fuse(load("one_empty.json"))
    assert [t["norm"] for t in out["tokens"]] == ["αλφα", "βητα", "γαμμα"]
    assert out["islands"][0]["candidates"]["ours"] == []
    assert all(t["src"] in ("scribe", "soniox") for t in out["tokens"])


def test_src_word_indexes_the_input_words():
    payload = load("tiny_valid.json")
    out = fuse(payload)
    by_id = {s["id"]: s["words"] for s in payload["systems"]}
    for t in out["tokens"]:
        assert by_id[t["src"]][t["src_word"]]["raw"] == t["text"]


def test_multi_token_raw_word_keeps_provenance():
    """A raw word that normalizes to two tokens yields two output tokens with
    the same src_word — the documented behaviour TS de-duplicates on."""
    ws = lambda xs: [{"raw": x, "start": i, "end": i + 0.4, "conf": 0.9}
                     for i, x in enumerate(xs)]
    p = {"schema": "oc-fusion-in/1", "audio_sha256": None,
         "systems": [{"id": s, "params_sha": None,
                      "words": ws(["αλφα", "βητα-γαμμα", "δελτα"])}
                     for s in ("scribe", "soniox", "ours")],
         "config": {"arm": "rules", "guard": False}}
    out = fuse(p)
    assert [t["norm"] for t in out["tokens"]] == ["αλφα", "βητα", "γαμμα", "δελτα"]
    assert [t["src_word"] for t in out["tokens"]] == [0, 1, 1, 2]
    assert out["tokens"][1]["text"] == out["tokens"][2]["text"] == "βητα-γαμμα"


def test_no_network_without_llm_config(monkeypatch):
    import urllib.request
    monkeypatch.setattr(urllib.request, "urlopen",
                        lambda *a, **k: pytest.fail("network touched"))
    fuse(load("tiny_valid.json"))
    p = load("tiny_valid.json")
    p["config"]["arm"] = "policy"
    fuse(p)


def test_policy_hash_guard(monkeypatch, tmp_path):
    """A drifted policy.json must refuse to load."""
    import fusion.policy as P
    bad = tmp_path / "policy.json"
    bad.write_text("{\"policy\": {}}", encoding="utf-8")
    monkeypatch.setattr(P, "POLICY_PATH", bad)
    with pytest.raises(P.PolicyError):
        P._load()
