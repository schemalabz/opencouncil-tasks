export function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** A value as a reviewer reads it: strings bare, everything else as JSON. */
export function showValue(v: unknown): string {
    if (v === undefined) return '<span class="muted">(none)</span>';
    if (v === null) return '<span class="muted">null (nothing stated)</span>';
    if (typeof v === 'string') return esc(v);
    return `<pre>${esc(JSON.stringify(v, null, 2))}</pre>`;
}

/** JSON safe to embed in a <script> element. */
export function scriptJson(v: unknown): string {
    return JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
