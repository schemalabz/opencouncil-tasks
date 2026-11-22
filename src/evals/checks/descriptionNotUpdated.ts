import type { CallRecord } from '../../lib/llm/callRecord.js';
import { callCheck, fail, pass, responseJson, unknown } from './check.js';

export type DiscussedSubject = {
    id: string;
    name: string;
    /** Utterances this batch tagged to the subject as its discussion. */
    utterances: number;
    /** Characters of that speech. */
    chars: number;
    speakers: string[];
    /** The batch returned the subject. */
    returned: boolean;
    /** The batch returned it with a description whose words differ from the one it was given. */
    updated: boolean;
};

/** Speech below this is a remark, a point of order or a hand-over, which a description need not carry. */
export const SUBSTANTIAL_CHARS = 500;

type Segment = { speakerName?: string | null; utterances?: Array<{ utteranceId?: string; id?: string; text?: string }> };
type ListedSubject = { id?: unknown; name?: unknown; description?: unknown };

/** The prompt holds its transcript and its subject list as pretty-printed JSON arrays. */
function promptArrays(text: string): unknown[][] {
    const arrays: unknown[][] = [];
    for (const m of text.matchAll(/^\[$/gm)) {
        const end = text.indexOf('\n]', m.index);
        if (end < 0) continue;
        try {
            const value = JSON.parse(text.slice(m.index, end + 2));
            if (Array.isArray(value)) arrays.push(value);
        } catch { /* not a JSON array */ }
    }
    return arrays;
}

const userText = (call: CallRecord): string => (call.request.messages ?? [])
    .filter(m => m.role === 'user')
    .map(m => (typeof m.content === 'string' ? m.content : (m.content as Array<{ text?: string }>).map(p => p.text ?? '').join('')))
    .join('\n');

/** References are rewritten between batches, so only the words are compared. */
const words = (markdown: unknown) => (typeof markdown === 'string' ? markdown : '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();

/**
 * The subjects a batch was given and tagged speech to. One that is not `updated` keeps the
 * description it had: returned unchanged, or not returned, and then the task keeps the old one. `null` when
 * the call is not a readable batch: no transcript or subject list in the prompt, or no statuses
 * in the response.
 */
export function discussedSubjects(call: CallRecord): DiscussedSubject[] | null {
    const arrays = promptArrays(userText(call));
    const transcript = arrays.find(a => a.some(x => Array.isArray((x as Segment)?.utterances))) as Segment[] | undefined;
    const response = responseJson(call) as { subjects?: ListedSubject[]; utteranceStatuses?: Array<{ utteranceId?: string; status?: string; subjectId?: string | null }> } | undefined;
    if (!transcript || !Array.isArray(response?.utteranceStatuses) || !Array.isArray(response.subjects)) return null;
    const given = (arrays.find(a => a !== transcript && a.length > 0 && a.every(x => typeof (x as ListedSubject)?.id === 'string' && 'description' in (x as object))) ?? []) as ListedSubject[];

    const spoken = new Map<string, { speaker: string; chars: number }>();
    for (const segment of transcript) {
        for (const u of segment.utterances ?? []) {
            const id = u.utteranceId ?? u.id;
            if (id) spoken.set(id, { speaker: (segment.speakerName ?? '?').split(' - ')[0], chars: (u.text ?? '').length });
        }
    }
    const returned = new Map(response.subjects.map(s => [s.id, s]));
    const discussed: DiscussedSubject[] = [];
    for (const subject of given) {
        const tagged = response.utteranceStatuses.filter(s => s.status === 'SUBJECT_DISCUSSION' && s.subjectId === subject.id && s.utteranceId && spoken.has(s.utteranceId));
        if (tagged.length === 0) continue;
        const back = returned.get(subject.id);
        const speech = tagged.map(s => spoken.get(s.utteranceId!)!);
        discussed.push({
            id: subject.id as string,
            name: String(subject.name ?? ''),
            utterances: tagged.length,
            chars: speech.reduce((sum, u) => sum + u.chars, 0),
            speakers: [...new Set(speech.map(u => u.speaker))],
            returned: Boolean(back),
            updated: Boolean(back) && words(back!.description) !== words(subject.description),
        });
    }
    return discussed;
}

/**
 * A later batch discusses a subject an earlier batch described, and the description stays as
 * it was: readers see only the speakers of the earlier batch.
 */
export default callCheck('description_not_updated', ['batch-processing*'], call => {
    const discussed = discussedSubjects(call);
    if (!discussed) return unknown('the call is not a readable batch (transcript, subject list or statuses missing)');
    const substantial = discussed.filter(s => !s.updated && s.chars >= SUBSTANTIAL_CHARS).sort((a, b) => b.chars - a.chars);
    if (substantial.length === 0) return pass();
    return fail(substantial.map(s => `«${s.name}» [${s.id}]: ${s.utterances} utterances, ${s.chars} chars (${s.speakers.join(', ')})${s.returned ? ', returned unchanged' : ', not returned'}`).join('\n'));
});
