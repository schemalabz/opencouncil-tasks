# -*- coding: utf-8 -*-
"""Expected values for the normalizer edge cases, taken from the Python itself.

The inputs come from a review that was asked what would break a port: polytonic
Greek, iota subscript, diaeresis, sigma in contexts where lowercasing and
splitting interact, every space and invisible character, marks the port must
keep versus the ones it must strip, digits in other scripts, and supplementary
planes. The expected values are not that review's guesses; they are whatever
`fusion/normalize.py` actually answers, which is the only thing a port owes.

    python3 tests/fusion/normalize_edge_vectors.py > src/lib/fusion/engine/normalize.vectors.json
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

from fusion.normalize import norm, tokenize_words, wtoks  # noqa: E402

SEPARATORS = [
    " ", "\t", "\n", "\r", "\v", "\f", "", " ",
    " ", " ", " ", " ", " ", " ",
    " ", " ", "　",
    "​", "‌", "‍", "⁠", "﻿",
]

INPUTS = [
    None, "", " \t\n", "!!!…—",
    "́ͅ",
    "Ἄνθρωπος Ἅδης ὠδή",
    "ᾳ ῃ ῳ ᾼ ῌ ῼ",
    "ΐ ΰ Ϊ Ϋ Μαΐου",
    "ά", "ά", "ᾳβ", "άβ",
    "ς σ", "ΟΣ", "ΟΣ-Α", "ΟΣ'Α",
    "ΟΣ’Α", "ΟΔΟΣ", "ΆΣ",
    "ΣΥΜΒΟΥΛΙΟΣ",
    "١٢ ۱۲ १२ １２",
    "1.234,56 −42 12/09",
    "007", "0", "00",
    "α_β", "__", "α2β",
    "i", "ß", "straße", "STRASSE",
    "aाb", "a⃝b", "a️b", "a\U000e0100b",
    "\U00010400\U00010428",
    "\U0001d400 \U0001d7d8",
    "α\U0001f600β", "\U0001f469‍\U0001f4bb",
] + ["Α" + q + "Β" for q in SEPARATORS]

TOKENIZE_INPUTS = [
    [],
    ["..."],
    ["γεια", "σου"],
    ["...", "γεια"],
    ["γεια", "..."],
    ["...", "..."],
    ["γεια-σου"],
    ["γεια-σου", "κοσμε"],
    ["...", "γεια-σου", "...",
     "κοσμε", "..."],
    ["", " ", "́"],
]


def main() -> int:
    out = {
        "schema": "oc-fusion-normalize-edge/1",
        "note": "expected values produced by fusion/normalize.py",
        "cases": [
            {"input": s, "norm": norm(s), "wtoks": wtoks(s)} for s in INPUTS
        ],
        "tokenize": [],
    }
    for raws in TOKENIZE_INPUTS:
        tokens, owner = tokenize_words(raws)
        out["tokenize"].append({"raws": raws, "tokens": tokens, "owner": owner})
    json.dump(out, sys.stdout, ensure_ascii=False, indent=1, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
