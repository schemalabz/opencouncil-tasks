import type { KindRenderer } from './kind.js';
import { esc, showValue } from './html.js';

export const labelConfirm: KindRenderer = {
    choices: [
        { decision: 'confirm', key: 'c', label: 'Confirm' },
        { decision: 'correct', key: 'x', label: 'Correct…', needsValue: true },
        { decision: 'cant-tell', key: 't', label: "Can't tell" },
    ],
    item: item => `
        <div class="meta">${esc(item.caseId ?? '')} · <b>${esc(item.field ?? '')}</b></div>
        <div class="value-row"><span class="tag">proposed</span><div class="value big">${showValue(item.proposed)}</div></div>
        <div class="value-row"><span class="tag">now</span><div class="value">${item.current ? `${showValue(item.current.value)} <span class="muted">(${esc(item.current.tier)}, ${esc(item.current.source)})</span>` : '<span class="muted">no expectation yet</span>'}</div></div>
        ${item.evidence.check ? `<div class="muted small">signal: ${esc(item.evidence.check)}</div>` : ''}`,
};
