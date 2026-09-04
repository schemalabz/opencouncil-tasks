# -*- coding: utf-8 -*-
"""Island analysis and the deterministic arms.

`classify`, `window_parts`, `RULES` and the per-arm `build` logic are ported
from eval/controlled_eval/chooser/reconstruct.py; `apply_guard` verbatim from
eval/controlled_eval/chooser/make_fixtures.py.

The one structural change from the research code is PROVENANCE, not logic: every
token this module produces is carried as a `(token, system_index, column_index)`
triple instead of a bare string, so `fuse.py` can name the raw provider word
behind each output token. Strip the triples with `toks()` and the sequences are
byte-identical to the research code's lists — which is what the conformance
suite proves.

Guard definition (frozen, spec §4.1): an island is guarded iff (a) after
removing every token in {ναι, δεν} the three candidate spans are identical,
(b) at least one span contains such a token, and (c) the arm's island output
contains none. Then the output is replaced by the span with the most critical
tokens (ties: the longest, then scribe > soniox > ours).
"""
from __future__ import annotations

import hashlib
import json

from . import categories as C
from .islands import column_class, islands, split_merge_columns
from .msa import vote_column

CRIT = ("ναι", "δεν")

# Rule names are the frozen Greek strings used in policy.json.
RULE_VOTE = "ψήφος"
RULE_R12 = "R1+R2"
RULE_SCRIBE = "Scribe"
RULE_DELETE = "σβήσε"


def toks(triples):
    """The bare token list behind a list of (token, system, column) triples."""
    return [t for t, _s, _c in triples]


def classify(cols, span, sm, ctx):
    """Port of reconstruct.classify — note it does NOT append |ATOMIC/|COMPOSITE
    to the TWO_/SOLO_/PAIRE_ signatures, unlike cats.py's variant."""
    spans = [tuple(x for x in (cols[i][k] for i in span) if x is not None)
             for k in range(3)]
    ragged = len({len(x) for x in spans}) > 1
    composite = ragged or any(i in sm for i in span)
    if len({C.norm_num(x) for x in spans}) == 1:
        return "NUM", spans
    if len({C.strip_fill(x) for x in spans}) == 1:
        return "FILL", spans
    if len({C.strip_dup(x, ctx) for x in spans}) == 1:
        return "DUP", spans
    if len({C.strip_dup(C.strip_fill(x), ctx) for x in spans}) == 1:
        return "LOW", spans
    sig = C.signature(spans)
    if sig.startswith(("TWO_", "SOLO_", "PAIRE_")):
        return sig, spans
    return sig + ("|COMPOSITE" if composite else "|ATOMIC"), spans


def _vote_source(col, token):
    """Which system supplied a voted token. Frozen priority scribe>soniox>ours."""
    for k in range(3):
        if col[k] == token:
            return k
    return None


def window_parts(cols, pivot: int):
    """(islands, tail, wsel, wsrc) — enough to rebuild any arm's text.

    `cols` is the aligned column list, `pivot` the consensus pivot index.
    Each island dict carries both the frozen plain-token fields the research
    code produced (`cat`, `spans`, `vote`, `r12`, `L`, `R`, `before`) and the
    provenance triples (`vote_tr`, `r12_tr`, `span_tr`, `before_tr`).
    """
    cols = [tuple(c) for c in cols]
    wsel = [vote_column(c, pivot)[0] for c in cols]
    wsrc = [(_vote_source(cols[i], wsel[i]) if wsel[i] is not None else None)
            for i in range(len(cols))]
    sm = split_merge_columns(cols)
    out, prev = [], 0
    for (s, e) in islands(cols):
        span = list(range(s, e))
        L = [cols[i][0] for i in range(max(0, s - 12), s)
             if column_class(cols[i]) == "agree"]
        R = [cols[i][0] for i in range(e, min(len(cols), e + 12))
             if column_class(cols[i]) == "agree"]
        cat, spans = classify(cols, span, sm, set(L[-3:]) | set(R[:3]))

        vote_tr = [(wsel[i], wsrc[i], i) for i in span if wsel[i] is not None]
        r12_tr = []
        for i in span:
            k = column_class(cols[i])
            if k == "unresolved_two":
                continue
            if k == "unresolved_three":
                t, src = cols[i][0], 0
            else:
                t, src = wsel[i], wsrc[i]
            if t is not None:
                r12_tr.append((t, src, i))
        span_tr = [[(cols[i][k], k, i) for i in span if cols[i][k] is not None]
                   for k in range(3)]
        before_tr = [(cols[i][0], 0, i) for i in range(prev, s)
                     if column_class(cols[i]) == "agree"]

        out.append({
            "s": s, "e": e, "cat": cat, "spans": [list(x) for x in spans],
            "vote": toks(vote_tr), "r12": toks(r12_tr),
            "L": " ".join(L[-8:]), "R": " ".join(R[:8]),
            "before": toks(before_tr),
            "vote_tr": vote_tr, "r12_tr": r12_tr, "span_tr": span_tr,
            "before_tr": before_tr,
        })
        prev = e
    tail_tr = [(cols[i][0], 0, i) for i in range(prev, len(cols))
               if column_class(cols[i]) == "agree"]
    return out, tail_tr, wsel, wsrc


RULES = {RULE_VOTE: lambda i: i["vote_tr"],
         RULE_R12: lambda i: i["r12_tr"],
         RULE_SCRIBE: lambda i: i["span_tr"][0],
         RULE_DELETE: lambda i: []}


def apply_guard(spans, out):
    """Verbatim from make_fixtures.apply_guard, over plain token lists."""
    core = [[t for t in sp if t not in CRIT] for sp in spans]
    if not (core[0] == core[1] == core[2]):
        return out, False
    n_crit = [sum(t in CRIT for t in sp) for sp in spans]
    if not any(n_crit):
        return out, False
    if any(t in CRIT for t in out):
        return out, False
    k = max(range(3), key=lambda i: (n_crit[i], len(spans[i]), -i))
    return list(spans[k]), True


def apply_guard_tr(isl, out_tr):
    """`apply_guard` on triples: the replacement span is a whole system's span,
    so its provenance is `span_tr[k]`."""
    spans = [list(x) for x in isl["spans"]]
    core = [[t for t in sp if t not in CRIT] for sp in spans]
    if not (core[0] == core[1] == core[2]):
        return out_tr, False
    n_crit = [sum(t in CRIT for t in sp) for sp in spans]
    if not any(n_crit):
        return out_tr, False
    if any(t in CRIT for t in toks(out_tr)):
        return out_tr, False
    k = max(range(3), key=lambda i: (n_crit[i], len(spans[i]), -i))
    return list(isl["span_tr"][k]), True


def row_sha(i):
    """The render-row hash the policy fixtures key on. Verbatim from
    make_fixtures.row_sha."""
    row = {"L": i["L"], "R": i["R"], "spans": i["spans"], "r12": i["r12"]}
    return hashlib.sha256(
        json.dumps(row, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:16]


def island_route(policy, cat):
    """(route, rule) for a category under a policy dict. Matches make_fixtures."""
    p = policy.get(cat)
    if not p:
        return "vote", None
    return p["mode"], (p.get("rule") if p["mode"] == "rule" else None)
