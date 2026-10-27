import { archiveKeys, type ArchiveStore } from '../archive/store.js';
import type { CallRecord, CallRequest } from '../llm/callRecord.js';
import type { ArchivedRun } from '../telemetry/archiveSink.js';

/** A call by id, by position (`#3`, from 1), or by label (the first call with it). */
export function findCall(archived: ArchivedRun, selector: string): CallRecord {
    const calls = archived.calls;
    const index = /^#(\d+)$/.exec(selector);
    const call = index ? calls[Number(index[1]) - 1] : calls.find(c => c.callId === selector) ?? calls.find(c => c.label === selector);
    if (!call) throw new Error(`No call ${selector} in run ${archived.run.traceId} (labels: ${[...new Set(calls.map(c => c.label))].join(', ')})`);
    return call;
}

/** Inlines the system prompt and output schema a request stores by hash; documents stay as references. */
export async function expandRequest(request: CallRequest, store: ArchiveStore): Promise<CallRequest> {
    const blob = async (hash: string) => (await store.get(archiveKeys.blob(hash)))?.toString('utf8') ?? `<missing blob ${hash}>`;
    const out: CallRequest = { ...request };
    if (request.system?.hash) out.system = { text: await blob(request.system.hash) } as unknown as CallRequest['system'];
    const format = (request.output_config as { format?: { schema?: { hash?: string } } } | undefined)?.format;
    if (format?.schema?.hash) {
        out.output_config = { ...request.output_config as object, format: { ...format, schema: JSON.parse(await blob(format.schema.hash)) } };
    }
    return out;
}
