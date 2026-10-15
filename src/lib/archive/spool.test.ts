import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { drainSpool, spoolWrite } from './spool.js';
import { fsStore, type ArchiveStore } from './store.js';

let tmp: string;

beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-'));
    process.env.DATA_DIR = path.join(tmp, 'data');
});

afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.DATA_DIR;
});

const spoolDir = () => path.join(tmp, 'data', 'archive-spool');

describe('spool', () => {
    it('holds an entry while the store fails and delivers it once the store works', async () => {
        const key = 'eval/calls/2026/10/11/summarize/abc.jsonl.gz';
        const broken: ArchiveStore = {
            url: 'broken://',
            put: async () => { throw new Error('unreachable'); },
            get: async () => null,
            exists: async () => false,
            list: async function* () {},
        };

        await expect(drainSpool(broken)).resolves.toEqual({ sent: 0, failed: 0 });
        await spoolWrite(key, Buffer.from('payload'), 'application/gzip');
        expect(fs.statSync(path.join(spoolDir(), `${encodeURIComponent(key)}.bin`)).mode & 0o777).toBe(0o600);

        await expect(drainSpool(broken)).resolves.toEqual({ sent: 0, failed: 1 });
        expect(fs.readdirSync(spoolDir())).toHaveLength(2);

        const store = fsStore(path.join(tmp, 'archive'));
        await expect(drainSpool(store)).resolves.toEqual({ sent: 1, failed: 0 });
        expect(fs.readdirSync(spoolDir())).toEqual([]);
        expect((await store.get(key))?.toString()).toBe('payload');
    });
});

describe('drainSpool', () => {
    const store = () => fsStore(path.join(tmp, 'archive'));

    it('drops a sidecar whose body is gone instead of failing on it every time', async () => {
        await spoolWrite('a', Buffer.from('a'));
        fs.rmSync(path.join(spoolDir(), 'a.bin'));
        await expect(drainSpool(store())).resolves.toEqual({ sent: 0, failed: 0 });
        expect(fs.readdirSync(spoolDir())).toEqual([]);
    });

    it('joins a drain already under way rather than sending every entry twice', async () => {
        await spoolWrite('b', Buffer.from('b'));
        const target = store();
        let puts = 0;
        const counting: ArchiveStore = { ...target, put: async (...args) => { puts++; return target.put(...args); } };
        const [first, second] = await Promise.all([drainSpool(counting), drainSpool(counting)]);
        expect(first).toEqual({ sent: 1, failed: 0 });
        expect(second).toBe(first);
        expect(puts).toBe(1);
    });
});
