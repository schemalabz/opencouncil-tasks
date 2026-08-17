import { Diarization } from '../types.js';
import { DiarizationModeComparison } from './diarizationModeComparison.js';

/**
 * Renders one or more diarization-mode comparison reports as a single
 * self-contained HTML page (no external assets), suitable for sharing.
 */

const CATEGORICAL_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
const CATEGORICAL_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
const OTHER_SPEAKER = '#898781'; // muted — speakers beyond the 8 categorical slots

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const fmtTime = (t: number) => {
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
};

/** Shorten raw diarization speaker labels for legends: SEG1:SPEAKER_03 -> S03, personIds -> id:xxxx */
const speakerShortLabel = (speaker: string) => {
    const m = speaker.match(/SPEAKER_(\d+)$/);
    if (m) return `S${m[1]}`;
    return `id:${speaker.slice(0, 4)}`;
};

/** Greedy interval partitioning: assign each segment the lowest lane free at its start. */
function assignLanes(timeline: Diarization): { lane: number; start: number; end: number; speaker: string }[] {
    const sorted = [...timeline].sort((a, b) => a.start - b.start || a.end - b.end);
    const laneEnds: number[] = [];
    return sorted.map((seg) => {
        let lane = laneEnds.findIndex((end) => end <= seg.start);
        if (lane === -1) { lane = laneEnds.length; laneEnds.push(0); }
        laneEnds[lane] = seg.end;
        return { lane, ...seg };
    });
}

/** Time ranges where >= 2 segments are active. */
function overlapRanges(timeline: Diarization): { start: number; end: number }[] {
    const events: [number, number][] = [];
    for (const s of timeline) events.push([s.start, 1], [s.end, -1]);
    events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const ranges: { start: number; end: number }[] = [];
    let active = 0;
    let openAt: number | null = null;
    for (const [t, delta] of events) {
        active += delta;
        if (active >= 2 && openAt === null) openAt = t;
        if (active < 2 && openAt !== null) { ranges.push({ start: openAt, end: t }); openAt = null; }
    }
    return ranges;
}

/** The windowSeconds-wide window with the most overlapped speech in the timeline. */
function busiestOverlapWindow(timeline: Diarization, windowSeconds: number): { start: number; end: number } {
    const ranges = overlapRanges(timeline);
    const duration = Math.max(...timeline.map((s) => s.end), windowSeconds);
    let best = { start: 0, overlap: -1 };
    for (let t = 0; t + windowSeconds <= duration + 10; t += 10) {
        const overlap = ranges.reduce((sum, r) => sum + Math.max(0, Math.min(r.end, t + windowSeconds) - Math.max(r.start, t)), 0);
        if (overlap > best.overlap) best = { start: t, overlap };
    }
    return { start: best.start, end: best.start + windowSeconds };
}

/** Top-8 speakers (by speech time) get categorical slots; the rest share the muted color. */
function speakerColorMap(timelines: { regular: Diarization; exclusive: Diarization }): Map<string, number> {
    const time: Record<string, number> = {};
    for (const seg of [...timelines.regular, ...timelines.exclusive]) {
        time[seg.speaker] = (time[seg.speaker] || 0) + (seg.end - seg.start);
    }
    const ranked = Object.entries(time).sort((a, b) => b[1] - a[1]).map(([spk]) => spk);
    const map = new Map<string, number>();
    ranked.forEach((spk, i) => map.set(spk, i < 8 ? i : -1));
    return map;
}

function timelineTrackSvg(
    timeline: Diarization,
    colorOf: Map<string, number>,
    window: { start: number; end: number },
    opts: { lanes: boolean; showOverlap: boolean },
): string {
    const W = 1000;
    const span = window.end - window.start;
    const x = (t: number) => ((t - window.start) / span) * W;
    const visible = timeline.filter((s) => s.end > window.start && s.start < window.end);

    const placed = opts.lanes ? assignLanes(visible) : visible.map((s) => ({ lane: 0, ...s }));
    const laneCount = Math.max(1, ...placed.map((p) => p.lane + 1));
    const laneH = 16, laneGap = 2;
    const trackH = laneCount * laneH + (laneCount - 1) * laneGap;
    const overlapH = opts.showOverlap ? 6 : 0;
    const H = trackH + (overlapH ? overlapH + 3 : 0);

    const rects = placed.map((p) => {
        const x0 = Math.max(0, x(p.start));
        const x1 = Math.min(W, x(p.end));
        const w = Math.max(x1 - x0, 0.6);
        const slot = colorOf.get(p.speaker) ?? -1;
        const cls = slot >= 0 ? `spk-${slot}` : 'spk-other';
        const y = p.lane * (laneH + laneGap);
        return `<rect class="seg ${cls}" x="${x0.toFixed(2)}" y="${y}" width="${w.toFixed(2)}" height="${laneH}" rx="2" ` +
            `data-tip="${esc(speakerShortLabel(p.speaker))} · ${fmtTime(p.start)}–${fmtTime(p.end)}"></rect>`;
    }).join('');

    let overlapBand = '';
    if (opts.showOverlap) {
        const y = trackH + 3;
        overlapBand = overlapRanges(visible)
            .map((r) => {
                const x0 = Math.max(0, x(r.start)), x1 = Math.min(W, x(r.end));
                if (x1 <= x0) return '';
                return `<rect class="overlap" x="${x0.toFixed(2)}" y="${y}" width="${(x1 - x0).toFixed(2)}" height="${overlapH}" ` +
                    `data-tip="overlapping speech · ${fmtTime(r.start)}–${fmtTime(r.end)}"></rect>`;
            }).join('');
    }

    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:${H}px;display:block">${rects}${overlapBand}</svg>`;
}

function timelineLegend(colorOf: Map<string, number>): string {
    const entries = [...colorOf.entries()].filter(([, slot]) => slot >= 0).sort((a, b) => a[1] - b[1]);
    const hasOther = [...colorOf.values()].some((s) => s < 0);
    return `<div class="legend">` +
        entries.map(([spk, slot]) => `<span class="key"><span class="swatch spk-${slot}"></span>${esc(speakerShortLabel(spk))}</span>`).join('') +
        (hasOther ? `<span class="key"><span class="swatch spk-other"></span>other</span>` : '') +
        `<span class="key"><span class="swatch overlap-swatch"></span>overlapping speech</span>` +
        `</div>`;
}

function tile(label: string, value: string, note?: string, deltaHtml?: string): string {
    return `<div class="tile"><div class="tile-label">${esc(label)}</div><div class="tile-value">${value}${deltaHtml ?? ''}</div>` +
        (note ? `<div class="tile-note">${esc(note)}</div>` : '') + `</div>`;
}

function agreementBars(reports: DiarizationModeComparison[]): string {
    const rows = reports.filter((r) => r.adjudication).map((r) => {
        const name = r.meta?.meeting ?? 'meeting';
        const a = r.adjudication!;
        const bar = (cls: string, pct: number, label: string) =>
            `<div class="bar-row"><div class="bar-track"><div class="bar ${cls}" style="width:${pct}%" ` +
            `data-tip="${esc(label)}: ${pct}%"></div><span class="bar-val">${pct}%</span></div></div>`;
        return `<div class="bar-group"><div class="bar-name">${esc(name)}</div>` +
            bar('series-regular', a.agreementPercent.regular, `${name} regular`) +
            bar('series-exclusive', a.agreementPercent.exclusive, `${name} exclusive`) +
            `</div>`;
    }).join('');
    return `<div class="chart">
        <div class="legend"><span class="key"><span class="swatch series-regular"></span>regular</span>` +
        `<span class="key"><span class="swatch series-exclusive"></span>exclusive</span></div>
        ${rows}
    </div>`;
}

function meetingSection(report: DiarizationModeComparison): string {
    const name = report.meta?.meeting ?? 'meeting';
    const dur = report.meta?.audioDurationSeconds ?? 0;
    const a = report.adjudication;
    const overlapShare = report.regular.timeline.speechSeconds
        ? Math.round((report.regular.timeline.overlapSeconds / report.regular.timeline.speechSeconds) * 100)
        : 0;

    const tiles = [
        a ? tile('Agreement with human turns', `${a.agreementPercent.exclusive}%`,
            `regular: ${a.agreementPercent.regular}%`,
            ` <span class="delta ${a.agreementPercent.exclusive >= a.agreementPercent.regular ? 'up' : 'down'}">` +
            `${a.agreementPercent.exclusive >= a.agreementPercent.regular ? '▲' : '▼'} ` +
            `${Math.abs(Math.round((a.agreementPercent.exclusive - a.agreementPercent.regular) * 10) / 10)} pp</span>`) : '',
        a ? tile('Disagreements adjudicated', `${a.disagreements.onlyExclusiveRight} : ${a.disagreements.onlyRegularRight}`,
            'exclusive right : regular right') : '',
        tile('Overlapped speech (regular)', `${overlapShare}%`, `${Math.round(report.regular.timeline.overlapSeconds)}s of ${Math.round(report.regular.timeline.speechSeconds)}s`),
        tile('Ambiguous utterances', `${report.regular.ambiguous} → ${report.exclusive.ambiguous}`, 'regular → exclusive'),
        tile('Changed speaker', `${report.diff.speakerChanged.length}`, `of ${report.regular.utterances.total} utterances`),
        tile('Nearest-segment fallbacks', `${report.regular.fallbackAssigned} → ${report.exclusive.fallbackAssigned}`, 'utterances attributed by guess, regular → exclusive'),
    ].join('');

    let strips = '';
    if (report.timelines) {
        const colorOf = speakerColorMap(report.timelines);
        const full = { start: 0, end: Math.max(dur, ...report.timelines.regular.map((s) => s.end)) };
        const zoom = busiestOverlapWindow(report.timelines.regular, 180);
        strips = `
        <h4>Speaker timelines — full meeting (${fmtTime(full.end)})</h4>
        ${timelineLegend(colorOf)}
        <div class="strip"><div class="strip-label">regular</div>${timelineTrackSvg(report.timelines.regular, colorOf, full, { lanes: true, showOverlap: true })}</div>
        <div class="strip"><div class="strip-label">exclusive</div>${timelineTrackSvg(report.timelines.exclusive, colorOf, full, { lanes: true, showOverlap: true })}</div>
        <h4>Zoom: busiest cross-talk window (${fmtTime(zoom.start)}–${fmtTime(zoom.end)})</h4>
        <div class="strip"><div class="strip-label">regular</div>${timelineTrackSvg(report.timelines.regular, colorOf, zoom, { lanes: true, showOverlap: true })}</div>
        <div class="strip"><div class="strip-label">exclusive</div>${timelineTrackSvg(report.timelines.exclusive, colorOf, zoom, { lanes: true, showOverlap: true })}</div>`;
    }

    let examples = '';
    if (a && a.details.length) {
        const VERDICT = {
            'fixed': { cls: 'v-fixed', label: '✓ fixed by exclusive' },
            'broken': { cls: 'v-broken', label: '✗ broken by exclusive' },
            'both-wrong': { cls: 'v-neither', label: '— both wrong' },
        } as const;
        const cell = (says: string | null, correct: boolean) =>
            says === null ? '<td class="says-skip">— skipped</td>' : `<td class="${correct ? 'says-right' : 'says-wrong'}">${esc(says)}</td>`;
        const row = (d: (typeof a.details)[number]) =>
            `<tr><td class="t-num">${fmtTime(d.start)}</td><td class="utt">${esc(d.text.length > 110 ? d.text.slice(0, 110) + '…' : d.text)}</td>` +
            cell(d.regularSays, d.regularSays === d.humanSays) +
            cell(d.exclusiveSays, d.exclusiveSays === d.humanSays) +
            `<td>${esc(d.humanSays)}</td>` +
            `<td><span class="verdict ${VERDICT[d.verdict].cls}">${VERDICT[d.verdict].label}</span></td></tr>`;
        // Every disputed utterance, worst-confusion first: fixes, then regressions, then both-wrong
        const order = { 'fixed': 0, 'broken': 1, 'both-wrong': 2 } as const;
        const sorted = [...a.details].sort((x, y) => order[x.verdict] - order[y.verdict] || x.start - y.start);
        const shown = sorted.slice(0, 20);
        examples = `
        <h4>Who each version blamed — utterances where the two timelines disagree</h4>
        <p class="note">"Reviewer says" comes from the human-corrected transcript on opencouncil.
        ${a.details.length > shown.length ? `Showing ${shown.length} of ${a.details.length}; the rest are in the report JSON.` : ''}</p>
        <div class="table-scroll"><table><thead><tr><th>time</th><th>utterance</th><th>regular says</th><th>exclusive says</th><th>reviewer says</th><th>verdict</th></tr></thead><tbody>
        ${shown.map(row).join('')}
        </tbody></table></div>`;
    }

    const metricsTable = `
    <details><summary>All metrics</summary>
    <table><thead><tr><th>metric</th><th>regular</th><th>exclusive</th></tr></thead><tbody>
    <tr><td>assigned utterances</td><td class="t-num">${report.regular.utterances.assigned}/${report.regular.utterances.total}</td><td class="t-num">${report.exclusive.utterances.assigned}/${report.exclusive.utterances.total}</td></tr>
    <tr><td>skipped</td><td class="t-num">${report.regular.utterances.skippedPercent}%</td><td class="t-num">${report.exclusive.utterances.skippedPercent}%</td></tr>
    <tr><td>ambiguous</td><td class="t-num">${report.regular.ambiguous}</td><td class="t-num">${report.exclusive.ambiguous}</td></tr>
    <tr><td>drift total</td><td class="t-num">${report.regular.drift.total}</td><td class="t-num">${report.exclusive.drift.total}</td></tr>
    <tr><td>timeline segments</td><td class="t-num">${report.regular.timeline.segments}</td><td class="t-num">${report.exclusive.timeline.segments}</td></tr>
    <tr><td>overlapped speech</td><td class="t-num">${report.regular.timeline.overlapSeconds}s</td><td class="t-num">${report.exclusive.timeline.overlapSeconds}s</td></tr>
    ${a ? `<tr><td>agreement with human turns</td><td class="t-num">${a.agreementPercent.regular}% (${a.agree.regular}/${a.scored.regular})</td><td class="t-num">${a.agreementPercent.exclusive}% (${a.agree.exclusive}/${a.scored.exclusive})</td></tr>` : ''}
    </tbody></table></details>`;

    return `<section>
        <h3>${esc(name)} <span class="muted">· ${fmtTime(dur)} · ${report.regular.utterances.total} utterances</span></h3>
        <div class="tiles">${tiles}</div>
        ${strips}
        ${examples}
        ${metricsTable}
    </section>`;
}

export function renderDiarizationModeReportHtml(reports: DiarizationModeComparison[]): string {
    const adjudicated = reports.filter((r) => r.adjudication);
    const wSum = (f: (r: DiarizationModeComparison) => number, w: (r: DiarizationModeComparison) => number) => {
        const tw = adjudicated.reduce((s, r) => s + w(r), 0);
        return tw ? adjudicated.reduce((s, r) => s + f(r) * w(r), 0) / tw : 0;
    };
    const meanRegular = Math.round(wSum((r) => r.adjudication!.agreementPercent.regular, (r) => r.adjudication!.scored.regular) * 10) / 10;
    const meanExclusive = Math.round(wSum((r) => r.adjudication!.agreementPercent.exclusive, (r) => r.adjudication!.scored.exclusive) * 10) / 10;
    const exclusiveRight = adjudicated.reduce((s, r) => s + r.adjudication!.disagreements.onlyExclusiveRight, 0);
    const regularRight = adjudicated.reduce((s, r) => s + r.adjudication!.disagreements.onlyRegularRight, 0);
    const totalOverlap = reports.reduce((s, r) => s + r.regular.timeline.overlapSeconds, 0);
    const totalSpeech = reports.reduce((s, r) => s + r.regular.timeline.speechSeconds, 0);
    const totalChanged = reports.reduce((s, r) => s + r.diff.speakerChanged.length, 0);
    const totalUtterances = reports.reduce((s, r) => s + r.regular.utterances.total, 0);

    return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pyannote exclusive diarization — evaluation</title>
<style>
.viz-root {
    color-scheme: light;
    --surface-1: #fcfcfb; --page: #f9f9f7;
    --text-primary: #0b0b0b; --text-secondary: #52514e; --muted: #898781;
    --grid: #e1e0d9; --border: rgba(11,11,11,0.10);
    --good-text: #006300;
    --s0:${CATEGORICAL_LIGHT[0]};--s1:${CATEGORICAL_LIGHT[1]};--s2:${CATEGORICAL_LIGHT[2]};--s3:${CATEGORICAL_LIGHT[3]};
    --s4:${CATEGORICAL_LIGHT[4]};--s5:${CATEGORICAL_LIGHT[5]};--s6:${CATEGORICAL_LIGHT[6]};--s7:${CATEGORICAL_LIGHT[7]};
    --other:${OTHER_SPEAKER}; --overlap:#52514e;
}
@media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) .viz-root {
        color-scheme: dark;
        --surface-1: #1a1a19; --page: #0d0d0d;
        --text-primary: #ffffff; --text-secondary: #c3c2b7; --muted: #898781;
        --grid: #2c2c2a; --border: rgba(255,255,255,0.10);
        --good-text: #0ca30c;
        --s0:${CATEGORICAL_DARK[0]};--s1:${CATEGORICAL_DARK[1]};--s2:${CATEGORICAL_DARK[2]};--s3:${CATEGORICAL_DARK[3]};
        --s4:${CATEGORICAL_DARK[4]};--s5:${CATEGORICAL_DARK[5]};--s6:${CATEGORICAL_DARK[6]};--s7:${CATEGORICAL_DARK[7]};
        --overlap:#c3c2b7;
    }
}
:root[data-theme="dark"] .viz-root {
    color-scheme: dark;
    --surface-1: #1a1a19; --page: #0d0d0d;
    --text-primary: #ffffff; --text-secondary: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --border: rgba(255,255,255,0.10);
    --good-text: #0ca30c;
    --s0:${CATEGORICAL_DARK[0]};--s1:${CATEGORICAL_DARK[1]};--s2:${CATEGORICAL_DARK[2]};--s3:${CATEGORICAL_DARK[3]};
    --s4:${CATEGORICAL_DARK[4]};--s5:${CATEGORICAL_DARK[5]};--s6:${CATEGORICAL_DARK[6]};--s7:${CATEGORICAL_DARK[7]};
    --overlap:#c3c2b7;
}
.viz-root { background: var(--page); color: var(--text-primary);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 24px;
    line-height: 1.45; }
.viz-root main { max-width: 980px; margin: 0 auto; }
h1 { font-size: 22px; margin: 0 0 4px; }
h3 { font-size: 17px; margin: 0 0 12px; }
h4 { font-size: 13px; color: var(--text-secondary); margin: 18px 0 6px; font-weight: 600; }
.sub { color: var(--text-secondary); margin: 0 0 24px; font-size: 14px; }
section, .chart-card { background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px;
    padding: 18px 20px; margin: 0 0 18px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 6px; }
.tile { border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; }
.tile-label { font-size: 12px; color: var(--text-secondary); }
.tile-value { font-size: 22px; font-weight: 600; margin-top: 2px; }
.tile-note { font-size: 11px; color: var(--muted); margin-top: 2px; }
.delta { font-size: 12px; font-weight: 600; margin-left: 4px; }
.delta.up { color: var(--good-text); }
.delta.down { color: #d03b3b; }
.muted { color: var(--muted); font-weight: 400; font-size: 13px; }
.legend { display: flex; flex-wrap: wrap; gap: 10px 14px; font-size: 12px; color: var(--text-secondary); margin: 6px 0 10px; }
.key { display: inline-flex; align-items: center; gap: 5px; }
.swatch { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
.series-regular { background: var(--s0); }
.series-exclusive { background: var(--s1); }
.overlap-swatch { background: var(--overlap); height: 4px; }
.spk-0{fill:var(--s0);background:var(--s0)} .spk-1{fill:var(--s1);background:var(--s1)}
.spk-2{fill:var(--s2);background:var(--s2)} .spk-3{fill:var(--s3);background:var(--s3)}
.spk-4{fill:var(--s4);background:var(--s4)} .spk-5{fill:var(--s5);background:var(--s5)}
.spk-6{fill:var(--s6);background:var(--s6)} .spk-7{fill:var(--s7);background:var(--s7)}
.spk-other{fill:var(--other);background:var(--other)}
.overlap{fill:var(--overlap)}
.seg:hover{opacity:0.75}
.strip { display: grid; grid-template-columns: 74px 1fr; gap: 8px; align-items: center; margin: 4px 0; }
.strip-label { font-size: 12px; color: var(--text-secondary); text-align: right; }
.bar-group { margin: 10px 0; }
.bar-name { font-size: 13px; margin-bottom: 3px; }
.bar-row { margin: 2px 0; }
.bar-track { position: relative; background: transparent; height: 16px; display: flex; align-items: center; }
.bar { height: 16px; border-radius: 0 4px 4px 0; min-width: 2px; }
.bar-val { font-size: 12px; color: var(--text-secondary); margin-left: 6px; font-variant-numeric: tabular-nums; }
table { border-collapse: collapse; font-size: 13px; margin-top: 8px; width: 100%; }
th { text-align: left; color: var(--text-secondary); font-weight: 600; }
th, td { padding: 5px 10px 5px 0; border-bottom: 1px solid var(--grid); vertical-align: top; }
.t-num { font-variant-numeric: tabular-nums; white-space: nowrap; }
.verdict { font-size: 12px; font-weight: 600; white-space: nowrap; }
.v-fixed { color: var(--good-text); }
.v-broken { color: #d03b3b; }
.v-neither { color: var(--muted); }
.says-right { color: var(--text-primary); }
.says-wrong { color: var(--muted); text-decoration: line-through; text-decoration-color: var(--muted); }
.says-skip { color: var(--muted); font-style: italic; }
.utt { min-width: 220px; }
.note { font-size: 12px; color: var(--muted); margin: 0 0 4px; }
.table-scroll { overflow-x: auto; }
details { margin-top: 12px; }
summary { cursor: pointer; font-size: 13px; color: var(--text-secondary); }
.method { background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px;
    padding: 12px 20px; margin: -8px 0 18px; }
.method ol { font-size: 13px; color: var(--text-secondary); padding-left: 20px; margin: 10px 0 6px; }
.method li { margin: 6px 0; }
.method strong { color: var(--text-primary); }
.tooltip { position: fixed; pointer-events: none; background: var(--text-primary); color: var(--page);
    font-size: 12px; padding: 4px 8px; border-radius: 5px; z-index: 10; display: none; white-space: nowrap; }
footer { color: var(--muted); font-size: 12px; margin: 24px 0 8px; }
code { font-size: 12px; }
@media (max-width: 640px) { .strip { grid-template-columns: 1fr; gap: 2px; } .strip-label { text-align: left; } }
</style>
<div class="viz-root"><main>
<h1>Pyannote <code>exclusive: true</code> — paired evaluation</h1>
<p class="sub">Each meeting was diarized once; the API returned both the regular and the overlap-free
(exclusive) timeline from the same inference. Both were aligned against a fresh transcript with the
production alignment logic, then scored against the meeting's human-reviewed speaker turns.</p>

<details class="method"><summary>Methodology — how "right" and "wrong" are decided</summary>
<ol>
<li><strong>Paired diarization.</strong> One Pyannote call per meeting returns both timelines from the same
inference, so the comparison has no run-to-run variance. No voiceprints were used — every diarized
speaker is an anonymous cluster like <code>SPEAKER_03</code>.</li>
<li><strong>Fresh transcript, real alignment.</strong> The audio was re-transcribed with Scribe (word
timestamps, no speakers) and aligned against each timeline with the production
<code>DiarizationManager</code>. Result per variant: every utterance → an anonymous speaker.</li>
<li><strong>Answer key.</strong> The public OpenCouncil API serves each meeting's transcript as it exists on
the site — human-reviewed, with correctors having fixed text and speaker assignments. Those corrected
speaker turns are the ground truth; the people API resolves names.</li>
<li><strong>Anchoring.</strong> Each variant's anonymous speakers are identified by majority vote: if most
utterances a variant assigned to <code>SPEAKER_03</code> fall inside reviewed turns of person X,
that cluster <em>is</em> X. Applied independently and identically to both variants.</li>
<li><strong>Scoring.</strong> An utterance counts as right when its variant's anchored identity matches the
reviewer's turn at its midpoint. Utterances outside any reviewed turn are excluded.</li>
</ol>
<p class="note">Caveats: ground truth is as good as the human review; a badly mixed cluster would break
anchoring but would surface as low agreement; the reviewed transcripts originated from
regular-timeline pipeline runs, which if anything biases scoring against exclusive.</p>
</details>

<div class="chart-card">
<div class="tiles">
${tile('Agreement with human turns (weighted mean)', `${meanExclusive}%`, `regular: ${meanRegular}%`,
        ` <span class="delta ${meanExclusive >= meanRegular ? 'up' : 'down'}">${meanExclusive >= meanRegular ? '▲' : '▼'} ${Math.abs(Math.round((meanExclusive - meanRegular) * 10) / 10)} pp</span>`)}
${tile('Disagreements adjudicated', `${exclusiveRight} : ${regularRight}`, 'exclusive right : regular right')}
${tile('Overlapped speech in regular timelines', `${totalSpeech ? Math.round((totalOverlap / totalSpeech) * 100) : 0}%`, `${Math.round(totalOverlap / 60)} min across ${reports.length} meetings`)}
${tile('Utterances that change speaker', `${totalChanged}`, `of ${totalUtterances} total`)}
</div>
<h4>Agreement with human-reviewed speaker turns, by meeting</h4>
${agreementBars(reports)}
</div>

${reports.map(meetingSection).join('\n')}

<footer>Generated by <code>npm run cli -- render-diarization-comparison</code> ·
opencouncil-tasks branch <code>feat/exclusive-diarization-eval</code> · issue #15</footer>
</main>
<div class="tooltip" id="tt"></div>
<script>
(function () {
    var tt = document.getElementById('tt');
    document.addEventListener('mousemove', function (e) {
        var el = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
        if (!el) { tt.style.display = 'none'; return; }
        tt.textContent = el.getAttribute('data-tip');
        tt.style.display = 'block';
        var x = Math.min(e.clientX + 12, window.innerWidth - tt.offsetWidth - 8);
        var y = Math.min(e.clientY + 14, window.innerHeight - tt.offsetHeight - 8);
        tt.style.left = x + 'px'; tt.style.top = y + 'px';
    });
})();
</script>
</div>`;
}
