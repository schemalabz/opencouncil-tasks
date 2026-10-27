import fs from 'fs';
import path from 'path';
import { ensureDataSubdir, getDataDir } from '../dataDir.js';
import type { ArchiveStore } from './store.js';

const SUBDIR = 'archive-spool';

type SpoolEntry = { key: string; contentType?: string; savedAt: string };

/** Holds an archive write locally until `drainSpool` can deliver it. */
export async function spoolWrite(key: string, body: Buffer, contentType?: string): Promise<void> {
    const base = path.join(ensureDataSubdir(SUBDIR), encodeURIComponent(key));
    const entry: SpoolEntry = { key, contentType, savedAt: new Date().toISOString() };
    // The sidecar is written last: draining keys off sidecars, so a crash mid-write
    // can never send a truncated body.
    await fs.promises.writeFile(`${base}.bin`, body, { mode: 0o600 });
    await fs.promises.writeFile(`${base}.json`, JSON.stringify(entry), { mode: 0o600 });
}

let draining: Promise<{ sent: number; failed: number }> | null = null;

/** Resends spooled writes. A drain already under way is joined: two at once would send every entry twice. */
export function drainSpool(store: ArchiveStore): Promise<{ sent: number; failed: number }> {
    draining ??= drain(store).finally(() => { draining = null; });
    return draining;
}

async function drain(store: ArchiveStore): Promise<{ sent: number; failed: number }> {
    const dir = path.join(getDataDir(), SUBDIR);
    if (!fs.existsSync(dir)) return { sent: 0, failed: 0 };

    let sent = 0;
    let failed = 0;
    for (const sidecar of (await fs.promises.readdir(dir)).filter(f => f.endsWith('.json')).sort()) {
        const base = path.join(dir, sidecar.slice(0, -'.json'.length));
        try {
            const entry = JSON.parse(await fs.promises.readFile(`${base}.json`, 'utf8')) as SpoolEntry;
            let body: Buffer;
            try {
                body = await fs.promises.readFile(`${base}.bin`);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                // Its body is gone (an older drain removed it first and stopped there): nothing left to send.
                console.warn(`Archive spool: ${sidecar} has no body; dropping it`);
                await fs.promises.rm(`${base}.json`, { force: true });
                continue;
            }
            await store.put(entry.key, body, entry.contentType);
            // The sidecar goes first: a body left without one is never sent, a sidecar without its body would fail every drain.
            await fs.promises.rm(`${base}.json`, { force: true });
            await fs.promises.rm(`${base}.bin`, { force: true });
            sent++;
        } catch (error) {
            console.warn(`Archive spool: could not deliver ${sidecar}:`, error instanceof Error ? error.message : error);
            failed++;
        }
    }
    return { sent, failed };
}
