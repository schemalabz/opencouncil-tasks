import type { KindRenderer } from './kind.js';
import { esc } from './html.js';

/** Blind: the page never learns which run produced which option. */
export const pairwise: KindRenderer = {
    choices: [
        { decision: 'a', key: 'a', label: 'A is better' },
        { decision: 'b', key: 'b', label: 'B is better' },
        { decision: 'same', key: 's', label: 'About the same' },
        { decision: 'cant-tell', key: 't', label: "Can't tell" },
    ],
    // Which two variants, never which side is which: the a/b mapping is per item and stays off the page.
    header: batch => batch.runs
        ? `<div class="mode small">Comparing: <b>${esc(batch.runs.baseline.variant)}</b> vs <b>${esc(batch.runs.candidate.variant)}</b> · sides hidden and shuffled per item</div>`
        : '',
    item: item => `
        <div class="meta">${esc(item.caseId ?? '')} · <b>${esc(item.evidence.text ?? item.field ?? '')}</b></div>
        ${(item.options ?? []).map(o => `<div class="value-row"><span class="tag">${o.key.toUpperCase()}</span><div class="text">${esc(String(o.value ?? ''))}</div></div>`).join('')}`,
    publicItem: ({ sides: _s, current: _c, proposed: _p, ...item }) => ({ ...item, evidence: { ...item.evidence, check: undefined, signals: undefined } }),
};
