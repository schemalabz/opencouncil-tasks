import { readFileSync } from 'fs';
import { ComparisonData } from './types.js';

function asset(name: string): string {
    return readFileSync(new URL(name, import.meta.url), 'utf-8');
}

/**
 * Renders a self-contained comparison page: the static template plus the data
 * embedded as a JSON blob, rendered entirely client-side by client.js.
 *
 * Escaping `<` as `\u003c` inside the JSON makes it impossible for data to
 * break out of the script block via "</script>" (or open a "<!--" comment),
 * so this is the only escaping needed server-side; everything else is escaped
 * by client.js when building the DOM.
 */
export function renderComparisonHtml(data: ComparisonData): string {
    const json = JSON.stringify(data).replace(/</g, '\\u003c');
    // client.js is authored as an ES module so tests can import it, but is
    // inlined as a classic script so its functions are reachable from the
    // template's onclick attributes — hence the export line is dropped.
    const clientJs = asset('client.js').replace(/^export \{.*\};\s*$/m, '');
    return asset('template.html')
        .replace('__COMPARISON_DATA__', () => json)
        .replace('__CLIENT_JS__', () => clientJs);
}
