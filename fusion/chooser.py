# -*- coding: utf-8 -*-
"""The LLM arm: render a batch of islands, ask Claude to pick a path, parse.

`SYSTEM`, `paths_of`, `render` and `parse` are ported verbatim from
eval/controlled_eval/chooser/run_chooser.py. Only the transport changed: the
research code shelled out to the `claude` CLI; this one posts to the Anthropic
Messages API with `urllib.request` so the package stays stdlib-only.

The model can only ever pick one of the offered paths or abstain, so it cannot
invent text. ANY error — transport, HTTP, refusal, unparseable body, an out of
range path id — makes the island fall back to R1+R2, and the island record
carries `llm: {"error": "..."}`.

Nothing here runs unless the caller set `config.llm`.
"""
from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request

from .policy import ENVELOPE

SHORT = ["scribe", "soniox", "ours"]
NM = {"scribe": "Σύστημα Α", "soniox": "Σύστημα Β", "ours": "Σύστημα Γ"}

SYSTEM = """Επιλέγεις μία διαδρομή μέσα σε ένα δίκτυο σύγχυσης ελληνικής αναγνώρισης ομιλίας.

Ο στόχος σου είναι η ΠΙΣΤΟΤΗΤΑ σε αυτό που ειπώθηκε. Δεν ξαναγράφεις, δεν διορθώνεις τη
γραμματική, δεν βελτιώνεις το ύφος, δεν μετατρέπεις τον προφορικό λόγο σε πρακτικά. Οι
επαναλήψεις, οι δισταγμοί και τα λάθη του ομιλητή μπορεί να είναι ακριβώς αυτό που ειπώθηκε.

Το κείμενο είναι πεζό, χωρίς τόνους και χωρίς στίξη. Μην προσθέτεις τίποτα από αυτά.

Διαλέγεις ΜΟΝΟ μία από τις προσφερόμενες διαδρομές. Η κενή διαδρομή σημαίνει ότι δεν
γράφεται τίποτα εκεί - δεν σημαίνει ότι ο ήχος ήταν σιωπηλός. Αν τα στοιχεία δεν
επαρκούν, γράψε ABSTAIN και θα κρατηθεί η υπάρχουσα ψήφος.

Η ταυτότητα του συστήματος είναι ένδειξη, όχι εξουσία: το τοπικό συμφραζόμενο υπερισχύει
ενός στατιστικού prior.

Απαντάς ΜΟΝΟ με JSON, χωρίς σχόλια και χωρίς markdown."""


def api_key() -> str | None:
    return os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("FUSION_LLM_API_KEY")


def paths_of(row):
    """Candidate paths: each distinct whole-system span, R1+R2, and the empty path.

    R1+R2 MIXES systems, so it reaches answers no whole-system path can. It is
    also the fallback when the model abstains, so abstention lands on the better
    baseline rather than on the vote.
    """
    out, seen = [], {}
    for i, s in enumerate(row["spans"]):
        t = tuple(s)
        if t in seen:
            seen[t].append(SHORT[i])
            continue
        seen[t] = [SHORT[i]]
        out.append(t)
    for extra in (tuple(row.get("r12") or ()), ()):
        if extra not in seen:
            seen[extra] = []
            out.append(extra)
    return [(list(t), seen[t]) for t in out]


def render(rows, instr):
    b = ["ΚΑΝΟΝΑΣ ΓΙΑ ΑΥΤΗ ΤΗΝ ΚΑΤΗΓΟΡΙΑ:", "", instr, "",
         "ΠΛΑΙΣΙΟ: συνεδρίαση ελληνικού δημοτικού συμβουλίου. Το λεξιλόγιο είναι συχνά "
         "τυπικό και διοικητικό, αλλά ο λόγος είναι προφορικός: κατακερματισμένος, "
         "επαναληπτικός, συχνά αντιγραμματικός.", "",
         f"Ακολουθούν {len(rows)} σημεία διαφωνίας. Για κάθε ένα διάλεξε μία διαδρομή.", ""]
    for n, r in enumerate(rows):
        b.append(f"### σημείο {n}")
        b.append(f"αριστερά: …{r['L']}")
        for k, (toks, sup) in enumerate(paths_of(r)):
            who = " + ".join(NM[s] for s in sup) if sup else "παράλειψη"
            txt = " ".join(toks) if toks else "(τίποτα)"
            b.append(f"  P{k}: «{txt}»   [{who}]")
        b.append(f"δεξιά: {r['R']}…")
        b.append("")
    b += ["Απάντησε με έναν πίνακα JSON, ένα αντικείμενο ανά σημείο, με τη σειρά:",
          '[{"i":0,"p":"P0","c":"high"}, {"i":1,"p":"ABSTAIN","c":"low"}, ...]',
          '"p" είναι το αναγνωριστικό της διαδρομής ή ABSTAIN. "c" είναι high, medium ή low.',
          "Καμία άλλη έξοδος."]
    return "\n".join(b)


def parse(txt, n):
    m = re.search(r"\[.*\]", txt or "", re.S)
    if not m:
        return {}
    try:
        arr = json.loads(m.group(0))
    except Exception:
        return {}
    out = {}
    for o in arr:
        try:
            i = int(o["i"])
        except Exception:
            continue
        if 0 <= i < n:
            out[i] = (str(o.get("p", "")).strip().upper(), o.get("c", ""))
    return out


def call(prompt: str, cfg: dict | None = None):
    """POST one batch to the Anthropic Messages API. Returns (text, error)."""
    env = dict(ENVELOPE)
    env.update({k: v for k, v in (cfg or {}).items() if v is not None})
    key = env.get("api_key") or api_key()
    if not key:
        return None, "no API key (ANTHROPIC_API_KEY / FUSION_LLM_API_KEY)"

    body = {
        "model": env["model"],
        "max_tokens": env["max_tokens"],
        "system": SYSTEM,
        "messages": [{"role": "user", "content": prompt}],
    }
    if env.get("thinking"):
        body["thinking"] = env["thinking"]
    if env.get("temperature") is not None:
        body["temperature"] = env["temperature"]

    req = urllib.request.Request(
        env["endpoint"],
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"content-type": "application/json",
                 "x-api-key": key,
                 "anthropic-version": env["anthropic_version"]},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=env["timeout_sec"]) as r:
            raw = r.read().decode("utf-8")
    except urllib.error.HTTPError as e:                    # pragma: no cover
        try:
            detail = e.read().decode("utf-8", "replace")[:300]
        except Exception:
            detail = ""
        return None, f"HTTP {e.code}: {detail}"
    except Exception as e:
        return None, f"{type(e).__name__}: {e}"

    try:
        d = json.loads(raw)
    except Exception as e:
        return None, f"unparseable body: {type(e).__name__}: {e}"
    if d.get("type") == "error" or d.get("error"):
        return None, f"api error: {str(d.get('error'))[:200]}"
    if d.get("stop_reason") == "refusal":
        return None, "refusal"
    text = "".join(b.get("text", "") for b in (d.get("content") or [])
                   if isinstance(b, dict) and b.get("type") == "text")
    if "[" not in text:
        return None, f"no JSON in result: {text[:200]}"
    return text, None


def decide_batch(rows, instr, cfg=None):
    """Decide one same-category batch. Returns {row_index: (path_id, conf)} and
    an error string (or None). On error the caller falls back to R1+R2."""
    txt, err = call(render(rows, instr), cfg)
    if err:
        return {}, err
    got = parse(txt, len(rows))
    if not got:
        return {}, "unparseable"
    return got, None


def resolve(pick, isl):
    """Turn one model pick into a chosen path, or None to mean "fall back".

    Returns (tokens, system_index_or_None, error_or_None). `system_index` is the
    system whose whole span was chosen, so `fuse.py` can attribute raw words;
    it is None for the R1+R2 path and for the empty path.
    """
    if not pick:
        return None, None, "missing"
    if pick[0] == "ABSTAIN":
        return None, None, "abstain"
    m = re.fullmatch(r"P(\d+)", pick[0])
    ps = paths_of(isl)
    if not m or int(m.group(1)) >= len(ps):
        return None, None, "invalid path"
    toks, sup = ps[int(m.group(1))]
    sysi = SHORT.index(sup[0]) if sup else None
    return toks, sysi, None
