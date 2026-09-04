# -*- coding: utf-8 -*-
"""Three-way MSA and per-column voting, ported verbatim from
eval/controlled_eval/msa.py (align3, vote_column, compose) and the band sizing
from eval/controlled_eval/atlas_substrate.py (_band).

ALIGNMENT. Exact three-way dynamic programming with unit-cost sum-of-pairs,
banded. Banding is an optimisation with a guard, not a silent approximation:
`align3` widens the band and re-runs whenever the recovered path pressed against
the band edge.

VOTING is hierarchical: vote on OCCUPANCY first (token vs epsilon), then on
identity inside the winning class. A flat vote in which epsilon is just another
candidate deletes speech that two of three systems heard.

Nothing in this file may change: every frozen number in CONTRACT.md is a
function of these exact tie-breaks.
"""
from __future__ import annotations

# Transition order, frozen. Bitmask A=1, B=2, C=4. Ties in cost AND column count
# are broken by the first entry of this list, so it is part of the frozen design.
ORDER = (7, 3, 5, 6, 1, 2, 4)

INF = float("inf")
COLS_BITS = 12                 # score = cost << COLS_BITS | n_columns
COLS_MASK = (1 << COLS_BITS) - 1


def band_for(toks) -> int:
    """`_band` from atlas_substrate.py: floor the band at the largest pairwise
    length difference plus slack, never below 40."""
    lo, hi = min(len(t) for t in toks), max(len(t) for t in toks)
    return max(40, hi - lo + 20)


def _pair(x, y) -> int:
    """Unit cost of one pair of column entries (None is epsilon)."""
    if x is None and y is None:
        return 0
    if x is None or y is None:
        return 1
    return 0 if x == y else 1


def _col_cost(ea, eb, ec) -> int:
    return _pair(ea, eb) + _pair(ea, ec) + _pair(eb, ec)


def columns_cost(cols) -> int:
    return sum(_col_cost(*c) for c in cols)


def align3(a: list[str], b: list[str], c: list[str], band: int = 40):
    """Exact sum-of-pairs 3-way alignment. Returns a list of (ea, eb, ec) columns."""
    na, nb, nc = len(a), len(b), len(c)
    if na == 0 and nb == 0 and nc == 0:
        return []
    lim = max(na, nb, nc) + 1
    while True:
        cols, touched = _align3_banded(a, b, c, band)
        if not touched or band >= lim:
            return cols
        band = min(band * 2, lim)


def _align3_banded(a, b, c, band):
    na, nb, nc = len(a), len(b), len(c)
    stride = nc + 1
    size = (nb + 1) * stride

    prev = [INF] * size
    cur = [INF] * size
    ops: list[bytearray] = []

    for i in range(na + 1):
        layer = bytearray(size)
        if i:
            prev, cur = cur, [INF] * size
        ai = a[i - 1] if i else None
        jlo, jhi = max(0, i - band), min(nb, i + band)
        klo, khi = max(0, i - band), min(nc, i + band)
        for j in range(jlo, jhi + 1):
            bj = b[j - 1] if j else None
            base = j * stride
            for k in range(klo, khi + 1):
                if i == 0 and j == 0 and k == 0:
                    cur[0] = 0
                    continue
                if abs(j - k) > band:
                    continue
                ck = c[k - 1] if k else None
                best = INF
                bestop = 0
                for m in ORDER:
                    pi = i - 1 if m & 1 else i
                    pj = j - 1 if m & 2 else j
                    pk = k - 1 if m & 4 else k
                    if pi < 0 or pj < 0 or pk < 0:
                        continue
                    src = prev if (m & 1) else cur
                    v = src[pj * stride + pk]
                    if v == INF:
                        continue
                    ea = ai if m & 1 else None
                    eb = bj if m & 2 else None
                    ec = ck if m & 4 else None
                    cost = _col_cost(ea, eb, ec)
                    cand = v + (cost << COLS_BITS) + 1
                    if cand < best:
                        best = cand
                        bestop = m
                cur[base + k] = best
                layer[base + k] = bestop
        ops.append(layer)

    if cur[nb * stride + nc] == INF:
        return [], True

    # backtrace
    cols = []
    i, j, k = na, nb, nc
    touched = False
    while i or j or k:
        if abs(i - j) >= band or abs(i - k) >= band or abs(j - k) >= band:
            touched = True
        m = ops[i][j * stride + k]
        if not m:
            return [], True
        ea = a[i - 1] if m & 1 else None
        eb = b[j - 1] if m & 2 else None
        ec = c[k - 1] if m & 4 else None
        cols.append((ea, eb, ec))
        if m & 1:
            i -= 1
        if m & 2:
            j -= 1
        if m & 4:
            k -= 1
    cols.reverse()
    return cols, touched


def vote_column(col, pivot: int, priority=(0, 1, 2)):
    """Hierarchical vote on one column. Returns (token or None, reason)."""
    toks = [e for e in col if e is not None]
    if len(toks) < 2:
        return None, "epsilon"
    counts: dict[str, int] = {}
    for t in toks:
        counts[t] = counts.get(t, 0) + 1
    top = max(counts.values())
    winners = [t for t, n in counts.items() if n == top]
    if len(winners) == 1:
        if top == 3:
            return winners[0], "unanimous"
        return winners[0], "majority"
    if col[pivot] is not None and col[pivot] in winners:
        return col[pivot], "tie_pivot"
    for p in priority:
        if col[p] is not None and col[p] in winners:
            return col[p], "tie_priority"
    return winners[0], "tie_priority"


def compose(cols, pivot: int, priority=(0, 1, 2)):
    """Vote every column. Returns (tokens, per-column decisions)."""
    toks, decisions = [], []
    for n, col in enumerate(cols):
        tok, why = vote_column(col, pivot, priority)
        decisions.append({"col": n, "token": tok, "reason": why})
        if tok is not None:
            toks.append(tok)
    return toks, decisions


def column_indices(cols, lengths=None):
    """Per-column token index into each system's stream, or None for epsilon.

    align3 consumes the three streams strictly left to right, so the index of a
    column entry is just how many entries that system has already contributed.
    The fusion pipeline needs this to map a chosen token back to a raw word.
    """
    cnt = [0, 0, 0]
    out = []
    for col in cols:
        row = [None, None, None]
        for k in range(3):
            if col[k] is not None:
                row[k] = cnt[k]
                cnt[k] += 1
        out.append(tuple(row))
    return out


def consensus_pivot(streams: list[list[str]]) -> int:
    """`_consensus_pivot` from atlas_substrate.py: the hypothesis closest to the
    other two by summed WER. Never sees the reference."""
    from .normalize import sdi
    texts = [" ".join(s) for s in streams]
    best, best_score = 0, None
    for pi in range(3):
        score = 0.0
        for qi in range(3):
            if qi == pi:
                continue
            s, d, i, r = sdi(texts[qi], texts[pi])
            score += (s + d + i) / max(1, r)
        if best_score is None or score < best_score:
            best, best_score = pi, score
    return best
