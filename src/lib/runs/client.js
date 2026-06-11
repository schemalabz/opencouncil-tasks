// Client-side renderer for the run-comparison page. html.ts inlines this file
// into template.html as a classic script (the export line at the bottom is
// stripped), so top-level function declarations become globals that the
// template's onclick attributes can reach. Must not contain a literal
// script-closing tag anywhere, or the inlined script block would end early.

function cleanRefs(text) {
    if (!text) return '';
    return text.replace(/\[([^\]]*)\]\(REF:[A-Z]+:[^)]+\)/g, '$1');
}

function esc(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function wordDiff(fromText, toText) {
    const a = cleanRefs(fromText || '').split(/\s+/).filter(Boolean);
    const b = cleanRefs(toText || '').split(/\s+/).filter(Boolean);
    let prefixLen = 0;
    while (prefixLen < a.length && prefixLen < b.length && a[prefixLen] === b[prefixLen]) prefixLen++;
    let suffixLen = 0;
    while (suffixLen < a.length - prefixLen && suffixLen < b.length - prefixLen && a[a.length - 1 - suffixLen] === b[b.length - 1 - suffixLen]) suffixLen++;
    const aMid = a.slice(prefixLen, a.length - suffixLen);
    const bMid = b.slice(prefixLen, b.length - suffixLen);
    const m = aMid.length, n = bMid.length;
    if (m === 0 && n === 0) return esc(a.join(' '));
    const dp = new Array(m + 1);
    for (let i = 0; i <= m; i++) dp[i] = new Uint16Array(n + 1);
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
        dp[i][j] = aMid[i - 1] === bMid[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    const ops = [];
    let i = m, j = n;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && aMid[i - 1] === bMid[j - 1]) { ops.unshift({ t: 's', w: aMid[i - 1] }); i--; j--; }
        else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) { ops.unshift({ t: 'a', w: bMid[j - 1] }); j--; }
        else { ops.unshift({ t: 'd', w: aMid[i - 1] }); i--; }
    }
    const parts = [];
    if (prefixLen > 0) parts.push(esc(a.slice(0, prefixLen).join(' ')));
    for (const op of ops) {
        if (op.t === 's') parts.push(esc(op.w));
        else if (op.t === 'd') parts.push('<span class="diff-removed">' + esc(op.w) + '</span>');
        else parts.push('<span class="diff-added">' + esc(op.w) + '</span>');
    }
    if (suffixLen > 0) parts.push(esc(a.slice(a.length - suffixLen).join(' ')));
    return parts.join(' ');
}

const VERDICT_BADGES = {
    identical: '<span class="badge badge-gray">identical</span>',
    cosmetic: '<span class="badge badge-blue">cosmetic</span>',
    structural: '<span class="badge badge-red">structural</span>',
};

function changeBadges(m) {
    const badges = [VERDICT_BADGES[m.verdict]];
    for (const change of m.changes) {
        const key = change.split(/[(:]/)[0];
        const cls = key.startsWith('+') ? 'badge-green' : key.startsWith('-') ? 'badge-red' : 'badge-yellow';
        badges.push(`<span class="badge ${cls}">${esc(change.length > 40 ? key : change)}</span>`);
    }
    return badges.join(' ');
}

function statCard(label, fromVal, toVal) {
    return `<div class="stat-card${fromVal !== toVal ? ' stat-diff' : ''}">
    <div class="stat-label">${label}</div>
    <div class="stat-values"><span class="from-val">${fromVal}</span><span class="stat-arrow">→</span><span class="to-val">${toVal}</span></div>
  </div>`;
}

function utteranceBars(m) {
    const fromS = m.from.utteranceStatuses;
    const toS = m.to.utteranceStatuses;
    const changed = [...new Set([...Object.keys(fromS), ...Object.keys(toS)])]
        .filter(s => (fromS[s] || 0) !== (toS[s] || 0))
        .map(s => ({ label: s, from: fromS[s] || 0, to: toS[s] || 0 }));
    if (changed.length === 0) return '';
    const maxVal = Math.max(...changed.flatMap(s => [s.from, s.to]));
    const rows = changed.map(s => {
        const fromW = Math.max(28, (s.from / maxVal) * 200);
        const toW = Math.max(28, (s.to / maxVal) * 200);
        const delta = s.to - s.from;
        return `<div class="utt-bar-row"><span class="utt-bar-label">${esc(s.label)}</span><div class="utt-bar-pair">` +
            `<span class="utt-bar from-bar" style="width:${fromW}px">${s.from}</span>` +
            '<span class="utt-bar-arrow">→</span>' +
            `<span class="utt-bar to-bar" style="width:${toW}px">${s.to}</span>` +
            `<span class="utt-bar-delta ${delta > 0 ? 'delta-pos' : 'delta-neg'}">${delta > 0 ? '+' + delta : delta}</span>` +
            '</div></div>';
    }).join('');
    return `<h4>Utterance Status</h4><div class="utt-bars">${rows}</div>`;
}

function contributionSection(m) {
    const fromMap = new Map(m.from.contributions.map(c => [c.speakerName, c]));
    const toMap = new Map(m.to.contributions.map(c => [c.speakerName, c]));
    const speakers = [...new Set([...fromMap.keys(), ...toMap.keys()])];

    const order = (s) => {
        const f = fromMap.get(s), t = toMap.get(s);
        return !f ? 2 : !t ? 3 : (f.text !== t.text ? 1 : 4);
    };
    speakers.sort((a, b) => order(a) - order(b));

    let html = '<div class="contributions-section">';
    for (const s of speakers) {
        const f = fromMap.get(s);
        const t = toMap.get(s);
        if (!f) {
            html += `<div class="contrib-item contrib-added"><div class="contrib-speaker">${esc(s)} <span class="badge badge-green">added</span></div><div class="contrib-text to-text">${esc(t.text)}</div></div>`;
        } else if (!t) {
            html += `<div class="contrib-item contrib-removed"><div class="contrib-speaker">${esc(s)} <span class="badge badge-red">removed</span></div><div class="contrib-text from-text">${esc(f.text)}</div></div>`;
        } else if (f.text !== t.text) {
            html += `<div class="contrib-item contrib-changed"><div class="contrib-speaker">${esc(s)} <span class="badge badge-yellow">changed</span></div><div class="contrib-diff">${wordDiff(f.text, t.text)}</div></div>`;
        } else {
            html += `<div class="contrib-item contrib-identical"><div class="contrib-speaker">${esc(s)} <span class="badge badge-gray">identical</span></div><div class="contrib-text">${esc(f.text)}</div></div>`;
        }
    }
    return html + '</div>';
}

function matchedSubjectHtml(m, idx) {
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
      <div class="desc-diff">${wordDiff(m.from.description, m.to.description)}</div>
      <button class="toggle-sbs-btn" onclick="toggleSideBySide('sbs-${idx}')">Toggle side-by-side</button>
      <div class="side-by-side" id="sbs-${idx}">
        <div class="sbs-col from-col"><h5>from</h5><div>${esc(m.from.description)}</div></div>
        <div class="sbs-col to-col"><h5>to</h5><div>${esc(m.to.description)}</div></div>
      </div>`;
    } else {
        body += `<h4>Description <span class="badge badge-gray">identical</span></h4><div class="desc-text">${esc(m.from.description)}</div>`;
    }

    if (m.from.context !== m.to.context) {
        body += `<h4>Context</h4><div class="desc-diff">${wordDiff(m.from.context, m.to.context)}</div>`;
    }

    body += `<h4>Contributions</h4>${contributionSection(m)}`;
    body += utteranceBars(m);

    return `<details class="subject-detail" data-subject-idx="${idx}"${open}>
    <summary>#${m.agendaItemIndex ?? '~'} — ${esc(m.from.name)} ${m.matchedBy === 'name' ? '<span class="badge badge-blue">name-matched</span>' : ''}${changeBadges(m)}</summary>
    <div class="subject-body">${body}</div>
  </details>`;
}

function unmatchedCard(s, side) {
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

function segmentSampleHtml(s) {
    return `<div class="segment-sample">
      <div class="seg-header"><span class="mono">segment #${s.index}</span><span class="mono">${esc(s.segmentId.slice(0, 12))}…</span><span class="badge badge-gray">${esc(s.from.type ?? s.to.type ?? '')}</span></div>
      <div class="seg-diff">${wordDiff(s.from.text ?? '', s.to.text ?? '')}</div>
    </div>`;
}

function renderComparison(data) {
    const { from, to } = data.sources;
    const fromLabel = `${from.traceId.slice(0, 8)} (${from.version ?? '?'}, ${from.timestamp.slice(0, 10)})`;
    const toLabel = `${to.traceId.slice(0, 8)} (${to.version ?? '?'}, ${to.timestamp.slice(0, 10)})`;
    const v = data.verdictSummary;
    const title = from.meeting ?? from.name;
    const sf = data.stats.from;
    const st = data.stats.to;

    document.title = `Compare: ${title}`;
    document.getElementById('header').innerHTML = `
  <h1>${esc(title)}</h1>
  <div class="version-badges">
    <span class="version-badge from">${esc(fromLabel)}</span>
    <span style="color:rgba(255,255,255,0.5)">→</span>
    <span class="version-badge to">${esc(toLabel)}</span>
  </div>
  <div class="timestamp">Generated: ${esc(data.generatedAt)}${from.promptsHash || to.promptsHash ? ` · prompts: ${esc(from.promptsHash ?? '?')} → ${esc(to.promptsHash ?? '?')}` : ''}</div>`;

    document.getElementById('verdict-summary').textContent =
        `${data.subjects.matched.length} matched: ${v.structural} structural, ${v.cosmetic} cosmetic, ${v.identical} identical`;

    document.getElementById('stats-grid').innerHTML = [
        statCard('Total Subjects', sf.totalSubjects, st.totalSubjects),
        statCard('Agenda Subjects', sf.agendaSubjects, st.agendaSubjects),
        statCard('Before Agenda', sf.beforeAgenda, st.beforeAgenda),
        statCard('Out of Agenda', sf.outOfAgenda, st.outOfAgenda),
        statCard('Contributions', sf.totalContributions, st.totalContributions),
        statCard('Utterances Assigned', sf.totalUtterancesAssigned, st.totalUtterancesAssigned),
    ].join('\n');

    document.getElementById('matched-heading').textContent = `Matched Subjects (${data.subjects.matched.length})`;
    document.getElementById('matched-subjects').innerHTML = data.subjects.matched.map((m, i) => matchedSubjectHtml(m, i)).join('\n');

    document.getElementById('from-only-heading').textContent = `From Only (${data.subjects.fromOnly.length})`;
    document.getElementById('from-only').innerHTML = data.subjects.fromOnly.map(s => unmatchedCard(s, 'from')).join('\n');
    document.getElementById('to-only-heading').textContent = `To Only (${data.subjects.toOnly.length})`;
    document.getElementById('to-only').innerHTML = data.subjects.toOnly.map(s => unmatchedCard(s, 'to')).join('\n');

    document.getElementById('segments-heading').textContent = `Segment Samples (${data.segmentSamples.length})`;
    document.getElementById('segments-summary').textContent = `Show ${data.segmentSamples.length} segment differences`;
    document.getElementById('segment-samples').innerHTML = data.segmentSamples.map(s => segmentSampleHtml(s)).join('\n');

    reviewSubjects = data.subjects.matched.map((m, i) => ({
        idx: i,
        label: m.agendaItemIndex !== null ? '#' + m.agendaItemIndex : '~',
        name: m.from.name,
        verdict: m.verdict,
    }));
}

function toggleAll(open) {
    document.querySelectorAll('details.subject-detail').forEach(d => d.open = open);
}

function toggleSideBySide(id) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('visible');
}

// --- Review mode: full-screen subject-by-subject walkthrough over the rendered DOM ---

var reviewSubjects = [];
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
    const s = reviewSubjects[reviewIdx];
    document.getElementById('review-counter').textContent = (reviewIdx + 1) + ' / ' + reviewSubjects.length;
    document.getElementById('review-title').textContent = s.label + ' [' + s.verdict + '] ' + s.name;
    const detail = document.querySelector('[data-subject-idx="' + s.idx + '"]');
    const body = document.getElementById('review-body');
    if (!detail) { body.innerHTML = '<p>Subject not found</p>'; return; }
    if (reviewDepth === 'desc') {
        let content = '';
        const topicRow = detail.querySelector('.field-row');
        if (topicRow) content += topicRow.outerHTML;
        const descDiff = detail.querySelector('.desc-diff');
        const descText = detail.querySelector('.desc-text');
        if (descDiff) content += '<h4>Description</h4>' + descDiff.outerHTML;
        else if (descText) content += '<h4>Description</h4>' + descText.outerHTML;
        const uttBars = detail.querySelector('.utt-bars');
        if (uttBars) content += '<h4>Utterance Status</h4>' + uttBars.outerHTML;
        body.innerHTML = content || '<p style="color:#999">No description changes</p>';
    } else {
        const contribs = detail.querySelector('.contributions-section');
        body.innerHTML = contribs ? contribs.outerHTML : '<p style="color:#999">No contributions</p>';
    }
    document.getElementById('review-overlay').scrollTop = 0;
}

function init() {
    const data = JSON.parse(document.getElementById('comparison-data').textContent);
    renderComparison(data);
    document.addEventListener('keydown', function (e) {
        if (!document.getElementById('review-overlay').classList.contains('active')) return;
        if (e.key === 'ArrowLeft') { e.preventDefault(); reviewNav(-1); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); reviewNav(1); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); setDepth('contribs'); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setDepth('desc'); }
        else if (e.key === 'Escape') { e.preventDefault(); exitReview(); }
    });
}

if (typeof document !== 'undefined') init();

export { cleanRefs, esc, wordDiff, changeBadges, statCard, utteranceBars, contributionSection, matchedSubjectHtml, unmatchedCard, segmentSampleHtml };
