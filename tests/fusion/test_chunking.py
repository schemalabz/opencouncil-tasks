# -*- coding: utf-8 -*-
"""What chunking costs, and that its edge cases are deterministic.

(a) is the measurement that matters: chunked vs full on real windows, reported
as a token-equality rate and a WER delta. The gate is ΔWER <= 0.002 absolute on
the rules arm. If it fails, the number is the finding — do NOT tune the
chunking config until it passes.
"""
from __future__ import annotations

import os

import pytest

from fusion.chunking import ChunkConfig, plan_chunks
from fusion.fuse import fuse

from .helpers import SINGLE_CHUNK, fused_norm, payload_for, run_window, score

FULL = os.environ.get("FUSION_CONFORMANCE_FULL") == "1"
FAST_N = 30

CHUNKED = {"max_tokens": 120, "anchor_n": 3, "search_radius": 200}
DELTA_GATE = 0.002


def test_chunked_vs_full_wer_delta(fx_inputs, capsys):
    wins = fx_inputs["windows"][: (None if FULL else FAST_N)]
    tot_full = [0, 0, 0, 0]
    tot_chunk = [0, 0, 0, 0]
    equal = 0
    n_chunks = 0
    forced = 0
    for w in wins:
        full = run_window(w, "rules_off")
        chunked = fuse(payload_for(w["hyps"], "rules_off", CHUNKED))
        gf, gc = fused_norm(full), fused_norm(chunked)
        equal += int(gf == gc)
        n_chunks += chunked["config"]["chunking"]["n_chunks"]
        forced += chunked["config"]["chunking"]["forced_cuts"]
        for tot, g in ((tot_full, gf), (tot_chunk, gc)):
            for j, v in enumerate(score(w["ref"], g)):
                tot[j] += v

    def wer(t):
        return sum(t[:3]) / t[3]

    delta = wer(tot_chunk) - wer(tot_full)
    rate = equal / len(wins)
    with capsys.disabled():
        print(f"\n  chunking (max_tokens={CHUNKED['max_tokens']}) over {len(wins)} windows")
        print(f"    chunks {n_chunks} (forced cuts {forced})")
        print(f"    token-equality rate {rate:.1%}")
        print(f"    WER full {wer(tot_full):.5f}  chunked {wer(tot_chunk):.5f}  "
              f"Δ {delta:+.5f}")
    assert delta <= DELTA_GATE, (
        f"chunked-minus-full ΔWER on the rules arm is {delta:+.5f}, above the "
        f"{DELTA_GATE} gate. This is a measurement, not a knob: report it, do "
        f"not tune max_tokens/anchor_n/search_radius until it passes.")


def test_forced_cut_path_is_deterministic():
    """Three streams with no shared n-gram anywhere: every cut is forced, and
    the output is stable across runs."""
    a = [f"a{i}" for i in range(300)]
    b = [f"b{i}" for i in range(300)]
    c = [f"c{i}" for i in range(300)]
    cfg = ChunkConfig(max_tokens=50)
    chunks, forced = plan_chunks([a, b, c], cfg)
    assert forced == len(chunks) - 1 > 0
    # ranges tile each stream exactly once, in order
    for k in range(3):
        pos = 0
        for ch in chunks:
            assert ch[k][0] == pos
            pos = ch[k][1]
        assert pos == 300

    p = payload_for([a, b, c], "rules_off", {"max_tokens": 50, "anchor_n": 3,
                                             "search_radius": 200})
    o1, o2 = fuse(p), fuse(p)
    assert fused_norm(o1) == fused_norm(o2)
    assert o1["config"]["chunking"]["forced_cuts"] == forced
    assert o1["config"]["chunking"]["n_chunks"] == len(chunks)
    assert len(o1["config"]["chunking"]["seams"]) == len(chunks) - 1


def test_island_crossing_a_boundary_is_emitted_once(fx_inputs):
    """Island ids are globally unique and column indices strictly increase, so
    nothing straddling a seam gets emitted twice."""
    w = fx_inputs["windows"][0]
    out = fuse(payload_for(w["hyps"], "rules_off", CHUNKED))
    ids = [i["id"] for i in out["islands"]]
    assert len(ids) == len(set(ids))
    cols = [i["cols"][0] for i in out["islands"]]
    assert cols == sorted(cols)
    tok_cols = [t["col"] for t in out["tokens"]]
    assert tok_cols == sorted(tok_cols)
    # every island referenced by a token exists, and each token belongs to <=1
    ref = {t["island"] for t in out["tokens"] if t["island"]}
    assert ref <= set(ids)


def test_repeated_phrases_reject_ambiguous_anchors():
    """A stream built from one repeated phrase has no n-gram that occurs exactly
    once in a neighbourhood, so the anchor search must refuse and force cuts."""
    phrase = ["και", "το", "θεμα"]
    stream = phrase * 200
    cfg = ChunkConfig(max_tokens=100, anchor_n=3, search_radius=200)
    chunks, forced = plan_chunks([stream, list(stream), list(stream)], cfg)
    assert forced == len(chunks) - 1, "an ambiguous n-gram was accepted as an anchor"


def test_anchor_cut_keeps_anchor_with_following_chunk():
    left = [f"L{i}" for i in range(300)]
    anchor = ["ξεχωριστη", "μοναδικη", "φρασηδω"]
    right = [f"R{i}" for i in range(300)]
    a = left + anchor + right
    b = [f"{t}x" if t.startswith(("L", "R")) else t for t in a]
    c = [f"{t}y" if t.startswith(("L", "R")) else t for t in a]
    cfg = ChunkConfig(max_tokens=400, anchor_n=3, search_radius=200)
    chunks, forced = plan_chunks([a, b, c], cfg)
    assert forced == 0, "a unique unanimous anchor was not found"
    cut = chunks[0][0][1]
    assert a[cut:cut + 3] == anchor, "the anchor did not start the next chunk"


def test_single_chunk_when_short(fx_inputs):
    w = fx_inputs["windows"][0]
    out = run_window(w, "rules_off")
    assert out["config"]["chunking"]["n_chunks"] == 1
    assert out["config"]["chunking"]["forced_cuts"] == 0
    assert out["config"]["chunking"]["seams"] == []
    assert out["config"]["chunking"]["max_tokens"] == SINGLE_CHUNK["max_tokens"]


def test_bad_chunk_config_rejected():
    with pytest.raises(ValueError):
        ChunkConfig.from_dict({"max_tokens": 0})
    with pytest.raises(ValueError):
        ChunkConfig.from_dict({"nonsense": 1})


def test_no_chunk_exceeds_max_tokens_in_any_stream():
    """align3 allocates n**3 bytes for the longest of the three spans, so a cap
    on scribe's side alone does not bound the memory. A stream that runs much
    longer than scribe's -- a verbose system, or one that did not stop when the
    others did -- used to be handed a proportional cut far past max_tokens."""
    cfg = ChunkConfig(max_tokens=120, anchor_n=3, search_radius=200)
    # Deliberately anchor-free: distinct tokens everywhere, so every cut is
    # forced and the proportional placement is what decides the spans.
    streams = [
        [f"α{i}" for i in range(60)],
        [f"β{i}" for i in range(600)],
        [f"γ{i}" for i in range(60)],
    ]
    chunks, _forced = plan_chunks(streams, cfg)

    for chunk in chunks:
        for k, (start, end) in enumerate(chunk):
            assert end - start <= cfg.max_tokens, (
                f"stream {k} got a span of {end - start} tokens, over the "
                f"{cfg.max_tokens} cap")

    # and it still covers each stream exactly once
    for k in range(3):
        spans = [c[k] for c in chunks]
        assert spans[0][0] == 0 and spans[-1][1] == len(streams[k])
        assert all(a[1] == b[0] for a, b in zip(spans, spans[1:]))
