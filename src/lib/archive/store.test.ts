import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { archiveKeys, fsStore, openArchive, s3Store, type ArchiveStore, type S3Like } from './store.js';

async function collect(iter: AsyncIterable<string>): Promise<string[]> {
    const out: string[] = [];
    for await (const key of iter) out.push(key);
    return out;
}

/** In-memory S3 that pages listings two keys at a time. */
function fakeS3(): S3Like & { objects: Map<string, { body: Buffer; contentType?: string; acl?: string }> } {
    const objects = new Map<string, { body: Buffer; contentType?: string; acl?: string }>();
    const missing = () => Object.assign(new Error('missing'), { code: 'NoSuchKey', statusCode: 404 });
    const reply = <T>(fn: () => T) => ({ promise: async () => fn() });
    return {
        objects,
        putObject: (p) => reply(() => {
            objects.set(p.Key, { body: Buffer.from(p.Body as Buffer | string), contentType: p.ContentType, acl: p.ACL });
            return {};
        }),
        getObject: (p) => reply(() => {
            const o = objects.get(p.Key);
            if (!o) throw missing();
            return { Body: o.body };
        }),
        headObject: (p) => reply(() => {
            const o = objects.get(p.Key);
            if (!o) throw Object.assign(new Error('missing'), { code: 'NotFound', statusCode: 404 });
            return { ContentLength: o.body.length };
        }),
        listObjectsV2: (p) => reply(() => {
            const keys = [...objects.keys()].filter(k => k.startsWith(p.Prefix ?? '')).sort();
            const start = p.ContinuationToken ? Number(p.ContinuationToken) : 0;
            const page = keys.slice(start, start + 2);
            const next = start + 2 < keys.length ? String(start + 2) : undefined;
            return { Contents: page.map(Key => ({ Key })), IsTruncated: next !== undefined, NextContinuationToken: next };
        }),
    };
}

function contract(name: string, make: () => ArchiveStore) {
    describe(name, () => {
        let store: ArchiveStore;
        beforeEach(() => { store = make(); });

        it('round-trips strings and buffers', async () => {
            await store.put('a/b/one.txt', 'hello', 'text/plain');
            await store.put('a/two.bin', Buffer.from([0, 1, 2, 255]));

            expect((await store.get('a/b/one.txt'))?.toString()).toBe('hello');
            expect(await store.get('a/two.bin')).toEqual(Buffer.from([0, 1, 2, 255]));
            expect(await store.exists('a/b/one.txt')).toBe(true);
        });

        it('reports an absent key as null / false', async () => {
            expect(await store.get('nope/missing.json')).toBeNull();
            expect(await store.exists('nope/missing.json')).toBe(false);
        });

        it('lists keys under a prefix, sorted, excluding others', async () => {
            for (const key of ['runs/s/2/x', 'runs/s/1/b', 'runs/s/1/a', 'runs/t/1/a', 'other/z', 'runs/sx/1']) {
                await store.put(key, key);
            }
            expect(await collect(store.list('runs/s/'))).toEqual(['runs/s/1/a', 'runs/s/1/b', 'runs/s/2/x']);
            expect(await collect(store.list('runs/s'))).toEqual(['runs/s/1/a', 'runs/s/1/b', 'runs/s/2/x', 'runs/sx/1']);
            expect(await collect(store.list('absent/'))).toEqual([]);
        });
    });
}

describe('fsStore', () => {
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-')); });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    contract('contract', () => fsStore(dir));

    it('leaves no temp files behind', async () => {
        const store = fsStore(dir);
        await store.put('x/y/z.json', '{}');
        await store.put('x/y/z.json', '{"again":true}');
        const all = fs.readdirSync(dir, { recursive: true }).map(String);
        expect(all.filter(f => f.includes('.tmp-'))).toEqual([]);
        expect(fs.readFileSync(path.join(dir, 'x/y/z.json'), 'utf8')).toBe('{"again":true}');
    });
});

describe('s3Store', () => {
    contract('contract', () => s3Store('bucket', fakeS3()));

    it('writes private objects with the given content type', async () => {
        const s3 = fakeS3();
        await s3Store('bucket', s3).put('k', 'v', 'application/json');
        expect(s3.objects.get('k')).toMatchObject({ contentType: 'application/json', acl: undefined });
    });
});

describe('openArchive', () => {
    it('opens file:// and s3:// urls, caching per url', () => {
        const a = openArchive('file:///tmp/archive-test');
        expect(a.url).toBe('file:///tmp/archive-test');
        expect(openArchive('file:///tmp/archive-test')).toBe(a);
        expect(openArchive('s3://some-bucket').url).toBe('s3://some-bucket');
    });

    it('rejects other schemes, and a key prefix after the bucket', () => {
        expect(() => openArchive('http://example.com')).toThrow();
        expect(() => openArchive('s3://media-bucket/archive')).toThrow(/no key prefix/);
    });
});

describe('archiveKeys', () => {
    const date = new Date('2026-03-04T23:30:00Z');
    const trace = 'ab'.repeat(16);

    it('builds date-partitioned keys from UTC date parts', () => {
        expect(archiveKeys.calls('eval', date, 'summarize', trace)).toBe(`eval/calls/2026/03/04/summarize/${trace}.jsonl.gz`);
        expect(archiveKeys.checks('production', date, trace)).toBe(`production/checks/2026/03/04/${trace}.jsonl`);
    });

    it('shards content-addressed keys by their first two chars', () => {
        expect(archiveKeys.response('f00dcafe', '2026-10-11T01:02:03.456Z', 'c1')).toBe('responses/f0/f00dcafe/2026-10-11T01-02-03-456Z_c1.json');
        expect(archiveKeys.blob('deadbeef')).toBe('blobs/sha256/de/deadbeef');
        expect(archiveKeys.blobByUrl('c0ffee')).toBe('blobs/by-url/c0/c0ffee');
    });
});
