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

function card(item: ReviewItem, index: number, r: KindRenderer): string {
    const buttons = r.choices.map(c => `<button type="button" data-decision="${esc(c.decision)}"><kbd>${esc(c.key)}</kbd> ${esc(c.label)}</button>`).join('');
    const correction = r.choices.some(c => c.needsValue)
        ? `<div class="correction" hidden><input type="text" value="${esc(prefill(item))}" aria-label="corrected value" placeholder="corrected value · Enter saves · empty = null"></div>`
        : '';
    return `<article class="item" data-item="${esc(item.id)}" data-index="${index}">
      <div class="item-head"><span class="num">${index + 1}</span><span class="badge"></span></div>
      <div class="item-body">${r.item(item)}</div>
      <div class="choices">${buttons}</div>
      ${correction}
      <input class="note" type="text" aria-label="note" placeholder="note (optional)">
    </article>`;
}

/** One self-contained file: it works opened from disk (download the results) or served by `eval review open` (submit, source panel). */
export function renderPage(batch: ReviewBatch, ctx: RenderContext = {}): string {
    const r = rendererFor(batch.kind);
    const pub = publicBatch(batch);
    const keys = r.choices.map(c => `<kbd>${esc(c.key)}</kbd> ${esc(c.label.replace('…', ''))}`).join(' · ');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Review ${esc(batch.id)}</title>
<style>${CSS}</style>
</head>
<body>
<header class="top">
  <div class="title">
    <h1>${esc(batch.title ?? batch.kind)}</h1>
    <div class="muted small"><span class="mono">${esc(batch.id)}</span> · ${esc(batch.kind)} · ${esc(batch.suite)} · ${batch.items.length} items</div>
  </div>
  <div class="controls">
    <span id="progress" class="progress">0 / ${batch.items.length}</span>
    <input id="reviewer" type="text" placeholder="your name" aria-label="reviewer">
    <button type="button" id="download">Download results</button>
    <button type="button" id="submit" class="primary" hidden>Submit</button>
  </div>
  <div class="keys small muted">${keys} · <kbd>j</kbd>/<kbd>k</kbd> next/previous · <kbd>Enter</kbd> saves a correction</div>
  <div id="message" class="message" hidden></div>
</header>
<main>
  <section class="items">
    ${r.header ? r.header(batch, ctx) : ''}
    ${batch.items.map((item, i) => card(item, i, r)).join('\n')}
  </section>
  <aside class="source" id="source"><div class="muted">Select an item to see its source.</div></aside>
</main>
<script type="application/json" id="review-data">${scriptJson({ batch: pub, choices: r.choices, blind: isBlind(batch.kind) })}</script>
<script>${CLIENT}</script>
</body>
</html>
`;
}

const CSS = `
:root { --bg:#fbfbfa; --panel:#ffffff; --text:#1d1d1f; --muted:#6b6b70; --line:#e3e3e0; --accent:#2b5fd9; --ok:#1f8a4c; --warn:#b26a00; --bad:#b3261e; --mark:#ffe58a; }
@media (prefers-color-scheme: dark) { :root { --bg:#151517; --panel:#1e1e21; --text:#ececef; --muted:#9a9aa2; --line:#33333a; --accent:#7aa2ff; --ok:#5fcf8f; --warn:#f0b450; --bad:#ff8a80; --mark:#6b5a12; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
.top { position:sticky; top:0; z-index:2; background:var(--panel); border-bottom:1px solid var(--line); padding:12px 16px; display:grid; gap:6px; }
.title h1 { font-size:17px; margin:0; }
.controls { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.progress { font-variant-numeric:tabular-nums; font-weight:600; min-width:70px; }
input[type=text] { font:inherit; padding:5px 8px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--text); }
button { font:inherit; padding:5px 10px; border:1px solid var(--line); border-radius:6px; background:var(--panel); color:var(--text); cursor:pointer; }
button.primary { background:var(--accent); color:#fff; border-color:var(--accent); }
button:disabled { opacity:.45; cursor:not-allowed; }
kbd { font:12px ui-monospace, monospace; border:1px solid var(--line); border-bottom-width:2px; border-radius:4px; padding:0 4px; }
main { display:grid; grid-template-columns:minmax(0, 1fr) minmax(0, 1fr); gap:16px; padding:16px; }
@media (max-width: 900px) { main { grid-template-columns:minmax(0, 1fr); } .source { position:static !important; height:auto !important; } }
.items { display:grid; gap:12px; align-content:start; }
.mode { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:12px 14px; }
.mode h2 { font-size:15px; margin:0 0 6px; }
.mode p { margin:4px 0; }
.item { background:var(--panel); border:1px solid var(--line); border-left:4px solid var(--line); border-radius:8px; padding:10px 14px; display:grid; gap:8px; }
.item.current { outline:2px solid var(--accent); }
.item.decided { border-left-color:var(--ok); }
.item.decided.cant-tell { border-left-color:var(--warn); }
.item.decided.reject, .item.decided.correct { border-left-color:var(--bad); }
.item-head { display:flex; justify-content:space-between; align-items:center; }
.num { font-weight:600; color:var(--muted); }
.badge { font-size:12px; color:var(--muted); }
.meta { color:var(--muted); font-size:13px; overflow-wrap:anywhere; }
.value-row { display:flex; gap:10px; align-items:baseline; }
.value-row .text { flex:1; min-width:0; }
.tag { font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); min-width:64px; }
.value { overflow-wrap:anywhere; }
.value.big { font-size:17px; font-weight:600; }
.value pre, .source pre { white-space:pre-wrap; overflow-wrap:anywhere; margin:0; font:13px/1.45 ui-monospace, monospace; }
.text { white-space:pre-wrap; overflow-wrap:anywhere; max-height:320px; overflow:auto; border:1px solid var(--line); border-radius:6px; padding:8px; }
mark { background:var(--mark); color:inherit; }
.choices { display:flex; flex-wrap:wrap; gap:6px; }
.choices button.chosen { background:var(--accent); color:#fff; border-color:var(--accent); }
.correction.invalid input { border-color:var(--bad); }
.correction input, .note { width:100%; }
.source { position:sticky; top:150px; height:calc(100vh - 170px); background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:10px; overflow:auto; }
.source iframe { width:100%; height:100%; border:0; }
.source h3 { font-size:13px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin:12px 0 4px; }
.message { padding:6px 10px; border-radius:6px; border:1px solid var(--line); }
.message.ok { border-color:var(--ok); } .message.error { border-color:var(--bad); }
.muted { color:var(--muted); } .small { font-size:13px; } .mono { font-family:ui-monospace, monospace; }
`;

// Plain ES5-ish so it runs in any browser without a build step; no template literals, since
// it is itself embedded in one.
const CLIENT = String.raw`
(function () {
  var data = JSON.parse(document.getElementById('review-data').textContent);
  var batch = data.batch, choices = data.choices;
  var served = location.protocol === 'http:' || location.protocol === 'https:';
  var storeKey = 'review:' + batch.id;
  var state = { reviewer: '', decisions: {} };
  try { var saved = JSON.parse(localStorage.getItem(storeKey) || 'null'); if (saved && saved.decisions) state = saved; } catch (e) {}
  function save() { try { localStorage.setItem(storeKey, JSON.stringify(state)); } catch (e) {} }

  var items = {}; batch.items.forEach(function (i) { items[i.id] = i; });
  var cards = Array.prototype.slice.call(document.querySelectorAll('.item'));
  var byKey = {}; choices.forEach(function (c) { byKey[c.key] = c; });
  var current = 0;
  var reviewer = document.getElementById('reviewer');
  var submitBtn = document.getElementById('submit');
  var message = document.getElementById('message');
  var source = document.getElementById('source');
  if (served) submitBtn.hidden = false;
  reviewer.value = state.reviewer || '';
  reviewer.addEventListener('input', function () { state.reviewer = reviewer.value; save(); refresh(); });

  function say(text, kind) { message.hidden = false; message.textContent = text; message.className = 'message ' + (kind || ''); }

  function parseValue(item, raw) {
    var p = item.proposed, c = item.current && item.current.value;
    var textual = typeof p === 'string' || (p == null && (c == null || typeof c === 'string'));
    if (textual) return raw.trim() === '' ? null : raw.trim();
    try { return JSON.parse(raw); } catch (e) { return undefined; }
  }

  function record(idx, d) {
    var card = cards[idx];
    var note = card.querySelector('.note').value.trim();
    if (note) d.note = note;
    state.decisions[card.dataset.item] = d; save(); refresh(); go(idx + 1);
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
      var d = state.decisions[card.dataset.item];
      card.className = 'item' + (idx === current ? ' current' : '') + (d ? ' decided ' + d.decision : '');
      card.querySelector('.badge').textContent = d ? d.decision + (d.value !== undefined ? ' → ' + JSON.stringify(d.value) : '') : '';
      Array.prototype.forEach.call(card.querySelectorAll('.choices button'), function (b) {
        b.classList.toggle('chosen', !!d && b.dataset.decision === d.decision);
      });
      if (d && d.note) card.querySelector('.note').value = d.note;
    });
    var n = decidedCount();
    document.getElementById('progress').textContent = n + ' / ' + batch.items.length;
    submitBtn.disabled = !(n === batch.items.length && reviewer.value.trim());
  }

  function go(idx) {
    if (idx < 0 || idx >= cards.length) { refresh(); return; }
    current = idx; refresh();
    cards[idx].scrollIntoView({ block: 'nearest' });
    showSource(items[cards[idx].dataset.item]);
  }

  var blobs = {};
  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  function section(title, text) { var f = document.createDocumentFragment(); f.appendChild(el('h3', title)); f.appendChild(el('pre', text)); return f; }
  function blockText(b) {
    if (b.type === 'text') return b.text;
    if (b.type === 'document') return '[document ' + ((b.source && b.source.sha256) || '').slice(0, 12) + '…]';
    return JSON.stringify(b);
  }
  function showCall(call) {
    source.textContent = '';
    // A blind page's recorded call ran on one side's model: naming it hints which option is which.
    var heading = data.blind ? 'What the model was given' + (call.label ? ' · ' + call.label : '')
      : (call.label || '') + ' · ' + ((call.response && call.response.servedModel) || call.request.model);
    source.appendChild(el('div', heading, 'muted small'));
    if (call.request.system && call.request.system.text) source.appendChild(section('System', call.request.system.text));
    (call.request.messages || []).forEach(function (m) {
      var content = Array.isArray(m.content) ? m.content.map(blockText).join('\n\n') : String(m.content);
      source.appendChild(section(m.role, content));
    });
    if (call.response) source.appendChild(section('Response (' + call.response.stopReason + ')', call.response.text));
  }
  function showPdf(url, page) {
    source.textContent = '';
    var f = el('iframe'); f.title = 'source document'; f.src = url + '#page=' + (page || 1); source.appendChild(f);
  }
  function showOffline(item) {
    source.textContent = '';
    var pdf = item.evidence && item.evidence.pdf;
    if (pdf && /^https?:\/\//i.test(pdf.url || '')) {
      var a = el('a', 'Open the document (page ' + (pdf.page || 1) + ')'); a.href = pdf.url; a.target = '_blank'; a.rel = 'noopener';
      source.appendChild(a);
    }
    source.appendChild(el('p', 'Opened from disk: run "eval review open ' + batch.id + '" for the archived source next to each item.', 'muted small'));
  }
  var sourceRequest = 0;
  function showSource(item) {
    if (!item) return;
    // A slow response for an item the reviewer has since left must not land in the panel.
    var request = ++sourceRequest;
    var stillShown = function () { return request === sourceRequest; };
    if (!served) return showOffline(item);
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
      if (!stillShown()) return;
      showOffline(item); source.appendChild(el('p', 'Source unavailable: ' + e.message, 'muted small'));
    });
  }

  function results() {
    return {
      batchId: batch.id, reviewer: reviewer.value.trim(), submittedAt: new Date().toISOString(),
      results: batch.items.filter(function (i) { return state.decisions[i.id]; }).map(function (i) {
        var d = state.decisions[i.id], r = { itemId: i.id, decision: d.decision };
        if (d.value !== undefined) r.value = d.value;
        if (d.note) r.note = d.note;
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

  cards.forEach(function (card, idx) {
    card.addEventListener('click', function (e) { if (idx !== current && !e.target.closest('button,input')) go(idx); });
    Array.prototype.forEach.call(card.querySelectorAll('.choices button'), function (b) {
      b.addEventListener('click', function () { current = idx; choose(idx, choices.filter(function (c) { return c.decision === b.dataset.decision; })[0]); });
    });
    var input = card.querySelector('.correction input');
    if (input) input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); current = idx; commitCorrection(idx); } });
    card.querySelector('.note').addEventListener('keydown', function (e) { if (e.key === 'Enter') e.target.blur(); });
  });

  document.addEventListener('keydown', function (e) {
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) { if (e.key === 'Escape') t.blur(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); go(current + 1); return; }
    if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); go(current - 1); return; }
    var c = byKey[e.key];
    if (c) { e.preventDefault(); choose(current, c); }
  });

  var firstOpen = batch.items.findIndex(function (i) { return !state.decisions[i.id]; });
  go(firstOpen === -1 ? 0 : firstOpen);
})();
`;
