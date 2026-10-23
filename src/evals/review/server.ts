import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ArchiveStore } from '../../lib/archive/store.js';
import { loadBatch, loadPage, submitResults, type ReviewBatch } from './batch.js';
import { isBlind } from './render/page.js';
import { itemSource } from './source.js';

const MAX_RESULTS_BYTES = 5 * 1024 * 1024;

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => {
            size += c.length;
            if (size > MAX_RESULTS_BYTES) { reject(new Error('results too large')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function send(res: http.ServerResponse, status: number, body: string | Buffer, type: string): void {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(body);
}

const json = (res: http.ServerResponse, status: number, body: unknown) => send(res, status, JSON.stringify(body), 'application/json');

export type ReviewServer = { url: string; close(): Promise<void> };

/**
 * Serves one batch's page on loopback, its items' archived sources, and takes the
 * results. Only loopback, since the sources are private archive content.
 */
export async function serveBatch(store: ArchiveStore, batchId: string, opts: { port?: number; onSubmit?: (b: ReviewBatch) => void } = {}): Promise<ReviewServer> {
    const page = await loadPage(store, batchId);
    if (!page) throw new Error(`Batch ${batchId} has no page in ${store.url}`);
    await loadBatch(store, batchId);

    const server = http.createServer(async (req, res) => {
        try {
            // A DNS-rebinding page reaches loopback under its own host name; only our own is served.
            const { port } = server.address() as AddressInfo;
            if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) return send(res, 421, 'wrong host', 'text/plain');
            const url = new URL(req.url ?? '/', 'http://127.0.0.1');
            if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return send(res, 200, page, 'text/html; charset=utf-8');

            const source = /^\/api\/items\/([^/]+)\/source$/.exec(url.pathname);
            if (req.method === 'GET' && source) {
                const batch = await loadBatch(store, batchId);
                const item = batch.items.find(i => i.id === decodeURIComponent(source[1]));
                if (!item) return send(res, 404, 'no such item', 'text/plain');
                const found = await itemSource(store, item, { blind: isBlind(batch.kind) });
                if (!found) return send(res, 404, 'no archived source for this item', 'text/plain');
                return found.type === 'pdf' ? send(res, 200, found.body, 'application/pdf') : json(res, 200, found.call);
            }

            if (req.method === 'POST' && url.pathname === '/api/results') {
                // JSON forces a CORS preflight that a page from another origin cannot pass, and a
                // browser always names the origin of a cross-site POST, so both keep other local
                // pages from submitting on the reviewer's behalf.
                if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 415, { ok: false, error: 'results must be sent as application/json' });
                const origin = req.headers.origin;
                if (origin && origin !== `http://${req.headers.host}`) return json(res, 403, { ok: false, error: `results from ${origin} are not accepted` });
                const batch = await loadBatch(store, batchId);
                let raw: unknown;
                try { raw = JSON.parse(await readBody(req)); } catch (e) { return json(res, 400, { ok: false, error: `not JSON: ${(e as Error).message}` }); }
                try {
                    const next = await submitResults(store, batch, raw);
                    json(res, 200, { ok: true, status: next.status });
                    opts.onSubmit?.(next);
                } catch (e) {
                    json(res, 422, { ok: false, error: (e as Error).message });
                }
                return;
            }
            send(res, 404, 'not found', 'text/plain');
        } catch (e) {
            send(res, 500, (e as Error).message, 'text/plain');
        }
    });

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(opts.port ?? 0, '127.0.0.1', () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise<void>(resolve => server.close(() => resolve())),
    };
}
