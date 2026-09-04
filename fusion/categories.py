# -*- coding: utf-8 -*-
"""Island category scheme, ported verbatim from
eval/controlled_eval/chooser/cats.py.

  FOUR ORDERED SPECIAL ROUTES, tested in this order so every island lands in
  exactly one bucket:
     NUM   every candidate is equal once numbers are normalised
     FILL  candidates differ only by tokens from a frozen Greek filler lexicon
     DUP   candidates differ only by exact duplication of adjacent context
     LOW   equal only after BOTH filler removal and duplicate collapse

  THEN 13 ISLAND-LEVEL SIGNATURES, on the three systems' whole spans. Which
  PAIR agrees is part of the signature, because "scribe+soniox agree" is not
  the same evidence as "soniox+ours agree".
     PAIR_x    two identical non-empty spans, third different and non-empty  (3)
     PAIRE_x   two identical non-empty spans, third empty                    (3)
     SOLO_x    one non-empty span, two empty                                 (3)
     TWO_x     two different non-empty spans, third empty                    (3)
     THREE     three different non-empty spans                               (1)
"""
from __future__ import annotations

import re
from collections import defaultdict

SHORT = ["scribe", "soniox", "ours"]

FILLERS = {"εε", "εεε", "εεεε", "ε", "μμ", "μμμ", "αα", "ααα", "ααμ", "χμ",
           "ε ε", "ναι ναι"}

UNITS = {"μηδεν": 0, "ενα": 1, "δυο": 2, "τρια": 3, "τρεις": 3, "τεσσερα": 4,
         "τεσσερις": 4, "πεντε": 5, "εξι": 6, "εφτα": 7, "επτα": 7, "οχτω": 8,
         "οκτω": 8, "εννια": 9, "εννεα": 9, "δεκα": 10, "εντεκα": 11,
         "δωδεκα": 12, "δεκατρια": 13, "εικοσι": 20, "τριαντα": 30,
         "σαραντα": 40, "πενηντα": 50, "εξηντα": 60, "εβδομηντα": 70,
         "ογδοντα": 80, "ενενηντα": 90, "εκατο": 100, "χιλια": 1000}


def numkey(t):
    if re.fullmatch(r"\d+", t):
        return "#" + str(int(t))
    if t in UNITS:
        return "#" + str(UNITS[t])
    return t


def norm_num(span):
    return tuple(numkey(t) for t in span)


def strip_fill(span):
    return tuple(t for t in span if t not in FILLERS)


def strip_dup(span, ctx):
    return tuple(t for t in span if t not in ctx)


def signature(spans):
    ne = [i for i, s in enumerate(spans) if s]
    if len(ne) == 1:
        return "SOLO_" + SHORT[ne[0]]
    if len(ne) == 2:
        a, b = ne
        if spans[a] == spans[b]:
            return "PAIRE_" + "+".join(SHORT[i] for i in ne)
        return "TWO_no_" + SHORT[[i for i in range(3) if i not in ne][0]]
    d = defaultdict(list)
    for i, s in enumerate(spans):
        d[s].append(i)
    if len(d) == 2:
        pair = [v for v in d.values() if len(v) == 2][0]
        return "PAIR_" + "+".join(SHORT[i] for i in pair)
    return "THREE"
