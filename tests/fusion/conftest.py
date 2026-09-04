# -*- coding: utf-8 -*-
"""Fixture bundle discovery.

The bundle holds verbatim council speech and NEVER goes in git. It lives at
$FUSION_FIXTURES_DIR (default ~/.cache/oc-public/chooser-2026-08-25). Without
it the conformance tests skip with a message that says where to get it.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

DEFAULT_DIR = Path.home() / ".cache/oc-public/chooser-2026-08-25"

REQUIRED = ("fixture_inputs_391.json", "fixture_W_391.json",
            "fixture_rules_off_391.json", "fixture_rules_on_391.json",
            "fixture_policy_islands_391.json", "MANIFEST.json")

_MISSING = ("fixture bundle not found at {d}. It holds transcript text and is "
            "never committed; regenerate it with "
            "eval/controlled_eval/chooser/make_fixtures.py in the research "
            "repo, or point FUSION_FIXTURES_DIR at an existing copy.")


def bundle_dir() -> Path:
    return Path(os.environ.get("FUSION_FIXTURES_DIR") or DEFAULT_DIR)


def have_bundle() -> bool:
    d = bundle_dir()
    return all((d / n).is_file() for n in REQUIRED)


def _load(name):
    return json.loads((bundle_dir() / name).read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def fixtures_dir() -> Path:
    d = bundle_dir()
    if not have_bundle():
        pytest.skip(_MISSING.format(d=d))
    return d


@pytest.fixture(scope="session")
def fx_inputs(fixtures_dir):
    return _load("fixture_inputs_391.json")


@pytest.fixture(scope="session")
def fx_arms(fixtures_dir):
    return {"W": _load("fixture_W_391.json"),
            "rules_off": _load("fixture_rules_off_391.json"),
            "rules_on": _load("fixture_rules_on_391.json")}


@pytest.fixture(scope="session")
def fx_policy(fixtures_dir):
    return _load("fixture_policy_islands_391.json")


@pytest.fixture(scope="session")
def fx_manifest(fixtures_dir):
    return _load("MANIFEST.json")
