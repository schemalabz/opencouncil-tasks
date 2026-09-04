#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""oc-fusion-in/1 on stdin -> oc-fusion/1 on stdout.

The Python half of the fusion boundary described in fusion/CONTRACT.md. It does
alignment and island rules; the TypeScript half does provider orchestration,
timing and transcript assembly. Diagnostics go to stderr, never stdout.

Exit codes: 0 success, 2 malformed input (a one-line JSON error on stderr).

No network is touched unless `config.llm` is set.

NOTE on `text`: one raw provider word can normalize to several tokens
("2026," -> ["2026"], "κ.λπ" -> ["κ", "λπ"]). When it does, several consecutive
output tokens carry the SAME `src`/`src_word` and the same raw `text`; their
`norm` fields differ. TS should treat a run of tokens sharing (src, src_word) as
one raw word.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

if __package__ in (None, ""):                              # direct `python3 fusion/fuse.py`
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    __package__ = "fusion"

from . import chooser as CH                                # noqa: E402
from . import rules as R                                   # noqa: E402
from .chunking import ChunkConfig, plan_chunks             # noqa: E402
from .islands import column_class                          # noqa: E402
from .msa import align3, band_for, column_indices, consensus_pivot  # noqa: E402
from .normalize import NORMALIZER_REV, tokenize_words      # noqa: E402
from .policy import ENVELOPE, ENVELOPE_SHA16, POLICY, POLICY_SHA16  # noqa: E402

CODE_REV = "fusion/1"
IN_SCHEMA = "oc-fusion-in/1"
OUT_SCHEMA = "oc-fusion/1"
SYSTEM_IDS = ("scribe", "soniox", "ours")
ARMS = ("W", "rules", "policy")
AGREEMENT = {3: 1.0, 2: 0.67}


class InputError(ValueError):
    pass


# ------------------------------------------------------------------ validation
def _validate(payload) -> dict:
    if not isinstance(payload, dict):
        raise InputError("payload is not an object")
    if payload.get("schema") != IN_SCHEMA:
        raise InputError(f"schema must be {IN_SCHEMA!r}, got {payload.get('schema')!r}")
    systems = payload.get("systems")
    if not isinstance(systems, list) or len(systems) != 3:
        raise InputError("systems must be a list of exactly 3 entries")
    for want, s in zip(SYSTEM_IDS, systems):
        if not isinstance(s, dict):
            raise InputError("each system must be an object")
        if s.get("id") != want:
            raise InputError(f"systems must be ordered {list(SYSTEM_IDS)}; "
                             f"got {s.get('id')!r} where {want!r} was expected")
        words = s.get("words")
        if not isinstance(words, list):
            raise InputError(f"systems[{want}].words must be a list")
        for w in words:
            if not isinstance(w, dict) or not isinstance(w.get("raw"), str):
                raise InputError(f"systems[{want}].words[].raw must be a string")
            c = w.get("conf")
            if c is not None and not isinstance(c, (int, float)):
                raise InputError(f"systems[{want}].words[].conf must be a number or null")
    cfg = payload.get("config")
    if cfg is None:
        cfg = {}
    if not isinstance(cfg, dict):
        raise InputError("config must be an object")
    arm = cfg.get("arm", "rules")
    if arm not in ARMS:
        raise InputError(f"config.arm must be one of {list(ARMS)}, got {arm!r}")
    guard = cfg.get("guard", False)
    if not isinstance(guard, bool):
        raise InputError("config.guard must be a boolean")
    llm = cfg.get("llm")
    if llm is not None and not isinstance(llm, dict):
        raise InputError("config.llm must be an object or null")
    try:
        chunk_cfg = ChunkConfig.from_dict(cfg.get("chunking"))
    except (TypeError, ValueError) as e:
        raise InputError(f"config.chunking: {e}") from e
    return {"arm": arm, "guard": guard, "llm": llm, "chunking": chunk_cfg,
            "audio_sha256": payload.get("audio_sha256"), "systems": systems}


# ------------------------------------------------------------------- machinery
def _agreement(col, token):
    n = sum(1 for e in col if e == token)
    return AGREEMENT.get(n, 0.33)


class _Chunk:
    """One independently fused slice of the three streams."""

    def __init__(self, ranges, streams, pivot, cols, parts, tail, col_offset):
        self.ranges = ranges
        self.streams = streams
        self.pivot = pivot
        self.cols = cols
        self.colidx = column_indices(cols)
        self.parts = parts
        self.tail = tail
        self.col_offset = col_offset


def _analyse(tokens, chunk_cfg):
    chunks_plan, forced = plan_chunks(tokens, chunk_cfg)
    out, col_offset = [], 0
    for ranges in chunks_plan:
        sub = [tokens[k][ranges[k][0]:ranges[k][1]] for k in range(3)]
        if not any(sub):
            continue
        pivot = consensus_pivot(sub)
        cols = align3(sub[0], sub[1], sub[2], band=band_for(sub))
        parts, tail, _wsel, _wsrc = R.window_parts(cols, pivot)
        out.append(_Chunk(ranges, sub, pivot, cols, parts, tail, col_offset))
        col_offset += len(cols)
    seams = [c.col_offset for c in out[1:]]
    return out, forced, seams


def _llm_pass(chunks, llm_cfg):
    """Decide every policy-llm island. Returns {(chunk, island_index): record}."""
    need = []
    for ci, ch in enumerate(chunks):
        for k, isl in enumerate(ch.parts):
            p = POLICY.get(isl["cat"])
            if p and p["mode"] == "llm":
                need.append((ci, k, isl))
    decided = {}
    if not need:
        return decided
    batch = int((llm_cfg or {}).get("batch") or ENVELOPE.get("batch") or 15)
    bycat = {}
    for ci, k, isl in need:
        bycat.setdefault(isl["cat"], []).append((ci, k, isl))
    for cat, items in sorted(bycat.items()):
        instr = POLICY[cat]["instr"]
        for s in range(0, len(items), batch):
            group = items[s:s + batch]
            rows = [{"L": i["L"], "R": i["R"], "spans": i["spans"], "r12": i["r12"]}
                    for _, _, i in group]
            picks, err = CH.decide_batch(rows, instr, llm_cfg)
            for j, (ci, k, isl) in enumerate(group):
                if err:
                    decided[(ci, k)] = {"error": err}
                    continue
                toks, sysi, perr = CH.resolve(picks.get(j), isl)
                if perr:
                    decided[(ci, k)] = {"error": perr}
                else:
                    decided[(ci, k)] = {"tokens": toks, "src": sysi,
                                        "confidence": (picks.get(j) or ("", ""))[1]}
    return decided


def _island_output(isl, arm, guard, decided_rec):
    """(triples, stage, rule, guard_fired, llm_record) for one island."""
    llm_rec = None
    if arm == "W":
        tr, stage, rule = isl["vote_tr"], "rule", R.RULE_VOTE
    elif arm == "rules":
        tr, stage, rule = isl["r12_tr"], "rule", R.RULE_R12
    else:
        p = POLICY.get(isl["cat"])
        if p is None:
            tr, stage, rule = isl["vote_tr"], "rule", R.RULE_VOTE
        elif p["mode"] == "rule":
            tr, stage, rule = R.RULES[p["rule"]](isl), "rule", p["rule"]
        else:
            rec = decided_rec or {"error": "llm disabled"}
            if "error" in rec:
                llm_rec = {"error": rec["error"]}
                tr, stage, rule = isl["r12_tr"], "rule", R.RULE_R12
            else:
                llm_rec = {"confidence": rec.get("confidence")}
                stage, rule = "llm", None
                sysi, toks = rec["src"], rec["tokens"]
                if sysi is not None:
                    tr = isl["span_tr"][sysi]
                elif not toks:
                    tr = []
                else:
                    tr = isl["r12_tr"]
    fired = False
    if guard:
        # The guard replaces the island output with a whole system's span. It
        # does not change which rule routed the island, so `rule` is left alone
        # and `guard_fired` is the flag that says the text was overridden.
        tr, fired = R.apply_guard_tr(isl, list(tr))
    return list(tr), stage, rule, fired, llm_rec


# ------------------------------------------------------------------------ main
def fuse(payload: dict) -> dict:
    cfg = _validate(payload)
    arm, guard, llm_cfg = cfg["arm"], cfg["guard"], cfg["llm"]

    raws = [[w["raw"] for w in s["words"]] for s in cfg["systems"]]
    confs = [[w.get("conf") for w in s["words"]] for s in cfg["systems"]]
    tokenized = [tokenize_words(r) for r in raws]
    tokens = [t for t, _o in tokenized]
    owner = [o for _t, o in tokenized]

    chunks, forced, seams = _analyse(tokens, cfg["chunking"])
    decided = {}
    if arm == "policy" and llm_cfg:
        decided = _llm_pass(chunks, llm_cfg)

    def word_of(ch, sysi, col):
        """(raw word index, raw text, conf) behind a column entry."""
        local = ch.colidx[col][sysi]
        if local is None:
            return None, None, None
        gidx = ch.ranges[sysi][0] + local
        widx = owner[sysi][gidx]
        return widx, raws[sysi][widx], confs[sysi][widx]

    def alternatives(ch, isl):
        out = []
        for k in range(3):
            words, conf_vals = [], []
            seen = set()
            for _t, _s, col in isl["span_tr"][k]:
                widx, raw, cf = word_of(ch, k, col)
                if widx is None or widx in seen:
                    continue
                seen.add(widx)
                words.append(raw)
                if cf is not None:
                    conf_vals.append(cf)
            out.append({
                "src": SYSTEM_IDS[k],
                "text": " ".join(words),
                "norm": list(isl["spans"][k]),
                "conf": (sum(conf_vals) / len(conf_vals)) if conf_vals else None,
            })
        return out

    out_tokens, out_islands, dropped = [], [], []
    stats_cat, stats_stage = {}, {"agree": 0, "rule": 0, "llm": 0}
    n_guard = 0
    isl_counter = 0

    def emit(ch, triples, stage, island_id, alts):
        for tok, sysi, col in triples:
            widx, raw, _cf = word_of(ch, sysi, col)
            out_tokens.append({
                "i": len(out_tokens),
                "text": raw if raw is not None else tok,
                "norm": tok,
                "src": SYSTEM_IDS[sysi],
                "src_word": widx,
                "col": ch.col_offset + col,
                "island": island_id,
                "stage": stage,
                "agreement": _agreement(ch.cols[col], tok),
                "alternatives": alts,
            })
            stats_stage[stage] = stats_stage.get(stage, 0) + 1

    for ci, ch in enumerate(chunks):
        for k, isl in enumerate(ch.parts):
            emit(ch, isl["before_tr"], "agree", None, None)
            iid = f"isl_{isl_counter}"
            isl_counter += 1
            tr, stage, rule, fired, llm_rec = _island_output(
                isl, arm, guard, decided.get((ci, k)))
            n_guard += int(fired)
            alts = alternatives(ch, isl)
            emit(ch, tr, stage, iid, alts)

            srcs = {s for _t, s, _c in tr}
            chosen_src = SYSTEM_IDS[next(iter(srcs))] if len(srcs) == 1 else None
            out_islands.append({
                "id": iid,
                "cols": [ch.col_offset + isl["s"], ch.col_offset + isl["e"] - 1],
                "category": isl["cat"],
                "candidates": {"scribe": list(isl["spans"][0]),
                               "soniox": list(isl["spans"][1]),
                               "ours": list(isl["spans"][2]),
                               "vote": list(isl["vote"]),
                               "r12": list(isl["r12"])},
                "stage": stage,
                "rule": rule,
                "chosen_src": chosen_src,
                "guard_fired": fired,
                "llm": llm_rec,
            })
            stats_cat[isl["cat"]] = stats_cat.get(isl["cat"], 0) + 1

            if not tr:
                best = max(range(3), key=lambda k2: (len(isl["spans"][k2]), -k2))
                if isl["spans"][best]:
                    dropped.append({"island": iid, "src": SYSTEM_IDS[best],
                                    "text": alts[best]["text"],
                                    "rule": rule or stage})
        emit(ch, ch.tail, "agree", None, None)

    chunk_out = cfg["chunking"].as_dict()
    chunk_out.update({"n_chunks": len(chunks), "forced_cuts": forced, "seams": seams})

    return {
        "schema": OUT_SCHEMA,
        "audio_sha256": cfg["audio_sha256"],
        "config": {
            "arm": arm,
            "guard": guard,
            "policy_sha": POLICY_SHA16,
            "llm_envelope_sha": ENVELOPE_SHA16 if (arm == "policy" and llm_cfg) else None,
            "code_rev": CODE_REV,
            "normalizer_rev": NORMALIZER_REV,
            "chunking": chunk_out,
            "components": {SYSTEM_IDS[k]: cfg["systems"][k].get("params_sha")
                           for k in range(3)},
        },
        "tokens": out_tokens,
        "islands": out_islands,
        "dropped": dropped,
        "stats": {
            "n_tokens": len(out_tokens),
            "n_islands": len(out_islands),
            "by_category": stats_cat,
            "by_stage": stats_stage,
            "guard_fired": n_guard,
        },
    }


def main(argv=None) -> int:
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw)
    except Exception as e:
        print(json.dumps({"error": "invalid JSON on stdin", "detail": str(e)[:200]},
                         ensure_ascii=False), file=sys.stderr)
        return 2
    try:
        out = fuse(payload)
    except InputError as e:
        print(json.dumps({"error": "malformed oc-fusion-in/1", "detail": str(e)[:400]},
                         ensure_ascii=False), file=sys.stderr)
        return 2
    json.dump(out, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
