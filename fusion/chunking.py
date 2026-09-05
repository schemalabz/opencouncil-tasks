# -*- coding: utf-8 -*-
"""Text-level chunking, so `align3` never sees more than `max_tokens` per system.

align3 is O(n^3) in time and memory over the three token counts. A 20-minute
segment is several thousand tokens per system and would not fit. This module
cuts the three streams at points where all three agree on the local text, so
each chunk can be fused independently and the results concatenated.

ALGORITHM (frozen as `chunk/1`, deterministic — no timing, no randomness):

1. If all three remaining streams are <= max_tokens, emit one final chunk.
2. Otherwise aim at `max_tokens * 0.8` tokens into the scribe stream and look
   for an ANCHOR within +/- search_radius scribe tokens: an n-gram of
   `anchor_n` normalized tokens that occurs EXACTLY ONCE inside each stream's
   search neighbourhood, with match positions that are temporally consistent
   (each stream's match sits at a similar relative offset inside its own
   neighbourhood — see TEMPORAL_TOLERANCE).
3. Cut all three streams immediately BEFORE the anchor. The anchor stays with
   the following chunk. No overlap is needed: a unique, unanimous n-gram is
   already the alignment at that point.
4. No anchor found => FORCED CUT at the proportional position in each stream,
   and `forced_cuts` is incremented. A forced cut can split an island; that is
   the honest cost of not finding an anchor and it is counted, not hidden.
5. Candidate anchor positions are tried in order of distance from the target,
   nearer first, lower index first on a tie.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass

CHUNK_REV = "chunk/1"

# Fraction of max_tokens we aim at when placing a cut. Leaves headroom so the
# anchor search can move the cut later without exceeding max_tokens.
CUT_FRACTION = 0.8

# How far two streams' relative match offsets may differ and still count as
# "the same moment". 0.5 of a neighbourhood width; wider than this and the
# n-gram is probably a recurrence, not the same utterance.
TEMPORAL_TOLERANCE = 0.5


@dataclass(frozen=True)
class ChunkConfig:
    rev: str = CHUNK_REV
    max_tokens: int = 800
    anchor_n: int = 3
    search_radius: int = 200
    min_pause_fallback: float | None = None

    def as_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict | None) -> "ChunkConfig":
        d = dict(d or {})
        d.pop("rev", None)
        d.pop("n_chunks", None)
        d.pop("forced_cuts", None)
        d.pop("seams", None)
        known = {"max_tokens", "anchor_n", "search_radius", "min_pause_fallback"}
        unknown = set(d) - known
        if unknown:
            raise ValueError(f"unknown chunking keys: {sorted(unknown)}")
        cfg = cls(**d)
        if cfg.max_tokens < 1:
            raise ValueError("chunking.max_tokens must be >= 1")
        if cfg.anchor_n < 1:
            raise ValueError("chunking.anchor_n must be >= 1")
        if cfg.search_radius < 0:
            raise ValueError("chunking.search_radius must be >= 0")
        return cfg


def _neighbourhood(lo, hi, centre, radius):
    """Half-open [start, end) clamped into [lo, hi)."""
    return max(lo, centre - radius), min(hi, centre + radius + 1)


def _occurrences(stream, gram, lo, hi):
    """Start positions of `gram` fully inside [lo, hi). Stops at 2 — we only
    ever ask whether the count is exactly one."""
    n = len(gram)
    hits = []
    for p in range(lo, hi - n + 1):
        if stream[p:p + n] == gram:
            hits.append(p)
            if len(hits) > 1:
                break
    return hits


def _proportional(offsets, ends, k, scribe_cut):
    """Where a cut at `scribe_cut` in the scribe stream lands in stream k."""
    o0, e0 = offsets[0], ends[0]
    ok, ek = offsets[k], ends[k]
    span0 = e0 - o0
    if span0 <= 0:
        return ok
    frac = (scribe_cut - o0) / span0
    return ok + int(round(frac * (ek - ok)))


def _find_anchor(streams, offsets, ends, cfg):
    """Returns [cut0, cut1, cut2] (cut before the anchor) or None."""
    n = cfg.anchor_n
    o0, e0 = offsets[0], ends[0]
    if e0 - o0 <= n:
        return None
    target = o0 + max(1, int(CUT_FRACTION * cfg.max_tokens))
    target = min(max(target, o0 + 1), e0 - n)

    nb = [None, None, None]
    nb[0] = _neighbourhood(o0, e0, target, cfg.search_radius)
    for k in (1, 2):
        centre = _proportional(offsets, ends, k, target)
        nb[k] = _neighbourhood(offsets[k], ends[k], centre, cfg.search_radius)

    lo0, hi0 = nb[0]
    candidates = sorted(range(lo0, max(lo0, hi0 - n + 1)),
                        key=lambda p: (abs(p - target), p))
    for p in candidates:
        gram = streams[0][p:p + n]
        if len(gram) < n:
            continue
        hits = [None, None, None]
        ok = True
        for k in range(3):
            h = _occurrences(streams[k], gram, nb[k][0], nb[k][1])
            if len(h) != 1:
                ok = False
                break
            hits[k] = h[0]
        if not ok:
            continue
        # temporal consistency: same relative offset inside each neighbourhood
        rel = []
        for k in range(3):
            lo, hi = nb[k]
            width = max(1, (hi - n) - lo)
            rel.append((hits[k] - lo) / width)
        if max(rel) - min(rel) > TEMPORAL_TOLERANCE:
            continue
        # A cut must make progress in every stream, leave work behind, and hand
        # align3 no more than max_tokens from ANY stream. The ops table
        # allocates n**3 bytes, so one oversized stream is the whole failure --
        # capping only scribe's side would still blow up on a verbose system.
        if any(hits[k] <= offsets[k] or hits[k] >= ends[k]
               or hits[k] - offsets[k] > cfg.max_tokens for k in range(3)):
            continue
        return list(hits)
    return None


def _forced(streams, offsets, ends, cfg):
    o0, e0 = offsets[0], ends[0]
    if e0 - o0 > 1:
        cut0 = min(max(o0 + max(1, int(CUT_FRACTION * cfg.max_tokens)), o0 + 1), e0 - 1)
    else:
        cut0 = e0
    cuts = [cut0]
    for k in (1, 2):
        c = _proportional(offsets, ends, k, cut0) if e0 - o0 > 0 else offsets[k]
        c = min(max(c, offsets[k]), ends[k])
        cuts.append(c)
    # A proportional cut follows scribe's fraction of its own remaining span, so
    # a stream several times longer than scribe's can be handed a span far past
    # max_tokens -- the n**3 MemoryError this module exists to prevent.
    cuts = [min(cuts[k], offsets[k] + cfg.max_tokens) for k in range(3)]
    # guarantee progress: at least one stream must advance
    if all(cuts[k] <= offsets[k] for k in range(3)):
        for k in range(3):
            if ends[k] > offsets[k]:
                cuts[k] = min(ends[k], offsets[k] + max(1, cfg.max_tokens))
    return cuts


def plan_chunks(streams, cfg: ChunkConfig):
    """Returns (chunks, forced_cuts) where chunks is a list of
    [(s0,e0), (s1,e1), (s2,e2)] index ranges covering each stream exactly once."""
    ends = [len(s) for s in streams]
    offsets = [0, 0, 0]
    chunks = []
    forced = 0
    guard = 0
    while True:
        guard += 1
        if guard > 10000:                                  # pragma: no cover
            raise RuntimeError("chunking failed to terminate")
        remaining = [ends[k] - offsets[k] for k in range(3)]
        if max(remaining) <= cfg.max_tokens:
            chunks.append([(offsets[k], ends[k]) for k in range(3)])
            return chunks, forced
        cuts = _find_anchor(streams, offsets, ends, cfg)
        if cuts is None:
            cuts = _forced(streams, offsets, ends, cfg)
            forced += 1
        chunks.append([(offsets[k], cuts[k]) for k in range(3)])
        if all(cuts[k] <= offsets[k] for k in range(3)):    # pragma: no cover
            raise RuntimeError("chunking made no progress")
        offsets = list(cuts)
