import { ComparisonData, MatchedSubject, SubjectView } from './types.js';

function esc(str: string | null | undefined): string {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function attr(str: string | null | undefined): string {
    return esc(str).replace(/'/g, '&#39;');
}

const VERDICT_BADGES: Record<string, string> = {
    identical: '<span class="badge badge-gray">identical</span>',
    cosmetic: '<span class="badge badge-blue">cosmetic</span>',
    structural: '<span class="badge badge-red">structural</span>',
};

function changeBadges(m: MatchedSubject): string {
    const badges = [VERDICT_BADGES[m.verdict]];
    for (const change of m.changes) {
        const key = change.split(/[(:]/)[0];
        const cls = key.startsWith('+') ? 'badge-green' : key.startsWith('-') ? 'badge-red' : 'badge-yellow';
        badges.push(`<span class="badge ${cls}">${esc(change.length > 40 ? key : change)}</span>`);
    }
    return badges.join(' ');
}

function statCard(label: string, fromVal: number, toVal: number): string {
    return `<div class="stat-card${fromVal !== toVal ? ' stat-diff' : ''}">
    <div class="stat-label">${label}</div>
    <div class="stat-values"><span class="from-val">${fromVal}</span><span class="stat-arrow">→</span><span class="to-val">${toVal}</span></div>
  </div>`;
}

function utteranceBars(m: MatchedSubject, idx: number): string {
    const fromS = m.from.utteranceStatuses;
    const toS = m.to.utteranceStatuses;
    const changed = [...new Set([...Object.keys(fromS), ...Object.keys(toS)])]
        .filter(s => (fromS[s] || 0) !== (toS[s] || 0))
        .map(s => ({ label: s, from: fromS[s] || 0, to: toS[s] || 0 }));
    if (changed.length === 0) return '';
    return `<h4>Utterance Status</h4><div class="utt-bars" data-statuses='${attr(JSON.stringify(changed))}' id="utt-bars-${idx}"></div>
  <script>renderUtteranceBars('utt-bars-${idx}');</script>`;
}

function contributionSection(m: MatchedSubject): string {
    const fromMap = new Map(m.from.contributions.map(c => [c.speakerName, c]));
    const toMap = new Map(m.to.contributions.map(c => [c.speakerName, c]));
    const speakers = [...new Set([...fromMap.keys(), ...toMap.keys()])];

    const order = (s: string) => {
        const f = fromMap.get(s), t = toMap.get(s);
        return !f ? 2 : !t ? 3 : (f.text !== t.text ? 1 : 4);
    };
    speakers.sort((a, b) => order(a) - order(b));

    let html = '<div class="contributions-section">';
    for (const s of speakers) {
        const f = fromMap.get(s);
        const t = toMap.get(s);
        if (!f) {
            html += `<div class="contrib-item contrib-added"><div class="contrib-speaker">${esc(s)} <span class="badge badge-green">added</span></div><div class="contrib-text to-text">${esc(t!.text)}</div></div>`;
        } else if (!t) {
            html += `<div class="contrib-item contrib-removed"><div class="contrib-speaker">${esc(s)} <span class="badge badge-red">removed</span></div><div class="contrib-text from-text">${esc(f.text)}</div></div>`;
        } else if (f.text !== t.text) {
            html += `<div class="contrib-item contrib-changed"><div class="contrib-speaker">${esc(s)} <span class="badge badge-yellow">changed</span></div><div class="contrib-diff" data-from="${attr(f.text)}" data-to="${attr(t.text)}"></div></div>`;
        } else {
            html += `<div class="contrib-item contrib-identical"><div class="contrib-speaker">${esc(s)} <span class="badge badge-gray">identical</span></div><div class="contrib-text">${esc(f.text)}</div></div>`;
        }
    }
    return html + '</div>';
}

function matchedSubjectHtml(m: MatchedSubject, idx: number): string {
    const open = m.verdict !== 'identical' ? ' open' : '';
    let body = '';

    if (m.from.topic !== m.to.topic) {
        body += `<div class="field-row"><span class="field-label">Topic:</span> <span class="from-tag">${esc(m.from.topic)}</span> → <span class="to-tag">${esc(m.to.topic)}</span></div>`;
    }
    if (m.from.withdrawn !== m.to.withdrawn) {
        body += `<div class="field-row field-alert"><span class="field-label">Withdrawn:</span> ${m.from.withdrawn} → ${m.to.withdrawn}</div>`;
    }
    if (m.from.topicImportance !== m.to.topicImportance) {
        body += `<div class="field-row"><span class="field-label">Topic Importance:</span> ${esc(m.from.topicImportance)} → ${esc(m.to.topicImportance)}</div>`;
    }

    if (m.from.description !== m.to.description) {
        body += `<h4>Description</h4>
      <div class="desc-diff" id="desc-diff-${idx}" data-from="${attr(m.from.description)}" data-to="${attr(m.to.description)}"></div>
      <script>renderDescDiff('desc-diff-${idx}');</script>
      <button class="toggle-sbs-btn" onclick="toggleSideBySide('sbs-${idx}')">Toggle side-by-side</button>
      <div class="side-by-side" id="sbs-${idx}">
        <div class="sbs-col from-col"><h5>from</h5><div>${esc(m.from.description)}</div></div>
        <div class="sbs-col to-col"><h5>to</h5><div>${esc(m.to.description)}</div></div>
      </div>`;
    } else {
        body += `<h4>Description <span class="badge badge-gray">identical</span></h4><div class="desc-text">${esc(m.from.description)}</div>`;
    }

    if (m.from.context !== m.to.context) {
        body += `<h4>Context</h4><div class="desc-diff" id="ctx-diff-${idx}" data-from="${attr(m.from.context)}" data-to="${attr(m.to.context)}"></div><script>renderDescDiff('ctx-diff-${idx}');</script>`;
    }

    body += `<h4>Contributions</h4>${contributionSection(m)}`;
    body += utteranceBars(m, idx);

    return `<details class="subject-detail" data-subject-idx="${idx}"${open}>
    <summary>#${m.agendaItemIndex ?? '~'} — ${esc(m.from.name)} ${m.matchedBy === 'name' ? '<span class="badge badge-blue">name-matched</span>' : ''}${changeBadges(m)}</summary>
    <div class="subject-body">${body}</div>
  </details>`;
}

function unmatchedCard(s: SubjectView, side: 'from' | 'to'): string {
    const reason = s.nonAgendaReason ?? (s.agendaItemIndex !== null ? `agenda #${s.agendaItemIndex}` : 'unknown');
    return `<div class="${side}-only-card">
    <div class="unmatched-header">${esc(s.name)}</div>
    <div class="unmatched-meta">
      <span class="badge badge-gray">${esc(reason)}</span>
      ${s.topic ? `<span class="badge badge-blue">${esc(s.topic)}</span>` : ''}
      <span>${s.contributions.length} contributions</span>
    </div>
    <div class="unmatched-desc">${esc(s.description.slice(0, 200))}${s.description.length > 200 ? '…' : ''}</div>
  </div>`;
}

export function renderComparisonHtml(data: ComparisonData): string {
    const { from, to } = data.sources;
    const fromLabel = `${from.traceId.slice(0, 8)} (${from.version ?? '?'}, ${from.timestamp.slice(0, 10)})`;
    const toLabel = `${to.traceId.slice(0, 8)} (${to.version ?? '?'}, ${to.timestamp.slice(0, 10)})`;
    const v = data.verdictSummary;
    const title = from.meeting ?? from.name;

    const segmentSamples = data.segmentSamples.map((s, i) => `<div class="segment-sample">
      <div class="seg-header"><span class="mono">segment #${s.index}</span><span class="mono">${esc(s.segmentId.slice(0, 12))}…</span><span class="badge badge-gray">${esc(s.from.type ?? s.to.type ?? '')}</span></div>
      <div class="seg-diff" data-from="${attr(s.from.text ?? '')}" data-to="${attr(s.to.text ?? '')}" id="seg-diff-${i}"></div>
      <script>renderDescDiff('seg-diff-${i}');</script>
    </div>`).join('\n');

    const sf = data.stats.from;
    const st = data.stats.to;

    return `<!DOCTYPE html>
<html lang="el">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Compare: ${esc(title)}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; color: #333; line-height: 1.6; }
.mono { font-family: 'SF Mono', 'Consolas', 'Courier New', monospace; font-size: 0.85em; }
.header { background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%); color: white; padding: 2rem; }
.header h1 { font-size: 1.5rem; margin-bottom: 0.3rem; }
.header .version-badges { display: flex; gap: 0.5rem; align-items: center; margin: 0.8rem 0 0.5rem; }
.version-badge { padding: 0.2rem 0.6rem; border-radius: 4px; font-size: 0.85rem; font-weight: 600; }
.version-badge.from { background: #6c757d; }
.version-badge.to { background: #28a745; }
.header .timestamp { opacity: 0.5; font-size: 0.8rem; }
.controls { position: sticky; top: 0; z-index: 100; background: white; border-bottom: 1px solid #dee2e6; padding: 0.6rem 1.5rem; display: flex; gap: 0.8rem; align-items: center; box-shadow: 0 2px 4px rgba(0,0,0,0.05); }
.controls button { padding: 0.3rem 0.8rem; border: 1px solid #dee2e6; border-radius: 4px; background: white; cursor: pointer; font-size: 0.8rem; }
.controls button:hover { background: #f0f0f0; }
.controls .verdict-summary { margin-left: auto; font-size: 0.8rem; color: #6c757d; }
.stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 1rem; padding: 1.5rem; max-width: 1200px; margin: 0 auto; }
.stat-card { background: white; border-radius: 8px; padding: 1rem; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
.stat-card.stat-diff { border: 2px solid #ffc107; }
.stat-label { font-size: 0.75rem; text-transform: uppercase; color: #6c757d; margin-bottom: 0.5rem; letter-spacing: 0.05em; }
.stat-values { font-size: 1.3rem; font-weight: 700; }
.from-val { color: #6c757d; } .to-val { color: #28a745; } .stat-arrow { color: #999; margin: 0 0.3rem; font-size: 0.9rem; }
.content { max-width: 1200px; margin: 0 auto; padding: 0 1.5rem 2rem; }
h2 { margin: 2rem 0 1rem; font-size: 1.3rem; color: #1a1a2e; border-bottom: 2px solid #e0e0e0; padding-bottom: 0.5rem; }
.badge { display: inline-block; padding: 0.1rem 0.4rem; border-radius: 3px; font-size: 0.7rem; font-weight: 600; margin-left: 0.3rem; vertical-align: middle; }
.badge-yellow { background: #fff3cd; color: #856404; }
.badge-red { background: #f8d7da; color: #721c24; }
.badge-green { background: #d4edda; color: #155724; }
.badge-gray { background: #e9ecef; color: #495057; }
.badge-blue { background: #cce5ff; color: #004085; }
.subject-detail { background: white; border-radius: 8px; margin-bottom: 0.75rem; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
.subject-detail summary { padding: 0.8rem 1rem; cursor: pointer; font-weight: 600; font-size: 0.95rem; }
.subject-detail summary:hover { background: #f8f9fa; border-radius: 8px; }
.subject-body { padding: 0 1rem 1rem; }
.subject-body h4 { margin: 1rem 0 0.5rem; font-size: 0.9rem; color: #1a1a2e; }
.field-row { padding: 0.3rem 0; font-size: 0.9rem; }
.field-label { font-weight: 600; color: #555; }
.field-alert { color: #dc3545; font-weight: 600; }
.from-tag { background: #e9ecef; padding: 0.1rem 0.4rem; border-radius: 3px; }
.to-tag { background: #d4edda; padding: 0.1rem 0.4rem; border-radius: 3px; }
.diff-removed { background: #ffeef0; color: #b31d28; text-decoration: line-through; padding: 1px 2px; border-radius: 2px; }
.diff-added { background: #e6ffec; color: #22863a; padding: 1px 2px; border-radius: 2px; }
.desc-text { font-size: 0.9rem; color: #555; white-space: pre-wrap; padding: 0.5rem; background: #f8f9fa; border-radius: 4px; max-height: 300px; overflow-y: auto; }
.desc-diff { font-size: 0.9rem; white-space: pre-wrap; padding: 0.5rem; background: #fafafa; border-radius: 4px; max-height: 400px; overflow-y: auto; line-height: 1.8; }
.side-by-side { display: none; grid-template-columns: 1fr 1fr; gap: 1rem; margin: 0.5rem 0; }
.side-by-side.visible { display: grid; }
@media (max-width: 900px) { .side-by-side { grid-template-columns: 1fr; } .unmatched-grid { grid-template-columns: 1fr; } }
.sbs-col { padding: 0.8rem; border-radius: 6px; font-size: 0.85rem; white-space: pre-wrap; max-height: 400px; overflow-y: auto; }
.sbs-col h5 { font-size: 0.8rem; margin-bottom: 0.4rem; color: #555; }
.from-col { background: #f8f9fa; border-left: 3px solid #6c757d; }
.to-col { background: #f0faf0; border-left: 3px solid #28a745; }
.toggle-sbs-btn { margin: 0.5rem 0; padding: 0.2rem 0.6rem; border: 1px solid #dee2e6; border-radius: 3px; background: white; cursor: pointer; font-size: 0.75rem; color: #6c757d; }
.contributions-section { margin: 0.5rem 0; }
.contrib-item { padding: 0.6rem; margin: 0.4rem 0; border-radius: 6px; border: 1px solid #eee; }
.contrib-added { background: #f0fdf4; border-color: #86efac; }
.contrib-removed { background: #fef2f2; border-color: #fca5a5; }
.contrib-changed { background: #fffbeb; border-color: #fde68a; }
.contrib-identical { background: #f9fafb; }
.contrib-speaker { font-weight: 600; font-size: 0.85rem; margin-bottom: 0.3rem; }
.contrib-text { font-size: 0.85rem; white-space: pre-wrap; color: #555; }
.contrib-text.from-text { color: #b31d28; } .contrib-text.to-text { color: #22863a; }
.contrib-diff { font-size: 0.85rem; white-space: pre-wrap; line-height: 1.7; }
.utt-bars { margin: 0.5rem 0; }
.utt-bar-row { display: flex; align-items: center; gap: 0.5rem; margin: 0.3rem 0; font-size: 0.8rem; }
.utt-bar-label { width: 160px; text-align: right; font-weight: 500; color: #555; flex-shrink: 0; }
.utt-bar-pair { display: flex; align-items: center; gap: 0.3rem; flex: 1; }
.utt-bar { height: 18px; border-radius: 3px; display: inline-flex; align-items: center; padding: 0 6px; font-size: 0.7rem; font-weight: 600; color: white; min-width: 28px; }
.utt-bar.from-bar { background: #6c757d; } .utt-bar.to-bar { background: #28a745; }
.utt-bar-arrow { color: #999; font-size: 0.75rem; }
.utt-bar-delta { font-size: 0.75rem; font-weight: 600; margin-left: 0.3rem; }
.delta-pos { color: #28a745; } .delta-neg { color: #dc3545; }
.unmatched-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
.from-only-card, .to-only-card { border-radius: 8px; padding: 1rem; margin-bottom: 0.75rem; }
.from-only-card { background: #fef2f2; border-left: 4px solid #dc3545; }
.to-only-card { background: #f0fdf4; border-left: 4px solid #28a745; }
.unmatched-header { font-weight: 700; font-size: 0.95rem; margin-bottom: 0.4rem; }
.unmatched-meta { font-size: 0.8rem; margin-bottom: 0.5rem; display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
.unmatched-desc { font-size: 0.85rem; color: #555; }
.segment-sample { background: white; border-radius: 6px; padding: 0.8rem; margin: 0.5rem 0; box-shadow: 0 1px 2px rgba(0,0,0,0.06); }
.seg-header { display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.4rem; }
.seg-diff { font-size: 0.85rem; white-space: pre-wrap; line-height: 1.7; }
.review-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 1000; background: white; overflow-y: auto; }
.review-overlay.active { display: flex; flex-direction: column; }
.review-header { position: sticky; top: 0; z-index: 10; background: #1a1a2e; color: white; padding: 0.6rem 1rem; display: flex; align-items: center; gap: 0.8rem; }
.review-header button { padding: 0.3rem 0.8rem; border: 1px solid rgba(255,255,255,0.3); border-radius: 4px; background: transparent; color: white; cursor: pointer; font-size: 0.85rem; }
.review-header button:hover { background: rgba(255,255,255,0.1); }
.review-counter { font-family: monospace; font-size: 0.9rem; }
.review-title { flex: 1; font-weight: 600; font-size: 0.95rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.review-depth-bar { display: flex; gap: 0.5rem; padding: 0.5rem 1rem; background: #f0f0f0; border-bottom: 1px solid #ddd; }
.review-depth-bar button { padding: 0.3rem 0.8rem; border: 1px solid #ccc; border-radius: 4px; background: white; cursor: pointer; font-size: 0.8rem; }
.review-depth-bar button.active { background: #0f3460; color: white; border-color: #0f3460; }
.review-body { flex: 1; padding: 1.5rem; max-width: 900px; margin: 0 auto; width: 100%; }
.review-hint { text-align: center; padding: 0.8rem; color: #999; font-size: 0.75rem; background: #f5f5f5; border-top: 1px solid #eee; }
</style>
<script>
function cleanRefs(text) {
  if (!text) return '';
  return text.replace(/\\[([^\\]]*)\\]\\(REF:[A-Z]+:[^)]+\\)/g, '$1');
}
function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function wordDiff(fromText, toText) {
  const a = cleanRefs(fromText || '').split(/\\s+/).filter(Boolean);
  const b = cleanRefs(toText || '').split(/\\s+/).filter(Boolean);
  let prefixLen = 0;
  while (prefixLen < a.length && prefixLen < b.length && a[prefixLen] === b[prefixLen]) prefixLen++;
  let suffixLen = 0;
  while (suffixLen < a.length - prefixLen && suffixLen < b.length - prefixLen && a[a.length - 1 - suffixLen] === b[b.length - 1 - suffixLen]) suffixLen++;
  const aMid = a.slice(prefixLen, a.length - suffixLen);
  const bMid = b.slice(prefixLen, b.length - suffixLen);
  const m = aMid.length, n = bMid.length;
  if (m === 0 && n === 0) return escHtml(a.join(' '));
  const dp = new Array(m + 1);
  for (let i = 0; i <= m; i++) dp[i] = new Uint16Array(n + 1);
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    dp[i][j] = aMid[i-1] === bMid[j-1] ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1]);
  const ops = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && aMid[i-1] === bMid[j-1]) { ops.unshift({ t: 's', w: aMid[i-1] }); i--; j--; }
    else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) { ops.unshift({ t: 'a', w: bMid[j-1] }); j--; }
    else { ops.unshift({ t: 'd', w: aMid[i-1] }); i--; }
  }
  const parts = [];
  if (prefixLen > 0) parts.push(escHtml(a.slice(0, prefixLen).join(' ')));
  for (const op of ops) {
    if (op.t === 's') parts.push(escHtml(op.w));
    else if (op.t === 'd') parts.push('<span class="diff-removed">' + escHtml(op.w) + '</span>');
    else parts.push('<span class="diff-added">' + escHtml(op.w) + '</span>');
  }
  if (suffixLen > 0) parts.push(escHtml(a.slice(a.length - suffixLen).join(' ')));
  return parts.join(' ');
}
function renderDescDiff(id) {
  const el = document.getElementById(id);
  if (el && el.dataset.from !== undefined) el.innerHTML = wordDiff(el.dataset.from, el.dataset.to);
}
function renderContribDiffs() {
  document.querySelectorAll('.contrib-diff').forEach(el => {
    if (el.dataset.from !== undefined) el.innerHTML = wordDiff(el.dataset.from, el.dataset.to);
  });
}
function renderUtteranceBars(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const statuses = JSON.parse(el.dataset.statuses);
  const maxVal = Math.max(...statuses.flatMap(s => [s.from, s.to]));
  el.innerHTML = statuses.map(s => {
    const fromW = Math.max(28, (s.from / maxVal) * 200);
    const toW = Math.max(28, (s.to / maxVal) * 200);
    const delta = s.to - s.from;
    return '<div class="utt-bar-row"><span class="utt-bar-label">' + s.label + '</span><div class="utt-bar-pair">' +
      '<span class="utt-bar from-bar" style="width:' + fromW + 'px">' + s.from + '</span>' +
      '<span class="utt-bar-arrow">\\u2192</span>' +
      '<span class="utt-bar to-bar" style="width:' + toW + 'px">' + s.to + '</span>' +
      '<span class="utt-bar-delta ' + (delta > 0 ? 'delta-pos' : 'delta-neg') + '">' + (delta > 0 ? '+' + delta : delta) + '</span>' +
      '</div></div>';
  }).join('');
}
function toggleAll(open) {
  document.querySelectorAll('details.subject-detail').forEach(d => d.open = open);
}
function toggleSideBySide(id) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('visible');
}
</script>
</head>
<body>

<div class="header">
  <h1>${esc(title)}</h1>
  <div class="version-badges">
    <span class="version-badge from">${esc(fromLabel)}</span>
    <span style="color:rgba(255,255,255,0.5)">→</span>
    <span class="version-badge to">${esc(toLabel)}</span>
  </div>
  <div class="timestamp">Generated: ${data.generatedAt}${from.promptsHash || to.promptsHash ? ` · prompts: ${esc(from.promptsHash ?? '?')} → ${esc(to.promptsHash ?? '?')}` : ''}</div>
</div>

<div class="controls">
  <button onclick="toggleAll(true)">Expand All</button>
  <button onclick="toggleAll(false)">Collapse All</button>
  <button onclick="startReview()">Review Mode (←→)</button>
  <div class="verdict-summary">${data.subjects.matched.length} matched: ${v.structural} structural, ${v.cosmetic} cosmetic, ${v.identical} identical</div>
</div>

<div class="stats-grid">
  ${statCard('Total Subjects', sf.totalSubjects, st.totalSubjects)}
  ${statCard('Agenda Subjects', sf.agendaSubjects, st.agendaSubjects)}
  ${statCard('Before Agenda', sf.beforeAgenda, st.beforeAgenda)}
  ${statCard('Out of Agenda', sf.outOfAgenda, st.outOfAgenda)}
  ${statCard('Contributions', sf.totalContributions, st.totalContributions)}
  ${statCard('Utterances Assigned', sf.totalUtterancesAssigned, st.totalUtterancesAssigned)}
</div>

<div class="content">
  <h2>Matched Subjects (${data.subjects.matched.length})</h2>
  ${data.subjects.matched.map((m, i) => matchedSubjectHtml(m, i)).join('\n')}

  <h2>Unmatched Subjects</h2>
  <div class="unmatched-grid">
    <div>
      <h3 style="color:#dc3545;font-size:1rem;margin-bottom:0.8rem">From Only (${data.subjects.fromOnly.length})</h3>
      ${data.subjects.fromOnly.map(s => unmatchedCard(s, 'from')).join('\n')}
    </div>
    <div>
      <h3 style="color:#28a745;font-size:1rem;margin-bottom:0.8rem">To Only (${data.subjects.toOnly.length})</h3>
      ${data.subjects.toOnly.map(s => unmatchedCard(s, 'to')).join('\n')}
    </div>
  </div>

  <h2>Segment Samples (${data.segmentSamples.length})</h2>
  <details>
    <summary style="cursor:pointer;font-weight:600">Show ${data.segmentSamples.length} segment differences</summary>
    <div style="margin-top:0.5rem">${segmentSamples}</div>
  </details>
</div>

<div class="review-overlay" id="review-overlay">
  <div class="review-header">
    <button onclick="reviewNav(-1)">← Prev</button>
    <span class="review-counter" id="review-counter"></span>
    <button onclick="reviewNav(1)">Next →</button>
    <span class="review-title" id="review-title"></span>
    <button onclick="exitReview()">Exit (Esc)</button>
  </div>
  <div class="review-depth-bar">
    <button id="depth-desc" class="active" onclick="setDepth('desc')">Description</button>
    <button id="depth-contribs" onclick="setDepth('contribs')">Contributions</button>
  </div>
  <div class="review-body" id="review-body"></div>
  <div class="review-hint">←→ navigate subjects · ↓ contributions · ↑ description · Esc exit</div>
</div>

<script>
renderContribDiffs();

var reviewSubjects = ${JSON.stringify(data.subjects.matched.map((m, i) => ({
        idx: i,
        label: m.agendaItemIndex !== null ? '#' + m.agendaItemIndex : '~',
        name: m.from.name,
        verdict: m.verdict,
    })))};
var reviewIdx = 0;
var reviewDepth = 'desc';

function startReview() {
  if (reviewSubjects.length === 0) return;
  reviewIdx = 0;
  reviewDepth = 'desc';
  document.getElementById('review-overlay').classList.add('active');
  renderReview();
}
function exitReview() {
  document.getElementById('review-overlay').classList.remove('active');
}
function reviewNav(dir) {
  reviewIdx = Math.max(0, Math.min(reviewSubjects.length - 1, reviewIdx + dir));
  reviewDepth = 'desc';
  setDepthButtons();
  renderReview();
}
function setDepth(d) {
  reviewDepth = d;
  setDepthButtons();
  renderReview();
}
function setDepthButtons() {
  document.getElementById('depth-desc').classList.toggle('active', reviewDepth === 'desc');
  document.getElementById('depth-contribs').classList.toggle('active', reviewDepth === 'contribs');
}
function renderReview() {
  var s = reviewSubjects[reviewIdx];
  document.getElementById('review-counter').textContent = (reviewIdx + 1) + ' / ' + reviewSubjects.length;
  document.getElementById('review-title').textContent = s.label + ' [' + s.verdict + '] ' + s.name;
  var detail = document.querySelector('[data-subject-idx="' + s.idx + '"]');
  var body = document.getElementById('review-body');
  if (!detail) { body.innerHTML = '<p>Subject not found</p>'; return; }
  if (reviewDepth === 'desc') {
    var content = '';
    var topicRow = detail.querySelector('.field-row');
    if (topicRow) content += topicRow.outerHTML;
    var descDiff = detail.querySelector('.desc-diff');
    var descText = detail.querySelector('.desc-text');
    if (descDiff) content += '<h4>Description</h4>' + descDiff.outerHTML;
    else if (descText) content += '<h4>Description</h4>' + descText.outerHTML;
    var uttBars = detail.querySelector('.utt-bars');
    if (uttBars) content += '<h4>Utterance Status</h4>' + uttBars.outerHTML;
    body.innerHTML = content || '<p style="color:#999">No description changes</p>';
  } else {
    var contribs = detail.querySelector('.contributions-section');
    body.innerHTML = contribs ? contribs.outerHTML : '<p style="color:#999">No contributions</p>';
  }
  document.getElementById('review-overlay').scrollTop = 0;
}
document.addEventListener('keydown', function(e) {
  if (!document.getElementById('review-overlay').classList.contains('active')) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); reviewNav(-1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); reviewNav(1); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); setDepth('contribs'); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); setDepth('desc'); }
  else if (e.key === 'Escape') { e.preventDefault(); exitReview(); }
});
</script>
</body>
</html>`;
}
