# -*- coding: utf-8 -*-
"""Text normalization, ported verbatim from eval/controlled_eval/scoring.py.

Normalization is deliberately shallow: NFD, strip combining marks, lowercase, and
split on `\\w+`. It does NOT fold final sigma, so `ς` and `σ` are distinct tokens.

Do not "improve" this. Every frozen WER in CONTRACT.md was measured through it.

On top of the ported scorer this module adds the raw <-> norm map the fusion
pipeline needs: one raw provider word yields 0..n normalized tokens, and the
fused output has to name the raw word each chosen token came from.
"""
from __future__ import annotations

import re
import unicodedata

NORMALIZER_REV = "wtoks/1"


def norm(s):
    s = unicodedata.normalize("NFD", s or "")
    return "".join(c for c in s if unicodedata.category(c) != "Mn").lower()


def wtoks(s):
    return re.findall(r"\w+", norm(s))


def edist(a, b):
    """Levenshtein distance over any two sequences."""
    n, m = len(a), len(b)
    if n == 0:
        return m
    prev = list(range(m + 1))
    for i in range(1, n + 1):
        cur = [i] + [0] * m
        for j in range(1, m + 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] != b[j - 1]))
        prev = cur
    return prev[m]


def sdi(ref: str, hyp: str) -> tuple[int, int, int, int]:
    """Levenshtein with a backtrace, returning (S, D, I, N_ref).

    Ported verbatim from eval/controlled_eval/exp_fusion_deletions.py. `edist`
    gives the distance only; the consensus pivot and every conformance number
    need the split.
    """
    a, b = wtoks(ref), wtoks(hyp)
    n, m = len(a), len(b)
    d = [[0] * (m + 1) for _ in range(n + 1)]
    op = [[""] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        d[i][0], op[i][0] = i, "D"
    for j in range(1, m + 1):
        d[0][j], op[0][j] = j, "I"
    for i in range(1, n + 1):
        ai = a[i - 1]
        di, dim1 = d[i], d[i - 1]
        opi = op[i]
        for j in range(1, m + 1):
            if ai == b[j - 1]:
                di[j], opi[j] = dim1[j - 1], "M"
                continue
            sub, dele, ins = dim1[j - 1] + 1, dim1[j] + 1, di[j - 1] + 1
            best = min(sub, dele, ins)
            di[j] = best
            opi[j] = "S" if best == sub else ("D" if best == dele else "I")
    s = dd = ii = 0
    i, j = n, m
    while i > 0 or j > 0:
        o = op[i][j]
        if o == "M":
            i, j = i - 1, j - 1
        elif o == "S":
            s += 1
            i, j = i - 1, j - 1
        elif o == "D":
            dd += 1
            i -= 1
        else:
            ii += 1
            j -= 1
    return s, dd, ii, n


def tokenize_words(raws: list[str]) -> tuple[list[str], list[int]]:
    """Normalize a provider's raw words into one flat token stream + owner map.

    Returns `(tokens, owner)` where `owner[t]` is the index into `raws` of the
    raw word that produced `tokens[t]`. A raw word that normalizes to nothing
    (pure punctuation) contributes no tokens and never appears in `owner`; a raw
    word that normalizes to several tokens appears several times.
    """
    tokens: list[str] = []
    owner: list[int] = []
    for r, w in enumerate(raws):
        for t in wtoks(w):
            tokens.append(t)
            owner.append(r)
    return tokens, owner
