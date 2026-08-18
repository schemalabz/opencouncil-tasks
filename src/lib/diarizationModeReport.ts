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

/**
 * One thin strip for the whole meeting showing only where cross-talk happens,
 * with the zoomed window boxed. The full speaker layout is unreadable at this
 * scale — density is the only honest signal, and it situates the zoom below.
 */
function crossTalkDensityStrip(timeline: Diarization, fullEnd: number, zoom: { start: number; end: number }, idx: number): string {
    const W = 1000, H = 14;
    const x = (t: number) => (t / fullEnd) * W;
    const marks = overlapRanges(timeline).map((r) =>
        `<rect class="overlap" x="${x(r.start).toFixed(2)}" y="2" width="${Math.max(x(r.end) - x(r.start), 0.8).toFixed(2)}" height="${H - 4}" ` +
        `data-tip="people talking over each other · ${fmtTime(r.start)}–${fmtTime(r.end)}"></rect>`).join('');
    const zoomBox = `<rect class="zoom-box" id="zb-${idx}" x="${x(zoom.start).toFixed(2)}" y="0.5" width="${(x(zoom.end) - x(zoom.start)).toFixed(2)}" height="${H - 1}"></rect>`;
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:${H}px;display:block">` +
        `<rect class="density-track" x="0" y="${H / 2 - 1}" width="${W}" height="2"></rect>${marks}${zoomBox}</svg>`;
}

/** Compact per-meeting payload for the client-side window inspector. */
function embedTimelineData(
    timelines: { regular: Diarization; exclusive: Diarization },
    colorOf: Map<string, number>,
    fullEnd: number,
    init: number,
    idx: number,
): string {
    const spkIndex = new Map<string, number>();
    const spk: { l: string; c: string }[] = [];
    const indexOf = (speaker: string) => {
        if (!spkIndex.has(speaker)) {
            const slot = colorOf.get(speaker) ?? -1;
            spkIndex.set(speaker, spk.length);
            spk.push({ l: speakerShortLabel(speaker), c: slot >= 0 ? `spk-${slot}` : 'spk-other' });
        }
        return spkIndex.get(speaker)!;
    };
    const pack = (tl: Diarization) => tl.map((s) => [Math.round(s.start * 100) / 100, Math.round(s.end * 100) / 100, indexOf(s.speaker)]);
    const payload = { fullEnd: Math.round(fullEnd), win: 180, init: Math.round(init), spk, reg: pack(timelines.regular), exc: pack(timelines.exclusive) };
    return `<script type="application/json" id="tl-${idx}">${JSON.stringify(payload).replace(/</g, '\\u003c')}</script>`;
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

/**
 * Dumbbell plot: one row per meeting, a dot for each variant's agreement score,
 * rows sorted by cross-talk share so the report's thesis — more cross-talk,
 * bigger gain — is visible as a shape. Dots need no zero baseline, so the axis
 * can zoom to where the data lives without lying the way a truncated bar would.
 */
function agreementDumbbells(reports: DiarizationModeComparison[]): string {
    const rows = reports
        .filter((r) => r.adjudication)
        .map((r) => {
            const a = r.adjudication!;
            const crossTalk = r.regular.timeline.speechSeconds
                ? Math.round((r.regular.timeline.overlapSeconds / r.regular.timeline.speechSeconds) * 100) : 0;
            return { name: r.meta?.meeting ?? 'meeting', crossTalk, reg: a.agreementPercent.regular, exc: a.agreementPercent.exclusive };
        })
        .sort((x, y) => y.crossTalk - x.crossTalk);
    if (!rows.length) return '';

    const lo = Math.floor(Math.min(...rows.flatMap((r) => [r.reg, r.exc])) / 5) * 5 - 1;
    const hi = 100;
    const x = (v: number) => ((v - lo) / (hi - lo)) * 100;
    const ticks: number[] = [];
    for (let t = Math.ceil(lo / 5) * 5; t <= hi; t += 5) ticks.push(t);

    const rowHtml = rows.map((r) => {
        const delta = Math.round((r.exc - r.reg) * 10) / 10;
        const deltaLabel = delta === 0 ? '±0' : `+${delta} pp`;
        return `<div class="db-row">
            <div class="db-label">${esc(r.name)}<span class="db-crosstalk">${r.crossTalk}% cross-talk</span></div>
            <div class="db-track">
                ${ticks.map((t) => `<span class="db-grid" style="left:${x(t)}%"></span>`).join('')}
                <span class="db-connector" style="left:${x(Math.min(r.reg, r.exc))}%;width:${Math.abs(x(r.exc) - x(r.reg))}%"></span>
                <span class="db-dot db-reg" style="left:${x(r.reg)}%" data-tip="regular timeline: ${r.reg}% correct"></span>
                <span class="db-dot db-exc" style="left:${x(r.exc)}%" data-tip="exclusive timeline: ${r.exc}% correct"></span>
                <span class="db-delta ${delta > 0 ? 'up' : ''}" style="left:${x(Math.max(r.reg, r.exc))}%">${deltaLabel}</span>
            </div>
        </div>`;
    }).join('');

    return `<div class="chart">
        <div class="legend"><span class="key"><span class="swatch dot-swatch db-reg"></span>regular timeline</span>` +
        `<span class="key"><span class="swatch dot-swatch db-exc"></span>exclusive timeline</span></div>
        ${rowHtml}
        <div class="db-row db-axis-row"><div class="db-label"></div><div class="db-track db-axis">
            ${ticks.map((t) => `<span class="db-tick" style="left:${x(t)}%">${t}%</span>`).join('')}
        </div></div>
    </div>`;
}

function meetingSection(report: DiarizationModeComparison, idx: number): string {
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
        a ? tile('Disputed utterances — who was right', `${a.disagreements.onlyExclusiveRight} : ${a.disagreements.onlyRegularRight}`,
            `exclusive right : regular right, per the human reviewers · ${report.diff.speakerChanged.length} disputed in total`) : '',
        tile('Speech with cross-talk (regular)', `${overlapShare}%`, `${Math.round(report.regular.timeline.overlapSeconds)}s of ${Math.round(report.regular.timeline.speechSeconds)}s`),
        tile('Utterances needing a judgement call', `${report.regular.ambiguous} → ${report.exclusive.ambiguous}`, 'more than one candidate segment, regular → exclusive'),
    ].join('');

    let strips = '';
    if (report.timelines) {
        const colorOf = speakerColorMap(report.timelines);
        const fullEnd = Math.max(dur, ...report.timelines.regular.map((s) => s.end));
        const zoom = busiestOverlapWindow(report.timelines.regular, 180);
        const mid = (zoom.start + zoom.end) / 2;
        strips = `
        <h4>Where the cross-talk is — whole meeting (0:00–${fmtTime(fullEnd)}) · click anywhere on the map to inspect that moment</h4>
        <div class="density-wrap" data-i="${idx}">${crossTalkDensityStrip(report.timelines.regular, fullEnd, zoom, idx)}</div>
        <div class="win-head">
            <h4>Three-minute window, on both timelines · <span class="win-label" id="wl-${idx}">${fmtTime(zoom.start)}–${fmtTime(zoom.end)} (busiest cross-talk)</span></h4>
            <span class="win-controls">
                <button class="win-btn" data-nav="prev" data-i="${idx}" title="previous window">‹</button>
                <button class="win-btn" data-nav="busiest" data-i="${idx}">busiest</button>
                <button class="win-btn" data-nav="next" data-i="${idx}" title="next window">›</button>
            </span>
        </div>
        <p class="note">Regular stacks simultaneous speakers in lanes — every stacked moment is a coin toss for
        attribution. Exclusive resolves the same audio into clean turns.</p>
        ${timelineLegend(colorOf)}
        <div class="strip"><div class="strip-label">regular</div><div class="strip-svg" id="reg-${idx}">${timelineTrackSvg(report.timelines.regular, colorOf, zoom, { lanes: true, showOverlap: true })}</div></div>
        <div class="strip"><div class="strip-label">exclusive</div><div class="strip-svg" id="exc-${idx}">${timelineTrackSvg(report.timelines.exclusive, colorOf, zoom, { lanes: true, showOverlap: true })}</div></div>
        <div class="strip"><div class="strip-label"></div><div class="time-axis" id="axis-${idx}"><span>${fmtTime(zoom.start)}</span><span>${fmtTime(mid)}</span><span>${fmtTime(zoom.end)}</span></div></div>
        ${embedTimelineData(report.timelines, colorOf, fullEnd, zoom.start, idx)}`;
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
        const counts = { fixed: 0, broken: 0, 'both-wrong': 0 };
        for (const d of a.details) counts[d.verdict]++;
        const sorted = [...a.details].sort((x, y) => order[x.verdict] - order[y.verdict] || x.start - y.start);
        const shown = sorted.slice(0, 12);
        examples = `
        <h4>Who each version blamed — utterances where the two timelines disagree</h4>
        <p class="note"><span class="verdict v-fixed">${counts.fixed} fixed by exclusive</span> ·
        <span class="verdict v-broken">${counts.broken} broken by exclusive</span> ·
        <span class="verdict v-neither">${counts['both-wrong']} both wrong</span> —
        "reviewer says" comes from the human-corrected transcript on opencouncil.
        ${a.details.length > shown.length ? `Showing ${shown.length} of ${a.details.length}; the rest are in the report JSON.` : ''}</p>
        <div class="table-scroll"><table><thead><tr><th>time</th><th>utterance</th><th>regular says</th><th>exclusive says</th><th>reviewer says</th><th>verdict</th></tr></thead><tbody>
        ${shown.map(row).join('')}
        </tbody></table></div>`;
    }

    const metricsTable = `
    <details open><summary>All metrics</summary>
    <table><thead><tr><th>metric</th><th>regular</th><th>exclusive</th></tr></thead><tbody>
    <tr><td>assigned utterances</td><td class="t-num">${report.regular.utterances.assigned}/${report.regular.utterances.total}</td><td class="t-num">${report.exclusive.utterances.assigned}/${report.exclusive.utterances.total}</td></tr>
    <tr><td>skipped</td><td class="t-num">${report.regular.utterances.skippedPercent}%</td><td class="t-num">${report.exclusive.utterances.skippedPercent}%</td></tr>
    <tr><td>ambiguous</td><td class="t-num">${report.regular.ambiguous}</td><td class="t-num">${report.exclusive.ambiguous}</td></tr>
    <tr><td>drift total</td><td class="t-num">${report.regular.drift.total}</td><td class="t-num">${report.exclusive.drift.total}</td></tr>
    <tr><td>nearest-segment fallbacks</td><td class="t-num">${report.regular.fallbackAssigned}</td><td class="t-num">${report.exclusive.fallbackAssigned}</td></tr>
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
.db-row { display: grid; grid-template-columns: 190px 1fr; gap: 12px; align-items: center; margin: 14px 0; }
.db-label { font-size: 13px; text-align: right; }
.db-crosstalk { display: block; font-size: 11px; color: var(--muted); }
.db-track { position: relative; height: 22px; }
.db-grid { position: absolute; top: -4px; bottom: -4px; width: 1px; background: var(--grid); }
.db-connector { position: absolute; top: 10px; height: 2px; background: var(--baseline, var(--grid)); }
.db-dot { position: absolute; top: 6px; width: 10px; height: 10px; border-radius: 50%; margin-left: -5px;
    box-shadow: 0 0 0 2px var(--surface-1); }
.db-reg { background: var(--s0); }
.db-exc { background: var(--s1); }
.dot-swatch { border-radius: 50%; }
.db-delta { position: absolute; top: 3px; margin-left: 10px; font-size: 12px; color: var(--muted);
    font-variant-numeric: tabular-nums; white-space: nowrap; }
.db-delta.up { color: var(--good-text); font-weight: 600; }
.db-axis-row { margin: 0; }
.db-axis { height: 16px; }
.db-tick { position: absolute; transform: translateX(-50%); font-size: 11px; color: var(--muted);
    font-variant-numeric: tabular-nums; }
.density-track { fill: var(--grid); }
.zoom-box { fill: none; stroke: var(--text-primary); stroke-width: 1.2; }
.time-axis { display: flex; justify-content: space-between; font-size: 11px; color: var(--muted);
    font-variant-numeric: tabular-nums; }
.density-wrap { cursor: pointer; }
.win-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.win-label { font-variant-numeric: tabular-nums; }
.win-controls { display: inline-flex; gap: 6px; }
.win-btn { background: none; border: 1px solid var(--border); color: var(--text-secondary);
    border-radius: 6px; padding: 2px 10px; cursor: pointer; font: inherit; font-size: 13px; line-height: 1.3; }
.win-btn:hover { border-color: var(--text-secondary); color: var(--text-primary); }
.win-btn:focus-visible { outline: 2px solid var(--s0); outline-offset: 1px; }
/* Explicit inheritance: without a doctype (quirks mode) tables reset text styles
   to UA defaults, turning cells black on the dark surface */
table { border-collapse: collapse; font-size: 13px; margin-top: 8px; width: 100%;
    color: var(--text-primary); font-family: inherit; }
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
<h1>Who said what — regular vs exclusive diarization</h1>
<p class="sub">Every utterance on OpenCouncil gets a "who said this" label by combining two systems:
Pyannote hears <em>who</em> spoke <em>when</em>, and the transcription engine hears <em>what</em> was said.
When councillors talk over each other, Pyannote's regular timeline reports two speakers at the same
moment and our code has to guess between them. Pyannote's <code>exclusive</code> mode instead picks the
one speaker being transcribed at every instant. This report measures, on four real meetings, which
of the two timelines produces more correct "who said this" labels — graded against the
human-corrected transcripts on OpenCouncil.</p>

<details class="method"><summary>How this was measured — and how "right" and "wrong" are decided</summary>
<ol>
<li><strong>One diarization, two timelines.</strong> Pyannote returns both versions of the timeline from
the same run, so any difference in the results comes purely from the timeline choice — not from
randomness between runs. Pyannote doesn't know anyone's name: it only produces anonymous voices
like <code>SPEAKER_03</code>.</li>
<li><strong>Label every utterance, twice.</strong> Each meeting was freshly transcribed, and every
utterance was given a speaker using our production attribution code — once with each timeline.</li>
<li><strong>The answer key.</strong> These meetings were already human-reviewed on OpenCouncil:
correctors fixed who said what. Those corrected speaker turns (fetched from the public API) are
treated as the correct answers.</li>
<li><strong>Matching anonymous voices to real people.</strong> To compare "<code>SPEAKER_03</code>" with
"Ι. Πισιμίσης", we look at where SPEAKER_03's utterances land in the human-corrected transcript: if
most of them fall inside turns the reviewers gave to one person, that voice <em>is</em> that person.
The same rule is applied to both timelines, so neither side gets an advantage.</li>
<li><strong>Grading.</strong> An utterance counts as right when the timeline's speaker (matched to a
person as above) agrees with the human reviewer's turn at that moment. Utterances that fall outside
any reviewed turn are left out of the grade.</li>
</ol>
<p class="note">Honest caveats: the answer key is only as good as the human review; and the reviewed
transcripts were originally produced with the <em>regular</em> timeline, so if the method is biased at
all, it is biased against exclusive — which still wins.</p>
</details>

<div class="chart-card">
<div class="tiles">
${tile('Agreement with human turns (weighted mean)', `${meanExclusive}%`, `regular: ${meanRegular}%`,
        ` <span class="delta ${meanExclusive >= meanRegular ? 'up' : 'down'}">${meanExclusive >= meanRegular ? '▲' : '▼'} ${Math.abs(Math.round((meanExclusive - meanRegular) * 10) / 10)} pp</span>`)}
${tile('Disputed utterances — who was right', `${exclusiveRight} : ${regularRight}`, 'exclusive right : regular right, per the human reviewers')}
${tile('Speech with people talking over each other', `${totalSpeech ? Math.round((totalOverlap / totalSpeech) * 100) : 0}%`, `${Math.round(totalOverlap / 60)} min across ${reports.length} meetings — the situations exclusive mode resolves`)}
${tile('Utterances that change speaker', `${totalChanged}`, `of ${totalUtterances} total`)}
</div>
<h4>Correct "who said this" labels per meeting — the gain tracks how much cross-talk a meeting has</h4>
${agreementDumbbells(reports)}
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

// Window inspector: click the cross-talk map (or use the controls) to redraw
// both timelines for any three-minute stretch of the meeting.
(function () {
    var W = 1000, LANE = 16, GAP = 2;
    var data = {};
    document.querySelectorAll('script[type="application/json"][id^="tl-"]').forEach(function (s) {
        var d = JSON.parse(s.textContent);
        d.pos = d.init;
        data[s.id.slice(3)] = d;
    });

    function fmt(t) {
        var m = Math.floor(t / 60), s = Math.floor(t % 60);
        return m + ':' + (s < 10 ? '0' : '') + s;
    }

    function track(segs, spk, t0, t1) {
        var vis = segs.filter(function (s) { return s[1] > t0 && s[0] < t1; })
            .sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
        var ends = [], placed = vis.map(function (s) {
            var lane = ends.findIndex(function (e) { return e <= s[0]; });
            if (lane < 0) { lane = ends.length; ends.push(0); }
            ends[lane] = s[1];
            return { lane: lane, s: s };
        });
        var lanes = Math.max(1, ends.length);
        var x = function (t) { return (t - t0) / (t1 - t0) * W; };
        var rects = placed.map(function (p) {
            var x0 = Math.max(0, x(p.s[0])), x1 = Math.min(W, x(p.s[1])), w = Math.max(x1 - x0, 0.6);
            var k = spk[p.s[2]];
            return '<rect class="seg ' + k.c + '" x="' + x0.toFixed(2) + '" y="' + p.lane * (LANE + GAP) +
                '" width="' + w.toFixed(2) + '" height="' + LANE + '" rx="2" data-tip="' + k.l + ' · ' + fmt(p.s[0]) + '–' + fmt(p.s[1]) + '"></rect>';
        }).join('');
        var ev = [];
        vis.forEach(function (s) { ev.push([Math.max(s[0], t0), 1], [Math.min(s[1], t1), -1]); });
        ev.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
        var act = 0, open = null, bands = '';
        var trackH = lanes * LANE + (lanes - 1) * GAP, y = trackH + 3;
        ev.forEach(function (e) {
            act += e[1];
            if (act >= 2 && open === null) open = e[0];
            if (act < 2 && open !== null) {
                bands += '<rect class="overlap" x="' + x(open).toFixed(2) + '" y="' + y +
                    '" width="' + Math.max(x(e[0]) - x(open), 0.6).toFixed(2) + '" height="6"></rect>';
                open = null;
            }
        });
        var H = trackH + 9;
        return '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="width:100%;height:' + H + 'px;display:block">' + rects + bands + '</svg>';
    }

    function show(i, t0) {
        var d = data[i];
        if (!d) return;
        t0 = Math.max(0, Math.min(t0, d.fullEnd - d.win));
        d.pos = t0;
        var t1 = t0 + d.win;
        document.getElementById('reg-' + i).innerHTML = track(d.reg, d.spk, t0, t1);
        document.getElementById('exc-' + i).innerHTML = track(d.exc, d.spk, t0, t1);
        document.getElementById('wl-' + i).textContent = fmt(t0) + '–' + fmt(t1) + (t0 === d.init ? ' (busiest cross-talk)' : '');
        document.getElementById('axis-' + i).innerHTML = '<span>' + fmt(t0) + '</span><span>' + fmt((t0 + t1) / 2) + '</span><span>' + fmt(t1) + '</span>';
        var zb = document.getElementById('zb-' + i);
        zb.setAttribute('x', (t0 / d.fullEnd * W).toFixed(2));
        zb.setAttribute('width', (d.win / d.fullEnd * W).toFixed(2));
    }

    document.querySelectorAll('.density-wrap').forEach(function (el) {
        el.addEventListener('click', function (e) {
            var i = el.getAttribute('data-i'), d = data[i];
            if (!d) return;
            var r = el.getBoundingClientRect();
            show(i, (e.clientX - r.left) / r.width * d.fullEnd - d.win / 2);
        });
    });
    document.querySelectorAll('.win-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var i = btn.getAttribute('data-i'), d = data[i];
            if (!d) return;
            var nav = btn.getAttribute('data-nav');
            show(i, nav === 'prev' ? d.pos - d.win : nav === 'next' ? d.pos + d.win : d.init);
        });
    });
})();
</script>
</div>`;
}
