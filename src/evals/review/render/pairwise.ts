import type { ReviewItem } from '../batch.js';
import type { KindRenderer } from './kind.js';
import { esc } from './html.js';

const side = (key: string, body: string) => `<div class="cell" data-side="${key}"><div class="prose">${body}</div></div>`;

/** The parts that differ, lined up row by row, then the parts both runs share, closed. */
function compared(item: ReviewItem): string {
    const { parts, shared } = item.compare!;
    const rows = parts.map(p => `
        ${parts.length > 1 ? `<div class="part-title">${esc(p.title)}</div>` : ''}
        ${side('a', esc(p.a) || '<span class="muted">(nothing)</span>')}${side('b', esc(p.b) || '<span class="muted">(nothing)</span>')}`).join('');
    const same = shared.length ? `
        <details class="shared">
          <summary>The same in both (${shared.length}): ${esc(shared.map(s => s.title).join(' · '))}</summary>
          ${shared.map(s => `<div class="part-title">${esc(s.title)}</div><div class="prose">${esc(s.text)}</div>`).join('')}
        </details>` : '';
    const differs = parts.length === 1 && shared.length ? `<span class="differs">${esc(parts[0].title)}</span>` : '';
    return `<div class="cmp"><div class="side-head" data-side="a">A ${differs}</div><div class="side-head" data-side="b">B ${differs}</div>${rows}</div>${same}`;
}

/** Blind: the page never learns which run produced which option. */
export const pairwise: KindRenderer = {
    choices: [
        { decision: 'a', key: 'a', label: 'A is better' },
        { decision: 'b', key: 'b', label: 'B is better' },
        { decision: 'same', key: 's', label: 'About the same' },
        { decision: 'cant-tell', key: 't', label: "Can't tell" },
    ],
    reasons: [
        { key: '1', id: 'complete', label: 'more complete' },
        { key: '2', id: 'accurate', label: 'more accurate' },
        { key: '3', id: 'neutral', label: 'more neutral' },
        { key: '4', id: 'clear', label: 'clearer' },
    ],
    wide: true,
    // Which two variants, never which side is which: the a/b mapping is per item and stays off the page.
    header: batch => !batch.runs ? ''
        : batch.runs.baseline.variant !== batch.runs.candidate.variant
            ? `<div class="mode small">Comparing: <b>${esc(batch.runs.baseline.variant)}</b> vs <b>${esc(batch.runs.candidate.variant)}</b> · sides hidden and shuffled per item</div>`
            : `<div class="mode small">Comparing two runs of <b>${esc(batch.runs.baseline.variant)}</b> (a change in the code or the prompt) · sides hidden and shuffled per item</div>`,
    item: item => `
        <div class="meta">${esc(item.caseId ?? '')} · <b>${esc(item.evidence.text ?? item.field ?? '')}</b></div>
        ${item.compare
            ? compared(item)
            : `<div class="cmp"><div class="side-head" data-side="a">A</div><div class="side-head" data-side="b">B</div>${(item.options ?? []).map(o => side(o.key, esc(String(o.value ?? '')))).join('')}</div>`}`,
    publicItem: ({ sides: _s, current: _c, proposed: _p, repeatOf: _r, ...item }) => ({ ...item, evidence: { ...item.evidence, check: undefined, signals: undefined } }),
};
