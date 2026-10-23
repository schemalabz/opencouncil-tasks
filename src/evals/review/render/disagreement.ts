import type { KindRenderer } from './kind.js';
import { esc, showValue } from './html.js';

/** Blind: the page never learns which option is the stored expectation and which the run's output. */
export const disagreement: KindRenderer = {
    choices: [
        { decision: 'a', key: 'a', label: 'A is right' },
        { decision: 'b', key: 'b', label: 'B is right' },
        { decision: 'same', key: 's', label: 'Both are right' },
        { decision: 'cant-tell', key: 't', label: "Can't tell" },
    ],
    item: item => `
        <div class="meta">${esc(item.caseId ?? '')} · <b>${esc(item.field ?? '')}</b></div>
        ${(item.options ?? []).map(o => `<div class="value-row"><span class="tag">${o.key.toUpperCase()}</span><div class="value big">${showValue(o.value)}</div></div>`).join('')}`,
    publicItem: ({ hidden: _h, current: _c, proposed: _p, ...item }) => ({ ...item, evidence: { ...item.evidence, check: undefined, signals: undefined } }),
};
