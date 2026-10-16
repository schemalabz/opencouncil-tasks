import type Anthropic from '@anthropic-ai/sdk';
import type { CallRecord } from './callRecord.js';

/**
 * The recorded responses of one run, served back by request identity in the order
 * they were recorded, so a run that made the same request twice replays both
 * answers rather than one of them twice.
 */
export type Cassette = { take(cacheKey: string): Anthropic.Messages.Message | undefined; remaining(): number };

export function messageFromRecord(record: CallRecord): Anthropic.Messages.Message | undefined {
    const r = record.response;
    if (!r?.content || record.importedFrom) return undefined;
    return {
        id: `replay_${record.callId}`,
        type: 'message',
        role: 'assistant',
        model: r.servedModel,
        content: r.content as Anthropic.Messages.ContentBlock[],
        stop_reason: r.stopReason as Anthropic.Messages.StopReason,
        stop_sequence: null,
        usage: r.usage as unknown as Anthropic.Messages.Usage,
    } as Anthropic.Messages.Message;
}

export function cassetteFromCalls(records: CallRecord[]): Cassette {
    const queues = new Map<string, Anthropic.Messages.Message[]>();
    for (const record of records) {
        const message = messageFromRecord(record);
        if (!message) continue;
        const queue = queues.get(record.cacheKey) ?? [];
        queue.push(message);
        queues.set(record.cacheKey, queue);
    }
    return {
        take: key => queues.get(key)?.shift(),
        remaining: () => [...queues.values()].reduce((n, q) => n + q.length, 0),
    };
}
