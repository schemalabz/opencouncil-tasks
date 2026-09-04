# -*- coding: utf-8 -*-
"""Load and hash-check the frozen routing policy.

`policy.json` is a VERBATIM copy of
eval/controlled_eval/chooser/freeze.json (protocol autoprompt-2026-08-25a). It
holds category names, routing modes and Greek instruction text — no transcript
text. Its sha256 prefix is checked at import: a policy that drifted is not the
policy the frozen numbers were measured under, so we refuse to run rather than
quietly produce different output.

The LLM wire envelope lives in a separate `llm_envelope.json` precisely so
policy.json can stay byte-identical to freeze.json.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
POLICY_PATH = HERE / "policy.json"
ENVELOPE_PATH = HERE / "llm_envelope.json"

POLICY_SHA16 = "3e5676d982078979"


class PolicyError(RuntimeError):
    pass


def _sha16(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()[:16]


def _load():
    try:
        blob = POLICY_PATH.read_bytes()
    except OSError as e:                                   # pragma: no cover
        raise PolicyError(f"policy.json unreadable: {e}") from e
    got = _sha16(blob)
    if got != POLICY_SHA16:
        raise PolicyError(
            f"policy.json sha256[:16] is {got}, expected {POLICY_SHA16} — "
            "the frozen policy has drifted; refusing to run")
    return json.loads(blob.decode("utf-8"))


FREEZE = _load()
POLICY: dict = FREEZE["policy"]
LLM_CATEGORIES = tuple(sorted(k for k, v in POLICY.items() if v["mode"] == "llm"))

ENVELOPE = json.loads(ENVELOPE_PATH.read_bytes().decode("utf-8"))
ENVELOPE_SHA16 = _sha16(ENVELOPE_PATH.read_bytes())
