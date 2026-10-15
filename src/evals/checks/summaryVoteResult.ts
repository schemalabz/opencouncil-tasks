import { callCheck, fail, foldGreek, pass, responseJson, unknown } from './check.js';

// Matched against foldGreek(text). The outcome of this session's vote: approval or rejection,
// unanimity or majority, counts, who voted which way (#109's rule, schemalabz/opencouncil-tasks#109).
const VOTE_RESULT = new RegExp([
    'εγκριθηκε', 'απορριφθηκε', 'υπερψηφιστηκε', 'καταψηφιστηκε',
    'ομοφων(α|ωσ|η)', 'κατα πλειοψηφια', 'πλειοψηφικα',
    'με \\d+ (ψηφουσ|υπερ|κατα)', '\\d+ ψηφ(ουσ|οι)', '\\d+ υπερ', '\\d+ κατα\\b',
    'ψηφισ(αν|ε) (υπερ|κατα|λευκο|παρων)', '(υπερ|κατα) ψηφισ(αν|ε)',
].join('|'));
/**
 * History the discussion cites, not this session's vote: «η μελέτη που εγκρίθηκε το 2020»,
 * «η προηγούμενη απόφαση που είχε εγκριθεί ομόφωνα» (the pluperfect is always an earlier act).
 */
const PAST_ACT = new RegExp([
    '(εγκριθηκε|απορριφθηκε|υπερψηφιστηκε|καταψηφιστηκε)\\s+(το|τον|την|στισ|στο|στη|με την|με τη|με απο)\\s+(\\d{4}|προηγουμεν|παλαιοτερ|αποφαση)',
    '(ειχε|ειχαν)\\s+(εγκριθει|απορριφθει|υπερψηφιστει|καταψηφιστει|ψηφιστει)',
    'προηγουμεν\\S*\\s+(αποφασ|συνεδριασ)',
].join('|'));

const stripRefs = (text: string) => text.replace(/\[([^\]]*)\]\((REF|ref):[^)]*\)/g, '$1');

function texts(json: unknown): string[] | null {
    if (!json || typeof json !== 'object') return null;
    const o = json as { subjects?: Array<{ description?: unknown }>; speakerContributions?: Array<{ text?: unknown }>; description?: unknown };
    if (Array.isArray(o.subjects)) return o.subjects.map(s => (typeof s.description === 'string' ? s.description : '')).filter(Boolean);
    if (Array.isArray(o.speakerContributions)) return o.speakerContributions.map(c => (typeof c.text === 'string' ? c.text : '')).filter(Boolean);
    if (typeof o.description === 'string') return [o.description];
    return null;
}

function voteSentence(text: string): string | null {
    for (const sentence of stripRefs(text).split(/(?<=[.;!·\n])\s*/)) {
        const folded = foldGreek(sentence);
        if (VOTE_RESULT.test(folded) && !PAST_ACT.test(folded)) return sentence.trim();
    }
    return null;
}

/**
 * Subject descriptions (batch processing, merge) and speaker contributions must not state the
 * vote's result: the transcript cannot settle it, since roll-call answers are short utterances
 * diarization often gives to the wrong speaker.
 */
export default callCheck('summary_states_vote_result', ['batch-processing*', 'subject-merge*', 'contributions*'], call => {
    const found = texts(responseJson(call));
    if (!found) return unknown('the response is not a subjects or contributions object');
    const hits = found.flatMap(t => { const s = voteSentence(t); return s ? [s] : []; });
    return hits.length ? fail(hits.slice(0, 3).join(' | ')) : pass();
});
