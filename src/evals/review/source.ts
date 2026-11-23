import { archiveKeys, type ArchiveStore } from '../../lib/archive/store.js';
import type { CallRequest, CallResponse } from '../../lib/llm/callRecord.js';
import { expandRequest, findCall } from '../../lib/runs/call.js';
import { readArchivedRun } from '../../lib/telemetry/archiveSink.js';
import type { ReviewItem } from './batch.js';

export type ItemSource =
    | { type: 'pdf'; body: Buffer }
    | { type: 'call'; call: { label?: string; request: CallRequest; response?: CallResponse } };

/**
 * What a reviewer reads next to an item: the archived document when the item has one,
 * else the call (prompts inlined) that produced the value. `blind` leaves out the call's
 * response, which holds one of the values the reviewer chooses between. `runs` is the archive
 * that holds the items' runs, when the batch was built from another one than it is saved in.
 */
export async function itemSource(store: ArchiveStore, item: ReviewItem, opts: { blind?: boolean; runs?: ArchiveStore } = {}): Promise<ItemSource | null> {
    const ev = item.evidence;
    if (ev.pdf?.sha256) {
        const body = await store.get(archiveKeys.blob(ev.pdf.sha256));
        if (body) return { type: 'pdf', body };
    }
    if (!ev.traceId) return null;
    const runs = opts.runs ?? store;
    const run = await readArchivedRun(ev.traceId, runs);
    if (!run || run.calls.length === 0) return null;
    const call = ev.callId ? findCall(run, ev.callId) : run.calls[0];
    return { type: 'call', call: { label: call.label, request: await expandRequest(call.request, runs), ...(!opts.blind && { response: call.response }) } };
}
