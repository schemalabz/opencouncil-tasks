# -*- coding: utf-8 -*-
"""Shared conformance helpers. Never prints transcript text."""
from __future__ import annotations

import hashlib
import json

from fusion.fuse import fuse
from fusion.normalize import sdi, wtoks

ARM_CONFIG = {
    "W": {"arm": "W", "guard": False},
    "rules_off": {"arm": "rules", "guard": False},
    "rules_on": {"arm": "rules", "guard": True},
}

# High enough that a 391-window fixture is always a single chunk: the longest
# hypothesis in the bundle is well under 2000 tokens.
SINGLE_CHUNK = {"max_tokens": 100000, "anchor_n": 3, "search_radius": 200}


def toks_sha(tokens) -> str:
    return hashlib.sha256(
        json.dumps(list(tokens), ensure_ascii=False).encode()).hexdigest()[:16]


def as_words(norm_tokens, conf=0.9):
    """Fixture norm tokens as oc-fusion-in/1 words with synthetic times."""
    return [{"raw": t, "start": i * 0.5, "end": i * 0.5 + 0.4, "conf": conf}
            for i, t in enumerate(norm_tokens)]


def payload_for(hyps, arm, chunking=None, audio_sha="0" * 64):
    ids = ("scribe", "soniox", "ours")
    cfg = dict(ARM_CONFIG[arm])
    cfg["llm"] = None
    cfg["chunking"] = dict(chunking or SINGLE_CHUNK)
    return {
        "schema": "oc-fusion-in/1",
        "audio_sha256": audio_sha,
        "systems": [{"id": ids[k], "params_sha": f"sha-{ids[k]}",
                     "words": as_words(hyps[k])} for k in range(3)],
        "config": cfg,
    }


def run_window(win, arm, chunking=None):
    """Fuse one fixture window. Returns the oc-fusion/1 output."""
    return fuse(payload_for(win["hyps"], arm, chunking))


def fused_norm(out):
    return [t["norm"] for t in out["tokens"]]


def score(ref_tokens, hyp_tokens):
    return sdi(" ".join(ref_tokens), " ".join(hyp_tokens))


def assert_tokens_are_atomic(win):
    """Every fixture token must normalize to itself, or feeding them as raw
    words would not reproduce the frozen streams."""
    for h in win["hyps"]:
        for t in h:
            assert wtoks(t) == [t], f"fixture token is not wtoks-stable: {toks_sha([t])}"
