import { describe, expect, it } from 'vitest';
import { renderComparisonHtml } from './html.js';
import { compareRuns } from './compare.js';
import { makeRun, makeSubject } from './fixtures.js';

function render(name = 'Θέμα 1', description = 'Περιγραφή θέματος.') {
    const comparison = compareRuns(
        makeRun('t1', [makeSubject({ id: 'a', name, description })]),
        makeRun('t2', [makeSubject({ id: 'b', name, description })]),
    );
    return { comparison, html: renderComparisonHtml(comparison) };
}

function embeddedData(html: string): unknown {
    const match = html.match(/<script type="application\/json" id="comparison-data">([\s\S]*?)<\/script>/);
    expect(match).not.toBeNull();
    return JSON.parse(match![1]);
}

describe('renderComparisonHtml', () => {
    it('substitutes all template placeholders', () => {
        const { html } = render();
        expect(html).not.toContain('__COMPARISON_DATA__');
        expect(html).not.toContain('__CLIENT_JS__');
        expect(html).toContain('function wordDiff');
    });

    it('strips the export statement from the inlined client script', () => {
        const { html } = render();
        expect(html).not.toMatch(/^export /m);
    });

    it('embeds the comparison data so it round-trips through JSON.parse', () => {
        const { comparison, html } = render();
        expect(embeddedData(html)).toEqual(JSON.parse(JSON.stringify(comparison)));
    });

    it('keeps script-breaking data inside the JSON blob', () => {
        const evil = 'Θέμα </script><script>alert(1)</script>';
        const { comparison, html } = render(evil, 'Περιγραφή <!-- σχόλιο --> κειμένου');
        // raw script tags appear only where the template opens/closes its own blocks
        expect(html).not.toContain('<script>alert');
        expect(html.match(/<\/script>/g)).toHaveLength(2);
        expect(embeddedData(html)).toEqual(JSON.parse(JSON.stringify(comparison)));
    });
});
