# -*- coding: utf-8 -*-
"""Column classes and disagreement islands.

`column_class` and `split_merge_columns` are ported verbatim from
eval/controlled_eval/column_classes.py; `islands` from
eval/controlled_eval/error_atlas.py. The homophone/eligibility half of
column_classes.py is NOT ported: the frozen arms never call it, and it depends
on the Greek phonetics table which is research-only.
"""
from __future__ import annotations

CLASSES = ("invalid", "singleton", "two_present_same", "agree", "exact_2_of_3",
           "unresolved_two", "unresolved_three")


def column_class(col) -> str:
    present = [e for e in col if e is not None]
    n, distinct = len(present), set(present)
    if n == 0:
        return "invalid"
    if n == 1:
        return "singleton"
    if len(distinct) == 1:
        return "agree" if n == 3 else "two_present_same"
    if n == 3 and len(distinct) == 2:
        return "exact_2_of_3"
    return "unresolved_three" if n == 3 else "unresolved_two"


def split_merge_columns(cols) -> set[int]:
    """Indices of columns caught in a token-boundary disagreement.

    Two systems spell the same character string across one adjacent pair of
    columns but cut it in different places, e.g. (στο, σ, eps) followed by
    (eps, το, στο). Voting the two columns independently cannot reconstruct
    either spelling.
    """
    bad: set[int] = set()
    for i in range(len(cols) - 1):
        joined = []
        for s in range(3):
            a = cols[i][s] or ""
            b = cols[i + 1][s] or ""
            joined.append((a + b, (cols[i][s], cols[i + 1][s])))
        for x in range(3):
            for y in range(x + 1, 3):
                jx, sx = joined[x]
                jy, sy = joined[y]
                if jx and jx == jy and sx != sy:
                    bad.add(i)
                    bad.add(i + 1)
    return bad


def islands(cols):
    """Maximal runs of consecutive non-`agree` columns, as (start, end) half-open.

    This is a description of the frozen MSA, not of a linguistic error span: an
    `agree` column can sit inside a wider boundary disagreement and cut it in
    two, and two unrelated errors one column apart merge into one island.
    """
    out, s = [], None
    for i, c in enumerate(cols):
        if column_class(c) != "agree":
            if s is None:
                s = i
        elif s is not None:
            out.append((s, i))
            s = None
    if s is not None:
        out.append((s, len(cols)))
    return out
