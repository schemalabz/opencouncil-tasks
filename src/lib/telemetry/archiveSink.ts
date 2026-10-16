import { promisify } from 'node:util';
import { gunzipSync, gzip, gzipSync } from 'node:zlib';
import { archiveKeys, configuredArchive, openArchive, type ArchiveStore } from '../archive/store.js';
import { drainSpool, spoolWrite } from '../archive/spool.js';
import type { CallBlob, CallRecord } from '../llm/callRecord.js';
import { envFromProcess, type RunInfo, type RunState } from './context.js';
import type { RunOutcome, TelemetrySink } from './sink.js';
import { registerSinkFactory } from './telemetry.js';

/** Results above this are left out of the run file; the task's own callback still carries them. */
const MAX_ARCHIVED_RESULT_BYTES = 20 * 1024 * 1024;

export type ArchivedRunLine = { type: 'run'; run: RunInfo; outcome: Omit<RunOutcome, 'result'>; phases: RunState['phases'] };
export type ArchivedLine = ArchivedRunLine | ({ type: 'call' } & CallRecord) | { type: 'result'; result: unknown };

const gzipAsync = promisify(gzip);

function runFileBody(state: RunState, outcome: RunOutcome): string {
    const { result, ...outcomeWithoutResult } = outcome;
    const lines: ArchivedLine[] = [
        { type: 'run', run: state.run, outcome: outcomeWithoutResult, phases: state.phases },
        ...state.calls.map(call => ({ type: 'call' as const, ...call })),
    ];
    const resultJson = result === undefined ? undefined : JSON.stringify({ type: 'result', result });
    return lines.map(l => JSON.stringify(l)).join('\n')
        + (resultJson && Buffer.byteLength(resultJson) <= MAX_ARCHIVED_RESULT_BYTES ? `\n${resultJson}` : '') + '\n';
}

export function encodeRunFile(state: RunState, outcome: RunOutcome): Buffer {
    return gzipSync(runFileBody(state, outcome));
}

/** The two objects that make a run findable, in the order they must land: its run file, then the trace-id index pointing at it. */
// Compressed off the event loop: a large summarize run would otherwise stall every other task's streams.
export async function runFileWrites(state: RunState, outcome: RunOutcome): Promise<Array<{ key: string; body: Buffer; contentType: string }>> {
    const key = archiveKeys.calls(state.run.env, new Date(state.run.startedAt), state.run.taskType, state.run.traceId);
    return [
        { key, body: await gzipAsync(runFileBody(state, outcome)), contentType: 'application/gzip' },
        { key: archiveKeys.traceIndex(state.run.traceId), body: Buffer.from(key), contentType: 'text/plain' },
    ];
}

export type ArchivedRun = { run: RunInfo; outcome: Omit<RunOutcome, 'result'>; phases: RunState['phases']; calls: CallRecord[]; result?: unknown; key: string };

export function decodeRunFile(body: Buffer, key = ''): ArchivedRun {
    const lines = gunzipSync(body).toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as ArchivedLine);
    const head = lines.find((l): l is ArchivedRunLine => l.type === 'run');
    if (!head) throw new Error(`Archived run file ${key} has no run line`);
    const calls = lines.filter((l): l is { type: 'call' } & CallRecord => l.type === 'call').map(({ type: _type, ...call }) => call as CallRecord);
    const result = lines.find((l): l is { type: 'result'; result: unknown } => l.type === 'result')?.result;
    return { run: head.run, outcome: head.outcome, phases: head.phases, calls, result, key };
}

/** Finds a run by trace id through the index the sink writes. */
export async function readArchivedRun(traceId: string, store: ArchiveStore = openArchive()): Promise<ArchivedRun | null> {
    const index = await store.get(archiveKeys.traceIndex(traceId));
    if (!index) return null;
    const key = index.toString('utf8').trim();
    const body = await store.get(key);
    return body ? decodeRunFile(body, key) : null;
}

/**
 * Writes each run's call records (one gzipped JSONL file per run), the blobs they
 * reference, and a trace-id index. Never throws into a task: failed writes are
 * spooled locally and resent on the next flush.
 */
export function createArchiveSink(store: ArchiveStore = openArchive()): TelemetrySink {
    const pending = new Set<Promise<unknown>>();
    const knownBlobs = new Set<string>();
    const adhoc: CallRecord[] = [];

    const track = (p: Promise<unknown>) => {
        pending.add(p);
        void p.finally(() => pending.delete(p));
    };

    /** Resolves true once the body is in the store or the spool; never rejects. */
    const put = (key: string, body: Buffer, contentType?: string): Promise<boolean> => store.put(key, body, contentType)
        .then(() => true, e => {
            console.error(`Archive write failed for ${key}; spooling:`, e instanceof Error ? e.message : e);
            return spoolWrite(key, body, contentType).then(() => true);
        })
        // An unhandled rejection would take the whole server down with it.
        .catch(e => { console.error(`Archive spool failed for ${key}; dropping it:`, e instanceof Error ? e.message : e); return false; });

    const write = (key: string, body: Buffer, contentType?: string) => track(put(key, body, contentType));

    const writeBlob = (blob: CallBlob) => {
        if (knownBlobs.has(blob.sha256)) return;
        knownBlobs.add(blob.sha256);
        const key = archiveKeys.blob(blob.sha256);
        track(store.exists(key)
            .then(exists => { if (!exists) write(key, blob.data, blob.mediaType); })
            .catch(() => write(key, blob.data, blob.mediaType)));
    };

    return {
        name: 'archive',
        onCall(run, call, extras) {
            for (const blob of extras.blobs ?? []) writeBlob(blob);
            if (!run) adhoc.push(call);
        },
        async onRunEnd(state, outcome) {
            // Each only once the one before has landed: an index naming a dropped run file would make the run unfindable for good.
            const writes = await runFileWrites(state, outcome);
            track(writes.reduce<Promise<boolean>>((prev, w) => prev.then(ok => ok && put(w.key, w.body, w.contentType)), Promise.resolve(true)));
        },
        async flush() {
            if (adhoc.length) {
                const calls = adhoc.splice(0);
                const env = envFromProcess();
                const day = new Date();
                const name = `adhoc-${day.toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
                const body = await gzipAsync(calls.map(c => JSON.stringify({ type: 'call', ...c })).join('\n') + '\n');
                write(archiveKeys.calls(env, day, 'adhoc', name), body, 'application/gzip');
            }
            // Only what is pending now: other tasks keep adding writes, and chasing them would hold
            // this run's callback for the whole flush ceiling.
            await Promise.allSettled([...pending]);
            await drainSpool(store).catch(e => console.error('Archive spool drain failed:', e instanceof Error ? e.message : e));
        },
    };
}

registerSinkFactory('archive', () => {
    const store = configuredArchive();
    return store ? createArchiveSink(store) : null;
});
