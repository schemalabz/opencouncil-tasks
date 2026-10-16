import type { SummarizeRequest, Subject } from '../../types.js';
import { fail, foldGreek, pass, taskCheck, unknown } from './check.js';

// All matched against foldGreek(text).
const FUTURE = /(θα συζητηθει|θα εξεταστει|θα τεθει|θα συζητησει|προκειται να συζητηθει)/;
/** «Ο δήμαρχος ανέφερε ότι το θέμα θα συζητηθεί…» reports what someone said; it is not the summary's own tense. */
const REPORTED = /(δηλωσε|ανεφερε|ειπε|τονισε|σημειωσε|επισημανε|ενημερωσε|διευκρινισε|υποστηριξε|προτεινε|ζητησε)\s+(οτι|πωσ)\s/;
/** A postponed item is legitimately still to be discussed. */
const POSTPONED = /(αναβλ|αναβολ|αποσυρ|επομενη συνεδριασ)/;

function staleSentence(description: string): string | null {
    for (const sentence of description.split(/(?<=[.;!·\n])\s*/)) {
        const folded = foldGreek(sentence);
        const m = FUTURE.exec(folded);
        if (!m) continue;
        if (REPORTED.test(folded.slice(0, m.index)) || POSTPONED.test(folded)) continue;
        return sentence.trim();
    }
    return null;
}

export default taskCheck('summary_stale_future_tense', ['summarize'], ({ run, result }) => {
    const date = (run.input as Partial<SummarizeRequest> | undefined)?.date;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(date)) return unknown('no meeting date on the run input');
    if (date.slice(0, 10) >= run.startedAt.slice(0, 10)) return pass('the meeting is not in the past');

    const subjects = (result as { subjects?: Subject[] } | null)?.subjects;
    if (!Array.isArray(subjects)) return unknown('the result has no subjects');
    const stale = subjects
        .filter(s => !s.withdrawn)
        .flatMap(s => {
            const sentence = staleSentence(s.description ?? '');
            return sentence ? [`«${s.name}»: ${sentence}`] : [];
        });
    return stale.length ? fail(stale.join('\n')) : pass();
});
