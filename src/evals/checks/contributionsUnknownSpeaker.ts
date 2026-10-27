import type { CallRecord } from '../../lib/llm/callRecord.js';
import { callCheck, fail, pass, responseJson, unknown } from './check.js';

/**
 * The contributions prompt lists the speakers to write for under their keys («**Speaker: k**»:
 * a person id, or `name:<name>`), then the subject's whole discussion with each line labelled
 * by the speaker's name (or id when nameless). A call for one batch of a large subject lists
 * only that batch's keys, while the discussion still has everyone who spoke on the subject.
 */
const SPEAKER_HEADING = /^\*\*Speaker: (.+)\*\*\s*$/gm;
const DISCUSSION_LINE = /^\d+\. \[([^\]]+)\] /gm;

function userText(call: CallRecord): string {
    return call.request.messages
        .filter(m => m.role === 'user')
        .flatMap(m => (typeof m.content === 'string' ? [m.content] : Array.isArray(m.content) ? m.content.map(b => (b as { text?: string }).text ?? '') : []))
        .join('\n');
}

function withinOneEdit(a: string, b: string): boolean {
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    const [x, y] = [a.slice(i), b.slice(i)];
    return x.slice(1) === y.slice(1) || x.slice(1) === y || x === y.slice(1);
}

export default callCheck('contributions_unknown_speaker', ['contributions:*'], call => {
    const text = userText(call);
    const keys = [...text.matchAll(SPEAKER_HEADING)].map(m => m[1].trim());
    if (keys.length === 0) return unknown('the prompt lists no speakers');
    const out = responseJson(call) as { speakerContributions?: Array<{ speakerId?: unknown }> } | undefined;
    if (!Array.isArray(out?.speakerContributions)) return unknown('the response is not a contributions object');

    const discussion = text.includes('ΠΛΗΡΗΣ ΣΥΖΗΤΗΣΗ') ? text.slice(text.indexOf('ΠΛΗΡΗΣ ΣΥΖΗΤΗΣΗ')) : '';
    const spoke = new Set([...discussion.matchAll(DISCUSSION_LINE)].map(m => m[1].trim()));
    const given = new Set(keys);
    const idKeys = keys.filter(k => !k.startsWith('name:'));
    // A discussion label no key accounts for is a named speaker of another batch, unless an id key is left to be theirs.
    const unaccounted = [...spoke].filter(l => !given.has(`name:${l}`) && !given.has(l)).length;
    const batch = unaccounted > idKeys.filter(k => !spoke.has(k)).length;

    const invented: string[] = [];
    const undetermined: string[] = [];
    for (const c of out.speakerContributions) {
        const id = String(c.speakerId ?? '').trim();
        if (given.has(id) || spoke.has(id)) continue;
        if (id.startsWith('name:')) {
            if (!spoke.has(id.slice('name:'.length).trim())) invented.push(id);
        } else if (!batch || idKeys.some(k => withinOneEdit(k, id)) || !idKeys.some(k => k.length === id.length)) {
            invented.push(id);
        } else undetermined.push(id);
    }
    if (invented.length) return fail(`${invented.length} of ${out.speakerContributions.length} contributions name a speaker with no utterance in the subject: ${invented.join(', ')} (given: ${keys.join(', ')})`);
    if (undetermined.length) return unknown(`a batch call names ${undetermined.join(', ')}, which may be a named speaker of another batch`);
    return pass();
});
