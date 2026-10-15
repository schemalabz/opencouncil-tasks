import vm from 'vm';
import { describe, expect, it } from 'vitest';
import type { ReviewBatch, ReviewItem } from '../batch.js';
import { renderPage } from './page.js';

/** Just enough DOM for the page's client script: elements hold text, children and listeners. */
class FakeEl {
    children: FakeEl[] = [];
    listeners: Record<string, Array<(e: unknown) => void>> = {};
    hidden = false; value = ''; disabled = false; className = ''; title = ''; src = ''; href = ''; target = ''; rel = '';
    dataset: Record<string, string> = {};
    classList = { add() {}, remove() {}, toggle() {} };
    private own = '';
    constructor(readonly tag: string, private readonly sel: Record<string, FakeEl | FakeEl[] | null> = {}) {}
    get textContent(): string { return this.own + this.children.map(c => c.textContent).join('\n'); }
    set textContent(t: string) { this.own = t ?? ''; this.children = []; }
    appendChild(c: FakeEl) { if (c.tag === '#fragment') this.children.push(...c.children); else this.children.push(c); return c; }
    addEventListener(type: string, fn: (e: unknown) => void) { (this.listeners[type] ??= []).push(fn); }
    querySelector(s: string) { return this.sel[s] ?? null; }
    querySelectorAll(s: string) { return this.sel[s] ?? []; }
    scrollIntoView() {} focus() {} blur() {} click() {} remove() {}
}

type Pending = { resolve: (r: unknown) => void; reject: (e: unknown) => void };

/** Runs the page's script served (http:), with each source request held until the test settles it. */
function servePage(batch: ReviewBatch) {
    const html = renderPage(batch);
    const script = /<script>([\s\S]*)<\/script>/.exec(html)![1];
    const data = /<script type="application\/json" id="review-data">([\s\S]*?)<\/script>/.exec(html)![1];
    const cards = batch.items.map(i => {
        const card = new FakeEl('article', { '.note': new FakeEl('input'), '.badge': new FakeEl('span'), '.choices button': [] });
        card.dataset.item = i.id;
        return card;
    });
    const source = new FakeEl('aside');
    const els: Record<string, unknown> = {
        'review-data': { textContent: data }, source,
        reviewer: new FakeEl('input'), submit: new FakeEl('button'), message: new FakeEl('div'), progress: new FakeEl('span'), download: new FakeEl('button'),
    };
    const requests = new Map<string, Pending>();
    const document = {
        getElementById: (id: string) => els[id], querySelectorAll: (s: string) => (s === '.item' ? cards : []),
        createElement: (tag: string) => new FakeEl(tag), createDocumentFragment: () => new FakeEl('#fragment'),
        addEventListener() {}, body: new FakeEl('body'),
    };
    const fetch = (url: string) => new Promise((resolve, reject) => requests.set(decodeURIComponent(url.split('/')[3]), { resolve, reject }));
    vm.runInNewContext(script, {
        document, fetch, location: { protocol: 'http:' }, localStorage: { getItem: () => null, setItem() {} },
        URL: { createObjectURL: () => 'blob:x' }, Blob,
    });
    const settle = () => new Promise(r => setTimeout(r, 0));
    return {
        source,
        select: (index: number) => cards[index].listeners.click[0]({ target: { closest: () => null } }),
        answer: async (itemId: string, call: unknown) => {
            requests.get(itemId)!.resolve({ ok: true, headers: { get: () => 'application/json' }, json: async () => call });
            await settle();
        },
        fail: async (itemId: string, why: string) => {
            requests.get(itemId)!.resolve({ ok: false, statusText: 'error', text: async () => why });
            await settle();
        },
    };
}

const item = (id: string): ReviewItem => ({ id, caseId: `demo/${id}`, field: 'date', evidence: { traceId: `trace-${id}` } });
const batch = (items: ReviewItem[], kind: ReviewBatch['kind'] = 'label-confirm'): ReviewBatch => ({
    id: 'rv-test', kind, suite: 'demo', createdBy: 't', createdAt: 't', status: 'open', items, history: [],
});
const call = (prompt: string) => ({ label: 'reading', request: { model: 'claude-model-x', max_tokens: 1, messages: [{ role: 'user', content: prompt }] } });

describe('the source panel', () => {
    it('keeps the selected item when an earlier item answers late', async () => {
        const page = servePage(batch([item('A'), item('B')]));
        page.select(1);
        await page.answer('B', call('prompt of B'));
        await page.answer('A', call('prompt of A'));
        expect(page.source.textContent).toContain('prompt of B');
        expect(page.source.textContent).not.toContain('prompt of A');
    });

    it("keeps the selected item when an earlier item's request fails late", async () => {
        const page = servePage(batch([item('A'), item('B')]));
        page.select(1);
        await page.answer('B', call('prompt of B'));
        await page.fail('A', 'archive unreachable');
        expect(page.source.textContent).toContain('prompt of B');
        expect(page.source.textContent).not.toContain('archive unreachable');
    });
});

describe('the source heading', () => {
    it('names the recorded call\'s model only where the page is not blind', async () => {
        const labelled = servePage(batch([item('A')]));
        await labelled.answer('A', call('prompt'));
        expect(labelled.source.children[0].textContent).toBe('reading · claude-model-x');

        for (const kind of ['pairwise', 'disagreement'] as const) {
            const blind = servePage(batch([{ ...item('A'), options: [{ key: 'a', value: 'one' }, { key: 'b', value: 'two' }] }], kind));
            await blind.answer('A', call('prompt'));
            expect(blind.source.children[0].textContent).toBe('What the model was given · reading');
            expect(blind.source.textContent).not.toContain('claude-model-x');
        }
    });
});
