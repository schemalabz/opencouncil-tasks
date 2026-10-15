import type { KindRenderer } from './kind.js';
import { esc } from './html.js';

/** The detector's evidence is the response's opening, so the opening is what gets highlighted. */
function highlighted(text: string, evidence?: string): string {
    if (!evidence) return esc(text);
    const head = evidence.slice(0, Math.min(evidence.length, 60));
    const at = text.indexOf(head);
    if (at === -1) return esc(text);
    return `${esc(text.slice(0, at))}<mark>${esc(text.slice(at, at + evidence.length))}</mark>${esc(text.slice(at + evidence.length))}`;
}

export const modeExamples: KindRenderer = {
    choices: [
        { decision: 'confirm', key: 'y', label: 'Yes, an occurrence' },
        { decision: 'reject', key: 'n', label: 'Not this mode' },
        { decision: 'cant-tell', key: 't', label: "Can't tell" },
    ],
    header: (_batch, ctx) => ctx.mode ? `
        <section class="mode">
          <h2>${esc(ctx.mode.id)} · ${esc(ctx.mode.title)}</h2>
          <p><b>Is:</b> ${esc(ctx.mode.definition)}</p>
          ${ctx.mode.boundary ? `<p><b>Is not:</b> ${esc(ctx.mode.boundary)}</p>` : ''}
        </section>` : '',
    item: item => `
        <div class="meta">${esc(item.evidence.label ?? '')} · <span class="mono">${esc(item.evidence.traceId ?? '')}</span></div>
        <div class="text">${highlighted(item.evidence.text ?? '', item.evidence.check)}</div>`,
};
