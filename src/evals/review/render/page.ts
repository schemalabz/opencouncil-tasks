import type { ReviewBatch, ReviewItem, ReviewKind } from '../batch.js';
import { disagreement } from './disagreement.js';
import { esc, scriptJson } from './html.js';
import type { KindRenderer, RenderContext } from './kind.js';
import { labelConfirm } from './labelConfirm.js';
import { modeExamples } from './modeExamples.js';
import { pairwise } from './pairwise.js';

const RENDERERS: Partial<Record<ReviewKind, KindRenderer>> = {
    'label-confirm': labelConfirm,
    'mode-examples': modeExamples,
    disagreement,
    pairwise,
};

export function rendererFor(kind: ReviewKind): KindRenderer {
    const r = RENDERERS[kind];
    if (!r) throw new Error(`Review kind "${kind}" has no page renderer yet (built: ${Object.keys(RENDERERS).join(', ')})`);
    return r;
}

/** A blind kind's reviewer must not learn which value is which, from the items or from their sources. */
export const isBlind = (kind: ReviewKind): boolean => Boolean(rendererFor(kind).publicItem);

/** The batch as the page may see it: blind kinds lose what would give the answer away. */
export function publicBatch(batch: ReviewBatch): Pick<ReviewBatch, 'id' | 'kind' | 'suite' | 'title' | 'items'> {
    const r = rendererFor(batch.kind);
    return { id: batch.id, kind: batch.kind, suite: batch.suite, title: batch.title, items: batch.items.map(i => (r.publicItem ? r.publicItem(i) : i)) };
}

function prefill(item: ReviewItem): string {
    const v = item.proposed;
    if (v === undefined || v === null) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
}

function card(item: ReviewItem, index: number, total: number, r: KindRenderer): string {
    const buttons = r.choices.map(c => `<button type="button" data-decision="${esc(c.decision)}"><kbd>${esc(c.key)}</kbd> ${esc(c.label)}</button>`).join('');
    const reasons = r.reasons?.length
        ? `<div class="reasons"><span class="muted small">why</span>${r.reasons.map(x => `<button type="button" data-reason="${esc(x.id)}"><kbd>${esc(x.key)}</kbd> ${esc(x.label)}</button>`).join('')}</div>`
        : '';
    const correction = r.choices.some(c => c.needsValue)
        ? `<div class="correction" hidden><input type="text" value="${esc(prefill(item))}" aria-label="corrected value" placeholder="corrected value · Enter saves · empty = null"></div>`
        : '';
    return `<article class="item" data-item="${esc(item.id)}" data-index="${index}" hidden>
      <div class="item-head"><span class="num">${index + 1} / ${total}</span><span class="badge"></span></div>
      <div class="who-strip" hidden></div>
      <div class="item-body">${r.item(item)}</div>
      <div class="decide">
        <div class="choices">${buttons}</div>
        ${reasons}
        ${correction}
        <input class="note" type="text" aria-label="note" placeholder="note (optional)">
      </div>
    </article>`;
}

/**
 * One self-contained file: it works opened from disk (download the results) or served by
 * `eval review open` (submit, archived sources). One item fills the screen at a time; what the
 * item was made from sits beside it, or one key away where the judged values need the width.
 */
export function renderPage(batch: ReviewBatch, ctx: RenderContext = {}): string {
    const r = rendererFor(batch.kind);
    const pub = publicBatch(batch);
    const keys = [
        ...r.choices.map(c => `<kbd>${esc(c.key)}</kbd> ${esc(c.label.replace('…', ''))}`),
        ...(r.reasons?.length ? [`<kbd>${esc(r.reasons[0].key)}</kbd>–<kbd>${esc(r.reasons[r.reasons.length - 1].key)}</kbd> why (before the choice)`] : []),
        '<kbd>j</kbd>/<kbd>k</kbd> next/previous', '<kbd>e</kbd> evidence', '<kbd>Enter</kbd> saves a correction',
    ].join(' · ');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Review ${esc(batch.id)}</title>
<style>${CSS}</style>
</head>
<body class="${r.wide ? 'wide' : ''}">
<header class="top">
  <div class="title">
    <h1>${esc(batch.title ?? batch.kind)}</h1>
    <div class="muted small"><span class="mono">${esc(batch.id)}</span> · ${esc(batch.kind)} · ${esc(batch.suite)}</div>
  </div>
  <nav class="ticks" id="ticks" aria-label="items"></nav>
  <div class="controls">
    <span id="progress" class="progress">0 / ${batch.items.length}</span>
    <button type="button" id="ev-toggle" class="ev-toggle"><kbd>e</kbd> Evidence</button>
    <input id="reviewer" type="text" placeholder="your name" aria-label="reviewer">
    <button type="button" id="download">Download results</button>
    <button type="button" id="submit" class="primary" hidden>Submit</button>
  </div>
</header>
<div id="message" class="message" hidden></div>
<main>
  <section class="stage">
    ${r.header ? r.header(batch, ctx) : ''}
    ${batch.items.map((item, i) => card(item, i, batch.items.length, r)).join('\n')}
  </section>
  <aside class="evidence">
    <div class="ev-head"><span id="ev-title" class="small muted">Evidence</span><button type="button" id="ev-close" class="ev-close" aria-label="close evidence">×</button></div>
    <div class="source" id="source"><div class="muted">Select an item to see its source.</div></div>
  </aside>
</main>
<footer class="keys small muted">${keys}</footer>
<script type="application/json" id="review-data">${scriptJson({ batch: pub, choices: r.choices, reasons: r.reasons ?? [], blind: isBlind(batch.kind) })}</script>
<script>${CLIENT}</script>
</body>
</html>
`;
}

/** On a narrow screen the evidence is a drawer over the page. */
const drawer = (body: string) => `
  ${body} main, ${body}.ev-open main { grid-template-columns:minmax(0, 1fr); }
  ${body} .evidence { display:flex; position:fixed; top:0; right:0; bottom:0; width:min(620px, 94vw); z-index:5; transform:translateX(102%); transition:transform .16s ease-out; box-shadow:-12px 0 32px rgba(0,0,0,.28); }
  ${body}.ev-open .evidence { transform:none; }
  ${body} .ev-toggle, ${body} .ev-close { display:inline-block; }
`;

/** Where the judged values need the width, the evidence stays closed until asked for, then takes a share of the row. */
const ON_DEMAND = `
  body.wide main { grid-template-columns:minmax(0, 1fr); }
  body.wide .evidence { display:none; }
  body.wide.ev-open main { grid-template-columns:minmax(0, 1.7fr) minmax(300px, 1fr); }
  body.wide.ev-open .evidence { display:flex; }
  body.wide .ev-toggle, body.wide .ev-close { display:inline-block; }
`;

const CSS = `
:root { --bg:#f6f6f4; --panel:#ffffff; --text:#1d1d1f; --muted:#6b6b70; --line:#e0e0dc; --accent:#2b5fd9; --ok:#1f8a4c; --warn:#b26a00; --bad:#b3261e; --mark:#ffe58a; }
@media (prefers-color-scheme: dark) { :root { --bg:#151517; --panel:#1e1e21; --text:#ececef; --muted:#9a9aa2; --line:#33333a; --accent:#7aa2ff; --ok:#5fcf8f; --warn:#f0b450; --bad:#ff8a80; --mark:#6b5a12; } }
* { box-sizing: border-box; }
[hidden] { display:none !important; }
html, body { height:100%; }
body { margin:0; height:100dvh; overflow:hidden; display:flex; flex-direction:column; background:var(--bg); color:var(--text); font:15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
.top { background:var(--panel); border-bottom:1px solid var(--line); padding:8px 16px; display:flex; flex-wrap:wrap; gap:8px 16px; align-items:center; }
.title { min-width:0; }
.title h1 { font-size:15px; margin:0; }
.ticks { flex:1; min-width:140px; display:flex; flex-wrap:wrap; gap:3px; }
.tick { width:15px; height:15px; padding:0; border-radius:3px; border:1px solid var(--line); background:transparent; }
.tick.done { background:var(--ok); border-color:var(--ok); }
.tick.done.cant-tell { background:var(--warn); border-color:var(--warn); }
.tick.done.reject, .tick.done.correct { background:var(--bad); border-color:var(--bad); }
.tick.now { outline:2px solid var(--accent); outline-offset:1px; }
.controls { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.progress { font-variant-numeric:tabular-nums; font-weight:600; }
input[type=text] { font:inherit; padding:5px 8px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--text); }
#reviewer { width:130px; }
button { font:inherit; padding:5px 10px; border:1px solid var(--line); border-radius:6px; background:var(--panel); color:var(--text); cursor:pointer; }
button.primary { background:var(--accent); color:#fff; border-color:var(--accent); }
button:disabled { opacity:.45; cursor:not-allowed; }
kbd { font:12px ui-monospace, monospace; border:1px solid var(--line); border-bottom-width:2px; border-radius:4px; padding:0 4px; }
.ev-toggle, .ev-close { display:none; }
.ev-close { border:0; font-size:20px; line-height:1; padding:0 6px; }
.message { margin:8px 16px 0; padding:6px 10px; border-radius:6px; border:1px solid var(--line); background:var(--panel); }
.message.ok { border-color:var(--ok); } .message.error { border-color:var(--bad); }

main { flex:1; min-height:0; display:grid; grid-template-columns:minmax(0, 1fr) minmax(0, 1fr); }
body.wide main { grid-template-columns:minmax(0, 1.85fr) minmax(380px, 1fr); }
.stage { min-height:0; padding:12px 16px 10px; display:flex; flex-direction:column; gap:8px; }
.mode { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:8px 12px; }
.mode summary { font-size:15px; font-weight:600; cursor:pointer; }
details.mode { max-height:34vh; overflow:auto; flex:none; }
a { color:var(--accent); }
.mode p { margin:4px 0; }
.item { flex:1; min-height:0; display:flex; flex-direction:column; gap:8px; }
.item-head { display:flex; justify-content:space-between; align-items:center; }
.num { font-weight:600; color:var(--muted); font-variant-numeric:tabular-nums; }
.badge { font-size:12px; color:var(--muted); }
.item-body { flex:1; min-height:0; overflow:auto; display:flex; flex-direction:column; gap:8px; padding-right:4px; }
.meta { color:var(--muted); font-size:13px; overflow-wrap:anywhere; }
.meta b { color:var(--text); font-size:15px; }
.value-row { display:flex; gap:10px; align-items:baseline; }
.value-row .text { flex:1; min-width:0; }
.tag { font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); min-width:64px; }
.value { overflow-wrap:anywhere; }
.value.big { font-size:17px; font-weight:600; }
.value pre, .source pre { white-space:pre-wrap; overflow-wrap:anywhere; margin:0; font:13px/1.45 ui-monospace, monospace; }
.text { white-space:pre-wrap; overflow-wrap:anywhere; background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:10px 12px; }
mark { background:var(--mark); color:inherit; }

.cmp { display:grid; grid-template-columns:minmax(0, 1fr) minmax(0, 1fr); column-gap:16px; row-gap:6px; align-items:start; }
.side-head { position:sticky; top:0; z-index:1; background:var(--bg); font-weight:700; font-size:12px; letter-spacing:.08em; color:var(--muted); padding:2px 2px 4px; border-bottom:2px solid var(--line); }
.differs { font-weight:400; letter-spacing:.05em; text-transform:uppercase; font-size:11px; margin-left:6px; }
.part-title { grid-column:1 / -1; font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); margin-top:6px; }
.cell { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:10px 14px; min-width:0; }
.prose { white-space:pre-wrap; overflow-wrap:anywhere; line-height:1.62; }
.item.a .cell[data-side="a"], .item.b .cell[data-side="b"] { border-color:var(--accent); box-shadow:inset 3px 0 0 var(--accent); }
.item.a .side-head[data-side="a"], .item.b .side-head[data-side="b"] { color:var(--accent); border-bottom-color:var(--accent); }
.item.same .cell { border-color:var(--ok); }
.shared { border:1px dashed var(--line); border-radius:8px; padding:6px 12px; }
.shared summary { cursor:pointer; color:var(--muted); font-size:13px; }
.shared .prose { font-size:14px; }
@media (max-width: 700px) {
  .cmp { grid-template-columns:minmax(0, 1fr); }
  .side-head { display:none; }
  .cell::before { content:attr(data-side); display:block; text-transform:uppercase; font-weight:700; font-size:12px; color:var(--muted); }
}

.who-strip { display:flex; flex-wrap:wrap; gap:5px 6px; align-items:center; }
.who-strip .legend { font-size:11.5px; color:var(--muted); margin-left:4px; }
.who-strip .lbl { font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); margin-right:2px; }
.who { display:inline-flex; align-items:center; gap:6px; padding:2px 8px 2px 7px; border-radius:999px; font-size:12.5px; line-height:1.5; }
.who.minor { opacity:.72; }
.who-strip:not(.all) .who.extra { display:none; }
.who-more { font-size:12px; padding:1px 8px; border-radius:999px; color:var(--muted); }
.who.on { border-color:var(--c); box-shadow:0 0 0 1px var(--c); }
.dot { width:9px; height:9px; border-radius:50%; background:var(--c); flex:none; }
.who .pct { color:var(--muted); font-variant-numeric:tabular-nums; }
.in { font:600 10px/1.5 ui-monospace, monospace; padding:0 4px; border-radius:3px; border:1px solid var(--line); color:var(--muted); opacity:.5; text-decoration:line-through; }
.in.yes { background:var(--c); border-color:var(--c); color:#fff; opacity:1; text-decoration:none; }
.nm { border-bottom:2px solid var(--c); }
.nm.on { background:color-mix(in srgb, var(--c) 30%, transparent); border-radius:2px; }

.decide { display:flex; flex-wrap:wrap; gap:8px 14px; align-items:center; border-top:1px solid var(--line); padding-top:8px; }
.choices, .reasons { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
.choices button { padding:6px 12px; font-weight:600; }
.choices button.chosen { background:var(--accent); color:#fff; border-color:var(--accent); }
.reasons button { font-size:13px; padding:3px 8px; border-radius:999px; }
.reasons button.chosen { border-color:var(--accent); color:var(--accent); box-shadow:0 0 0 1px var(--accent); }
.correction.invalid input { border-color:var(--bad); }
.correction { flex:1 1 240px; } .correction input { width:100%; }
.note { flex:1 1 160px; min-width:0; }

.evidence { min-height:0; display:flex; flex-direction:column; background:var(--panel); border-left:1px solid var(--line); }
.ev-head { display:flex; justify-content:space-between; align-items:center; padding:8px 14px; border-bottom:1px solid var(--line); }
.source { flex:1; min-height:0; overflow:auto; padding:10px 14px; }
.source iframe { width:100%; height:100%; border:0; }
.source h3 { font-size:13px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin:12px 0 4px; }
.turn { padding:9px 0; border-top:1px solid var(--line); }
.turn:first-child { border-top:0; }
.turn.dim { opacity:.32; }
.turn-head { display:flex; flex-wrap:wrap; align-items:baseline; gap:6px; font-size:13px; margin-bottom:2px; }
.turn-head .dot { align-self:center; }
.turn .prose { font-size:14px; line-height:1.55; }
.keys { padding:5px 16px; border-top:1px solid var(--line); background:var(--panel); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.muted { color:var(--muted); } .small { font-size:13px; } .mono { font-family:ui-monospace, monospace; }

@media (max-width: 1499px) { ${ON_DEMAND} }
@media (max-width: 899px) { ${drawer('body')} ${drawer('body.wide')} }
@media (max-height: 820px) { .stage > .mode.small { display:none; } .stage { padding-top:8px; } }
@media (max-height: 520px) { .keys { display:none; } }
`;

// Plain ES5-ish so it runs in any browser without a build step; no template literals, since
// it is itself embedded in one.
const CLIENT = String.raw`
(function () {
  var data = JSON.parse(document.getElementById('review-data').textContent);
  var batch = data.batch, choices = data.choices, reasons = data.reasons || [];
  var served = location.protocol === 'http:' || location.protocol === 'https:';
  var storeKey = 'review:' + batch.id;
  var state = { reviewer: '', decisions: {}, why: {} };
  try { var saved = JSON.parse(localStorage.getItem(storeKey) || 'null'); if (saved && saved.decisions) { state = saved; state.why = state.why || {}; } } catch (e) {}
  function save() { try { localStorage.setItem(storeKey, JSON.stringify(state)); } catch (e) {} }

  var items = {}; batch.items.forEach(function (i) { items[i.id] = i; });
  var cards = Array.prototype.slice.call(document.querySelectorAll('.item'));
  var byKey = {}; choices.forEach(function (c) { byKey[c.key] = c; });
  var reasonByKey = {}; reasons.forEach(function (r) { reasonByKey[r.key] = r; });
  var current = 0;
  var reviewer = document.getElementById('reviewer');
  var submitBtn = document.getElementById('submit');
  var message = document.getElementById('message');
  var source = document.getElementById('source');
  var evTitle = document.getElementById('ev-title');
  var ticksEl = document.getElementById('ticks');
  var ticks = [];
  if (served) submitBtn.hidden = false;
  reviewer.value = state.reviewer || '';
  reviewer.addEventListener('input', function () { state.reviewer = reviewer.value; save(); refresh(); });

  function all(root, sel) { return Array.prototype.slice.call(root.querySelectorAll(sel) || []); }
  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  function say(text, kind) { message.hidden = false; message.textContent = text; message.className = 'message ' + (kind || ''); }

  // Time on screen for the current item, without the time the tab was hidden.
  var shownAt = Date.now(), hiddenAt = 0;
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) hiddenAt = Date.now(); else if (hiddenAt) { shownAt += Date.now() - hiddenAt; hiddenAt = 0; }
  });

  function parseValue(item, raw) {
    var p = item.proposed, c = item.current && item.current.value;
    var textual = typeof p === 'string' || (p == null && (c == null || typeof c === 'string'));
    if (textual) return raw.trim() === '' ? null : raw.trim();
    try { return JSON.parse(raw); } catch (e) { return undefined; }
  }

  function record(idx, d) {
    var card = cards[idx], id = card.dataset.item, before = state.decisions[id];
    var note = card.querySelector('.note').value.trim();
    if (note) d.note = note;
    if (state.why[id] && state.why[id].length) d.reasons = state.why[id].slice();
    d.ms = (before && before.ms || 0) + Math.max(0, Date.now() - shownAt);
    state.decisions[id] = d; save(); refresh(); go(idx + 1);
  }

  function toggleReason(idx, reason) {
    var id = cards[idx].dataset.item, list = state.why[id] || [], at = list.indexOf(reason.id);
    if (at === -1) list.push(reason.id); else list.splice(at, 1);
    state.why[id] = list;
    if (state.decisions[id]) { if (list.length) state.decisions[id].reasons = list.slice(); else delete state.decisions[id].reasons; }
    save(); refresh();
  }

  function openCorrection(idx) {
    var box = cards[idx].querySelector('.correction');
    if (!box) return;
    box.hidden = false; box.querySelector('input').focus();
  }

  function commitCorrection(idx) {
    var card = cards[idx], box = card.querySelector('.correction');
    var v = parseValue(items[card.dataset.item], box.querySelector('input').value);
    if (v === undefined) { box.classList.add('invalid'); say('Not valid JSON for this field.', 'error'); return; }
    box.classList.remove('invalid'); box.querySelector('input').blur();
    record(idx, { decision: 'correct', value: v });
  }

  function choose(idx, choice) {
    if (choice.needsValue) openCorrection(idx); else record(idx, { decision: choice.decision });
  }

  function decidedCount() { return batch.items.filter(function (i) { return state.decisions[i.id]; }).length; }

  function refresh() {
    cards.forEach(function (card, idx) {
      var id = card.dataset.item, d = state.decisions[id], why = state.why[id] || [];
      card.hidden = idx !== current;
      card.className = 'item' + (idx === current ? ' current' : '') + (d ? ' decided ' + d.decision : '');
      card.querySelector('.badge').textContent = d ? d.decision + (d.value !== undefined ? ' → ' + JSON.stringify(d.value) : '') : '';
      all(card, '.choices button').forEach(function (b) { b.classList.toggle('chosen', !!d && b.dataset.decision === d.decision); });
      all(card, '.reasons button').forEach(function (b) { b.classList.toggle('chosen', why.indexOf(b.dataset.reason) !== -1); });
      if (d && d.note) card.querySelector('.note').value = d.note;
      if (ticks[idx]) ticks[idx].className = 'tick' + (d ? ' done ' + d.decision : '') + (idx === current ? ' now' : '');
    });
    var n = decidedCount();
    document.getElementById('progress').textContent = n + ' / ' + batch.items.length;
    submitBtn.disabled = !(n === batch.items.length && reviewer.value.trim());
  }

  function go(idx) {
    if (idx < 0 || idx >= cards.length) { refresh(); return; }
    current = idx; shownAt = Date.now(); focus = null; refresh();
    var body = cards[idx].querySelector('.item-body'); if (body) body.scrollTop = 0;
    var item = items[cards[idx].dataset.item];
    people(item, cards[idx]);
    showSource(item);
  }

  // ---- The people of an item: who spoke, how much, and where each text names them.
  var PALETTE = ['#3b82f6', '#ef6c35', '#16a34a', '#c026d3', '#d4a017', '#0ea5b7', '#e11d48', '#8b5cf6', '#84a516', '#b45f3c', '#5b6ee1', '#d6589f'];
  var LETTER = /\p{L}/u;
  function fold(s) {
    var o = '';
    for (var i = 0; i < s.length; i++) {
      var c = s[i].normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().charAt(0) || s[i];
      o += c === 'ς' ? 'σ' : c;
    }
    return o;
  }
  // Word-start stems of a display name, so an inflected form of it still matches.
  function stems(name) {
    return fold(name.split(' - ')[0]).split(/[^\p{L}]+/u)
      .filter(function (t) { return t.length >= 5; })
      .map(function (t) { return t.length >= 7 ? t.slice(0, -2) : t.slice(0, -1); });
  }
  var cast = {}, focus = null;
  function castOf(item) {
    if (cast[item.id]) return cast[item.id];
    var speech = (item.evidence && item.evidence.speech) || [], by = {}, list = [], total = 0;
    speech.forEach(function (t) {
      var p = by[t.speaker];
      if (!p) { p = by[t.speaker] = { name: t.speaker, detail: t.detail || '', chars: 0, turns: 0 }; list.push(p); }
      p.chars += t.text.length; p.turns++; total += t.text.length;
    });
    var named = 0;
    list.slice().sort(function (x, y) { return y.chars - x.chars; }).forEach(function (p) {
      p.unknown = /^(unknown speaker|άγνωστος ομιλητής)/i.test(p.name);
      p.color = p.unknown ? '#8a8a92' : PALETTE[named++ % PALETTE.length];
      p.stems = p.unknown ? [] : stems(p.name);
      p.share = total ? p.chars / total : 0;
    });
    list.forEach(function (p, i) { p.index = i; });
    return (cast[item.id] = { list: list, by: by, total: total });
  }
  function matches(text, list) {
    var f = fold(text), found = [];
    list.forEach(function (p) {
      p.stems.forEach(function (stem) {
        var re = new RegExp('(^|[^\\p{L}])' + stem.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&'), 'gu'), m;
        while ((m = re.exec(f))) {
          var start = m.index + m[1].length, end = start + stem.length;
          while (end < f.length && LETTER.test(f[end])) end++;
          found.push({ start: start, end: end, p: p });
        }
      });
    });
    found.sort(function (x, y) { return x.start - y.start || y.end - x.end; });
    var out = [], at = 0;
    found.forEach(function (m) { if (m.start >= at) { out.push(m); at = m.end; } });
    return out;
  }
  function markNames(node, list) {
    if (node.dataset.marked || (node.children && node.children.length)) return [];
    node.dataset.marked = '1';
    var text = node.textContent, found = matches(text, list);
    if (!found.length) return [];
    var at = 0; node.textContent = '';
    found.forEach(function (m) {
      if (m.start > at) node.appendChild(document.createTextNode(text.slice(at, m.start)));
      var span = el('span', text.slice(m.start, m.end), 'nm'); span.dataset.s = m.p.index; span.style.setProperty('--c', m.p.color);
      node.appendChild(span); at = m.end;
    });
    if (at < text.length) node.appendChild(document.createTextNode(text.slice(at)));
    return found;
  }
  function people(item, card) {
    var strip = card.querySelector('.who-strip');
    if (!strip || strip.dataset.built) return;
    strip.dataset.built = '1';
    var c = castOf(item);
    if (!c.list.length) return;
    var namedIn = { a: {}, b: {} };
    all(card, '.prose').forEach(function (node) {
      var cell = node.closest && node.closest('.cell');
      markNames(node, c.list).forEach(function (m) { if (cell && namedIn[cell.dataset.side]) namedIn[cell.dataset.side][m.p.index] = true; });
    });
    var sides = all(card, '.side-head').length ? ['a', 'b'] : [];
    var meta = card.querySelector('.meta');
    if (meta && meta.parentNode && meta.parentNode.insertBefore) meta.parentNode.insertBefore(strip, meta.nextSibling);
    strip.hidden = false;
    strip.appendChild(el('span', 'Who spoke', 'lbl'));
    // The chips of a large debate would push the texts off the screen: the smaller voices open on request.
    var KEEP = 8, extra = 0;
    c.list.slice().sort(function (x, y) { return y.chars - x.chars; }).forEach(function (p, rank) {
      var folded = rank >= KEEP; if (folded) extra++;
      var chip = el('button', null, 'who' + (p.chars < 500 ? ' minor' : '') + (folded ? ' extra' : ''));
      chip.type = 'button'; chip.dataset.s = p.index; chip.style.setProperty('--c', p.color);
      chip.title = p.name + (p.detail ? ' · ' + p.detail : '') + ' · ' + p.chars + ' characters in ' + p.turns + ' turn(s)';
      chip.appendChild(el('i', null, 'dot'));
      chip.appendChild(el('span', p.name.split(' - ')[0]));
      chip.appendChild(el('span', Math.round(p.share * 100) + '%', 'pct'));
      if (!p.unknown) sides.forEach(function (s) {
        var mark = el('span', s.toUpperCase(), 'in' + (namedIn[s][p.index] ? ' yes' : ''));
        mark.title = (namedIn[s][p.index] ? 'Named in ' : 'Not named in ') + s.toUpperCase();
        chip.appendChild(mark);
      });
      chip.addEventListener('click', function () { setFocus(focus === p.index ? null : p.index, true); });
      strip.appendChild(chip);
    });
    if (extra) {
      var more = el('button', '+' + extra + ' more', 'who-more'); more.type = 'button';
      more.addEventListener('click', function () { var open = strip.classList.toggle('all'); more.textContent = open ? 'fewer' : '+' + extra + ' more'; });
      strip.appendChild(more);
    }
    if (sides.length) strip.appendChild(el('span', 'share of the speech · A, B: the text names the speaker', 'legend'));
  }
  function setFocus(index, reveal) {
    focus = index;
    var card = cards[current];
    all(card, '.who').forEach(function (n) { n.classList.toggle('on', index !== null && Number(n.dataset.s) === index); });
    all(card, '.nm').forEach(function (n) { n.classList.toggle('on', index !== null && Number(n.dataset.s) === index); });
    var first = null;
    all(source, '.turn').forEach(function (n) {
      var mine = index === null || Number(n.dataset.s) === index;
      n.classList.toggle('dim', !mine);
      if (mine && index !== null && !first) first = n;
    });
    if (first && reveal) { document.body.classList.add('ev-open'); first.scrollIntoView({ block: 'start' }); }
  }

  // ---- The evidence panel: the speech an item carries, else its archived source.
  var blobs = {};
  function section(title, text) { var f = document.createDocumentFragment(); f.appendChild(el('h3', title)); f.appendChild(el('pre', text)); return f; }
  function blockText(b) {
    if (b.type === 'text') return b.text;
    if (b.type === 'document') return '[document ' + ((b.source && b.source.sha256) || '').slice(0, 12) + '…]';
    return JSON.stringify(b);
  }
  function title(text) { if (evTitle) evTitle.textContent = text; }
  function showSpeech(item) {
    var c = castOf(item);
    source.textContent = '';
    title('What was said · ' + item.evidence.speech.length + ' turn(s), ' + c.list.length + ' speaker(s), ' + c.total.toLocaleString() + ' characters');
    item.evidence.speech.forEach(function (t) {
      var p = c.by[t.speaker], turn = el('div', null, 'turn'), head = el('div', null, 'turn-head'), dot = el('i', null, 'dot');
      turn.dataset.s = p.index; dot.style.setProperty('--c', p.color);
      head.appendChild(dot); head.appendChild(el('b', t.speaker.split(' - ')[0]));
      head.appendChild(el('span', [t.detail, t.text.length + ' characters'].filter(Boolean).join(' · '), 'muted'));
      turn.appendChild(head); turn.appendChild(el('div', t.text, 'prose'));
      source.appendChild(turn);
    });
    source.scrollTop = 0;
  }
  function showCall(call) {
    source.textContent = '';
    // A blind page's recorded call ran on one side's model: naming it hints which option is which.
    var heading = data.blind ? 'What the model was given' + (call.label ? ' · ' + call.label : '')
      : (call.label || '') + ' · ' + ((call.response && call.response.servedModel) || call.request.model);
    title('Source');
    source.appendChild(el('div', heading, 'muted small'));
    if (call.request.system && call.request.system.text) source.appendChild(section('System', call.request.system.text));
    (call.request.messages || []).forEach(function (m) {
      var content = Array.isArray(m.content) ? m.content.map(blockText).join('\n\n') : String(m.content);
      source.appendChild(section(m.role, content));
    });
    if (call.response) source.appendChild(section('Response (' + call.response.stopReason + ')', call.response.text));
  }
  function showPdf(url, page) {
    source.textContent = ''; title('Source document');
    var f = el('iframe'); f.title = 'source document'; f.src = url + '#page=' + (page || 1); source.appendChild(f);
  }
  function showNone(item, why) {
    source.textContent = ''; title('Source');
    var pdf = item.evidence && item.evidence.pdf;
    if (pdf && /^https?:\/\//i.test(pdf.url || '')) {
      var a = el('a', 'Open the document (page ' + (pdf.page || 1) + ')'); a.href = pdf.url; a.target = '_blank'; a.rel = 'noopener';
      source.appendChild(a);
    }
    source.appendChild(el('p', why, 'muted small'));
  }
  var sourceRequest = 0;
  function showSource(item) {
    if (!item) return;
    // A slow response for an item the reviewer has since left must not land in the panel.
    var request = ++sourceRequest;
    var stillShown = function () { return request === sourceRequest; };
    if (item.evidence && item.evidence.speech && item.evidence.speech.length) return showSpeech(item);
    if (!served) return showNone(item, 'Opened from disk: run "eval review open ' + batch.id + '" for the archived source next to each item.');
    var pdf = item.evidence && item.evidence.pdf;
    var cacheKey = (pdf && pdf.sha256) || item.id;
    if (blobs[cacheKey]) return blobs[cacheKey].pdf ? showPdf(blobs[cacheKey].pdf, pdf && pdf.page) : showCall(blobs[cacheKey].call);
    source.textContent = 'Loading source…';
    fetch('/api/items/' + encodeURIComponent(item.id) + '/source').then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error(t || r.statusText); });
      var type = r.headers.get('content-type') || '';
      if (type.indexOf('application/pdf') === 0) return r.blob().then(function (b) { blobs[cacheKey] = { pdf: URL.createObjectURL(b) }; if (stillShown()) showPdf(blobs[cacheKey].pdf, pdf && pdf.page); });
      return r.json().then(function (call) { blobs[cacheKey] = { call: call }; if (stillShown()) showCall(call); });
    }).catch(function (e) {
      if (stillShown()) showNone(item, 'Source unavailable: ' + e.message);
    });
  }

  function results() {
    return {
      batchId: batch.id, reviewer: reviewer.value.trim(), submittedAt: new Date().toISOString(),
      results: batch.items.filter(function (i) { return state.decisions[i.id]; }).map(function (i) {
        var d = state.decisions[i.id], r = { itemId: i.id, decision: d.decision };
        if (d.value !== undefined) r.value = d.value;
        if (d.note) r.note = d.note;
        if (d.reasons && d.reasons.length) r.reasons = d.reasons;
        if (typeof d.ms === 'number') r.ms = d.ms;
        return r;
      })
    };
  }

  document.getElementById('download').addEventListener('click', function () {
    var blob = new Blob([JSON.stringify(results(), null, 2)], { type: 'application/json' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = batch.id + '-results.json';
    document.body.appendChild(a); a.click(); a.remove();
  });
  submitBtn.addEventListener('click', function () {
    submitBtn.disabled = true;
    fetch('/api/results', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(results()) })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j.ok) say('Submitted. The agent can now run: eval review apply ' + batch.id, 'ok'); else { say(j.error, 'error'); refresh(); } })
      .catch(function (e) { say('Submit failed: ' + e.message + '. Download the results instead.', 'error'); refresh(); });
  });

  function toggleEvidence(open) { document.body.classList.toggle('ev-open', open); }
  var evToggle = document.getElementById('ev-toggle'), evClose = document.getElementById('ev-close');
  if (evToggle) evToggle.addEventListener('click', function () { toggleEvidence(); });
  if (evClose) evClose.addEventListener('click', function () { toggleEvidence(false); });

  cards.forEach(function (card, idx) {
    card.addEventListener('click', function (e) { if (idx !== current && !e.target.closest('button,input')) go(idx); });
    all(card, '.choices button').forEach(function (b) {
      b.addEventListener('click', function () { current = idx; choose(idx, choices.filter(function (c) { return c.decision === b.dataset.decision; })[0]); });
    });
    all(card, '.reasons button').forEach(function (b) {
      b.addEventListener('click', function () { toggleReason(idx, reasons.filter(function (r) { return r.id === b.dataset.reason; })[0]); });
    });
    var input = card.querySelector('.correction input');
    if (input) input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); current = idx; commitCorrection(idx); } });
    card.querySelector('.note').addEventListener('keydown', function (e) { if (e.key === 'Enter') e.target.blur(); });
    if (ticksEl) {
      var tick = el('button', null, 'tick'); tick.type = 'button'; tick.title = 'Item ' + (idx + 1);
      tick.addEventListener('click', function () { go(idx); });
      ticksEl.appendChild(tick); ticks.push(tick);
    }
  });

  document.addEventListener('keydown', function (e) {
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) { if (e.key === 'Escape') t.blur(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'j' || e.key === 'ArrowRight') { e.preventDefault(); go(current + 1); return; }
    if (e.key === 'k' || e.key === 'ArrowLeft') { e.preventDefault(); go(current - 1); return; }
    if (e.key === 'e') { e.preventDefault(); toggleEvidence(); return; }
    if (e.key === 'Escape') { toggleEvidence(false); setFocus(null); return; }
    if (reasonByKey[e.key]) { e.preventDefault(); toggleReason(current, reasonByKey[e.key]); return; }
    var c = byKey[e.key];
    if (c) { e.preventDefault(); choose(current, c); }
  });

  // "#12" opens item 12; without it, the first item that is not decided.
  var asked = parseInt(String(location.hash || '').slice(1), 10) - 1;
  var firstOpen = batch.items.findIndex(function (i) { return !state.decisions[i.id]; });
  go(asked >= 0 && asked < cards.length ? asked : firstOpen === -1 ? 0 : firstOpen);
})();
`;
