import type { Edit } from "./align.js";
import { passesGate, type Matching, type StreamToken, type TimedUtterance } from "./matching.js";
import { levenshtein, phoneticKey } from "./text.js";
import type { Turn } from "./turns.js";
import type { FixFromMinutesReport, FixFromMinutesResult } from "../../types.js";

/**
 * The text corrections: a few words of an utterance replaced, one for one, by
 * the words the minutes print in their place, inside a turn that passes the
 * verbatim gate. Insertions and deletions are counted and never written:
 * minutes drop fillers and repetitions, and sometimes add a word the speaker
 * did not say. No model decides a correction.
 *
 * The minutes are an edited document, not a second transcript. The secretary
 * fixes grammar, swaps a word for a better one and corrects the roll call.
 * The rules below separate a mishearing from an edit without reading either:
 *
 * - One word for one word. A region where the word counts differ is a
 *   rewording, or a word pdf.js split in a justified line («είνα ι»).
 * - The minutes never print our word. A word the secretary uses elsewhere in
 *   the same minutes is a word they know and chose not to use here
 *   («πλειοψηφίας» against «μειοψηφίας», «απούσα» against «παρούσα», «να»
 *   against «θα»). A word they never print («Ρημάκης», «Μεσόγειον») is one
 *   the recogniser made up.
 * - The two words sound alike, and both are long enough to be misheard. A
 *   rewording («Ωραία» for «Λοιπόν») does not; «η» and «οι» are not corrected.
 * - The digits are the same. «3.200.000» and «3.200» sound alike by the
 *   letters rule and are different amounts.
 * - The two words are not two written forms of one word. «δεχτώ» and «δεχθώ»,
 *   «πληρώνουν» and «πληρώνουνε» are the same word in two registers. The
 *   secretary's form is not more correct than ours (see sameWord).
 * - The two words are not two inflections that sound the same. «συνεχίζεται»
 *   and «συνεχίζετε» are both words, and only the sentence says which one the
 *   speaker said (see sameSoundInflection).
 * - The two words are not two spellings of one sound, unless the minutes
 *   print a name or an acronym. «περαιτέρω» and «περεταίρω» sound the same,
 *   and the sound does not say which spelling is right (see sameSoundSpelling
 *   and printedAsName).
 */

/** A substitution replaces at most this many words. A starting value. */
export const MAX_SUBSTITUTION_TOKENS = 4;
/**
 * Two words sound alike when their phonetic keys differ in at most this share
 * of the longer key, rounded down: one sound in a word of four to seven, two
 * in a word of eight to eleven. A starting value, set on the four reviewed
 * Παπάγου meetings: between 0.25 and 0.34 lie sixteen more word pairs, two of
 * them mishearings and the rest the secretary's rewordings («έδιναν» →
 * «δίνανε», «αρδευτικά» → «ανθεκτικά»).
 */
export const MAX_PHONETIC_DISTANCE_SHARE = 0.25;
/**
 * A word whose phonetic key is shorter than this is never corrected, and never
 * written as the correction. «η» and «οι», «να» and «θα», «το» and «τα» share
 * a key or differ by one sound, and none of them is a mishearing of the other:
 * the secretary chose the word. The same holds when only one of the two words
 * is short: «πόσοι» and «πώς» differ by one sound and are two words. The twelve
 * measured runs hold nine such pairs: one correction («ΚΑΠ» → «ΚΔΑΠ»), that
 * change of meaning, and seven of the secretary's grammar («όλον» → «όλο»,
 * «εμάς» → «μας»).
 */
export const MIN_PHONETIC_KEY_LENGTH = 4;

/** Whether one word could be a mishearing of the other. */
export function soundsAlike(ours: string, theirs: string): boolean {
    const a = phoneticKey(ours);
    const b = phoneticKey(theirs);
    if (Math.min(a.length, b.length) < MIN_PHONETIC_KEY_LENGTH) return false;
    return levenshtein(a, b) <= Math.floor(MAX_PHONETIC_DISTANCE_SHARE * Math.max(a.length, b.length));
}

const digits = (norm: string) => norm.replace(/\P{N}+/gu, "");

/**
 * The differences between two written forms of one word, each replaced by one
 * form: the learned and the common consonant cluster («δεχθώ» / «δεχτώ»,
 * «φθηνότερα» / «φτηνότερα», «δεσμευθεί» / «δεσμευτεί», «ανοικτή» / «ανοιχτή»),
 * the movable final ε of a verb («πληρώνουν» / «πληρώνουνε», «αποφάσισαν» /
 * «αποφασίσανε») and «πέρυσι» / «πέρσι». On the two Παπάγου meetings that we
 * read before their review, 40 of the 154 changed words were of this kind,
 * and none of them moved an utterance closer to its reviewed text.
 */
const WORD_FORMS: [RegExp, string][] = [
    [/χθ/g, "χτ"], [/φθ/g, "φτ"], [/σθ/g, "στ"], [/κτ/g, "χτ"], [/([αε])υθ/g, "$1υτ"], [/νε$/, "ν"], [/^περυσι/, "περσι"],
];
const wordForm = (norm: string) => WORD_FORMS.reduce((form, [pattern, replacement]) => form.replace(pattern, replacement), norm);

/** Whether two comparison forms (see normalizeToken) are two written forms of one word. Such a pair is never a correction. */
export function sameWord(ours: string, theirs: string): boolean {
    return wordForm(ours) === wordForm(theirs);
}

/**
 * The endings of two inflections of one word that sound the same, in the
 * comparison form: the passive third person and the active second person
 * plural of a verb («συνεχίζεται» / «συνεχίζετε»), the masculine plural and
 * the feminine singular of an adjective («άδικοι» / «άδικη»), and the plural
 * and the singular in «-είς» / «-ής» («μνημειώδεις» / «μνημειώδης»).
 *
 * Both forms are words, so the sound does not say which one the speaker said
 * and the "minutes never print our word" rule does not either: the sentence
 * does, and no rule here reads the sentence. On the seven reviewed Παπάγου
 * meetings 26 of the 243 changed words were of this kind. On the two meetings
 * that we read before their review 15 of 114 were, in 14 utterances, and none
 * of them moved an utterance closer to its reviewed text: the reviewer kept
 * our form every time.
 *
 * Other endings that sound the same are not in the list, because there one
 * form is a spelling error or a form the recogniser made up: «Μεσόγειον» /
 * «Μεσογείων», «ομηρεία» / «ομηρία», «απευκτέου» / «απευκταίου». The rule on
 * the two spellings of one sound decides those (see sameSoundSpelling). This
 * list holds for a name too.
 */
const SAME_SOUND_ENDINGS: [string, string][] = [["ται", "τε"], ["οι", "η"], ["εισ", "ησ"]];
const differInEnding = (a: string, b: string, endA: string, endB: string) =>
    a.endsWith(endA) && b.endsWith(endB) && a.slice(0, -endA.length) === b.slice(0, -endB.length);

/** Whether two comparison forms are two inflections of one word that sound the same. Such a pair is never a correction. */
export function sameSoundInflection(ours: string, theirs: string): boolean {
    return SAME_SOUND_ENDINGS.some(([a, b]) => differInEnding(ours, theirs, a, b) || differInEnding(ours, theirs, b, a));
}

/**
 * Whether two comparison forms are two spellings of one sound, in a word long
 * enough to be corrected. A shorter pair («η» and «οι») stays under the rule
 * of MIN_PHONETIC_KEY_LENGTH: it is the secretary's choice of word, and it
 * stops its region.
 *
 * The recogniser heard such a word right, so the pair is a question of
 * spelling, and the secretary's spelling is not more correct than ours. In
 * the minutes of Πέραμα, Ίλιον and Κατερίνη 46 of the 199 changed words were
 * of this kind. By a reading of the 36 that are not a name or an acronym, 17
 * were errors of the minutes («περαιτέρω» → «περεταίρω», «ελλείμματος» →
 * «ελλείματος», «παραληφθεί» → «παραλειφθεί»), 17 were pairs where both
 * spellings are in use («ταμειακό» / «ταμιακό») and 2 were corrections
 * («αύλιου» → «αύλειου»). The minutes of Παπάγου-Χολαργός have more
 * spellings right than wrong («απορρίματα» → «απορρίμματα»), and those
 * corrections are lost: a rule that does not read the word cannot tell the
 * two municipalities apart.
 */
export function sameSoundSpelling(ours: string, theirs: string): boolean {
    const key = phoneticKey(ours);
    return key.length >= MIN_PHONETIC_KEY_LENGTH && key === phoneticKey(theirs);
}

export type Correction = FixFromMinutesResult["updateUtterances"][number];
export type CorrectionCounts = FixFromMinutesReport["corrections"];

/** One of our words, by its position in the whitespace split of the utterance, and the minutes' word that replaces it. */
export type Replacement = { index: number; word: string };

/** An apostrophe belongs to an elided word («απ'», «γι'»); the rest is punctuation around the word. */
const LEADING_PUNCTUATION = /^[^\p{L}\p{N}'’]+/u;
const TRAILING_PUNCTUATION = /[^\p{L}\p{N}'’]+$/u;
/** «Δ.Σ.», «κ.», «Α.»: the dot belongs to the abbreviation. «της.» ends a sentence. */
const ABBREVIATION = /^(?:\p{L}|(?:\p{L}+\.)+\p{L}*)\.$/u;

/** The minutes' word without the punctuation around it; our punctuation outside the span stays. */
export function core(word: string): string {
    const stripped = word.replace(LEADING_PUNCTUATION, "").replace(TRAILING_PUNCTUATION, "");
    const withDot = stripped + ".";
    return word.replace(LEADING_PUNCTUATION, "").startsWith(withDot) && ABBREVIATION.test(withDot) ? withDot : stripped;
}

/** The punctuation that ends a sentence, with any closing quote or bracket after it. A capital after it says nothing. */
const SENTENCE_END = /[.;!?:·…]["'’»”)\]]*$/u;
/** The comparison forms of «κ.», «κύριε», «κα», «κυρία» (see VARIANTS in text.ts): the next word is a name. */
const HONORIFICS: ReadonlySet<string> = new Set(["κ", "κα"]);

/**
 * Whether the minutes print the word as an acronym or as a name: every letter
 * is a capital («ΚΗΦΗ», «Ο.Π.Π.Α.Π.»), or the first letter is a capital and
 * the word does not start a sentence. `previous` is the minutes' word before
 * it. The first word of a turn starts a sentence. A word after an
 * abbreviation or an honorific («κ. Κουτουβίνη», «Α. Παπάζογλου») does not.
 * A full stop that the document prints apart from its word («ψηφίζουμε .
 * Διευκρινίσεις») is not a token, and it ends the sentence all the same.
 *
 * The secretary knows the names of the people, the streets and the bodies of
 * the municipality, and the recogniser writes them from their sound. A
 * spelling of one sound is therefore written for these words only («ΚΗΦΙ» →
 * «ΚΗΦΗ», «Κουτουβήνη» → «Κουτουβίνη», «Αρμάω» → «Αρμάο»). The secretary is
 * also wrong at times: of the 11 such pairs in the three municipalities
 * above, 2 were errors («Άδωνι» → «Άδωνη», «Νεωτέρων» → «Νεοτέρων»).
 */
export function printedAsName(word: StreamToken, previous: StreamToken | undefined): boolean {
    const letters = word.text.replace(/\P{L}+/gu, "");
    if (letters === "" || letters[0] === letters[0].toLowerCase()) return false;
    if (letters.length > 1 && letters === letters.toUpperCase()) return true;
    if (!previous || previous.source !== word.source) return false;
    if (HONORIFICS.has(previous.norm)) return true;
    if (word.skipped !== undefined && SENTENCE_END.test(word.skipped)) return false;
    return !SENTENCE_END.test(previous.text) || core(previous.text).endsWith(".");
}

/**
 * Writes the replacements into the utterance text, word by word, keeping our
 * punctuation around each word and every piece between the words («–», «...»).
 */
export function rewriteUtterance(text: string, replacements: Replacement[]): string {
    const pieces = text.match(/\S+/g) ?? [];
    for (const { index, word } of replacements) {
        const ours = pieces[index];
        const replacement = core(word);
        if (!replacement) continue;
        const leading = LEADING_PUNCTUATION.exec(ours)?.[0] ?? "";
        const trailing = TRAILING_PUNCTUATION.exec(ours)?.[0] ?? "";
        pieces[index] = leading + replacement + trailing;
    }
    return pieces.join(" ");
}

/**
 * Whether our word may be replaced by the minutes' word: the minutes never
 * print ours, the two sound alike, and the digits agree.
 */
export function mayReplace(ours: StreamToken, theirs: StreamToken, minutesVocabulary: ReadonlySet<string>): boolean {
    return !minutesVocabulary.has(ours.norm) && digits(ours.norm) === digits(theirs.norm) && soundsAlike(ours.text, theirs.text);
}

/**
 * Applies the rules to every difference region. A substitution is written
 * when the region sits between two equal words, has the same number of words
 * on both sides (at most MAX_SUBSTITUTION_TOKENS), our words belong to one
 * utterance, every word pair passes mayReplace, the minutes' words belong to
 * one turn, and that turn passes the gate. A pair of two written forms of one
 * word (see sameWord), of two inflections that sound the same (see
 * sameSoundInflection), or of two spellings of one sound that the minutes do
 * not print as a name (see sameSoundSpelling), is left as we wrote it and
 * does not stop the other pairs of its region. Everything else is counted
 * and left alone.
 */
export function correctFromTurns(turns: Turn[], utterances: TimedUtterance[], matching: Matching, gate?: number): { corrections: Correction[]; counts: CorrectionCounts } {
    const { ours, minutes, alignment } = matching;
    const counts: CorrectionCounts = { utterancesChanged: 0, substitutions: 0, insertionsSkipped: 0, deletionsSkipped: 0 };
    const byUtterance = new Map<number, { replacements: Replacement[]; turnIndex: number }>();
    const vocabulary = new Set(minutes.map(t => t.norm));

    /** The turn a region belongs to: that of its minutes words, else of the aligned word before it. */
    const turnOf = (edit: Edit): number | null => {
        if (edit.bEnd > edit.bStart) {
            const first = minutes[edit.bStart].source;
            return minutes[edit.bEnd - 1].source === first ? first : null;
        }
        const before = edit.aStart > 0 ? alignment.aToB[edit.aStart - 1] : -1;
        return before >= 0 ? minutes[before].source : null;
    };

    for (const edit of alignment.edits) {
        const turnIndex = turnOf(edit);
        if (turnIndex === null || !passesGate(matching.turns[turnIndex], gate)) continue;
        const ourWords = ours.slice(edit.aStart, edit.aEnd);
        const theirWords = minutes.slice(edit.bStart, edit.bEnd);
        // «εν τάξει» against «εντάξει»: the same letters spaced differently are a style, not a mishearing.
        const spacingOnly = ourWords.map(t => t.norm).join("") === theirWords.map(t => t.norm).join("");
        const pairs = ourWords.length === theirWords.length ? ourWords.map((word, i) => ({ word, theirs: theirWords[i], previous: minutes[edit.bStart + i - 1] })) : [];
        const differing = pairs.filter(({ word, theirs, previous }) => !sameWord(word.norm, theirs.norm) && !sameSoundInflection(word.norm, theirs.norm)
            && !(sameSoundSpelling(word.norm, theirs.norm) && !printedAsName(theirs, previous)));
        if (spacingOnly || (pairs.length > 0 && differing.length === 0)) continue;
        const bounded = edit.aStart > 0 && edit.aEnd < ours.length
            && alignment.aToB[edit.aStart - 1] === edit.bStart - 1 && alignment.aToB[edit.aEnd] === edit.bEnd;
        const oneForOne = ourWords.length > 0 && ourWords.length === theirWords.length && ourWords.length <= MAX_SUBSTITUTION_TOKENS;
        const oneUtterance = ourWords.length > 0 && ourWords[0].source === ourWords[ourWords.length - 1].source;
        const substitution = bounded && oneForOne && oneUtterance && differing.every(pair => mayReplace(pair.word, pair.theirs, vocabulary));
        if (!substitution) {
            counts.insertionsSkipped += theirWords.length;
            counts.deletionsSkipped += ourWords.length;
            continue;
        }
        const utteranceIndex = ourWords[0].source;
        const entry = byUtterance.get(utteranceIndex) ?? { replacements: [], turnIndex };
        entry.replacements.push(...differing.map(pair => ({ index: pair.word.index, word: pair.theirs.text })));
        byUtterance.set(utteranceIndex, entry);
        counts.substitutions++;
    }

    const corrections: Correction[] = [];
    for (const [utteranceIndex, { replacements, turnIndex }] of byUtterance) {
        const utterance = utterances[utteranceIndex];
        const text = rewriteUtterance(utterance.text, replacements);
        if (text === utterance.text) continue;
        const turn = turns[turnIndex];
        corrections.push({ utteranceId: utterance.utteranceId, text, markUncertain: false, source: { page: turn.page, label: turn.label, turnIndex: turn.index } });
        counts.utterancesChanged++;
    }
    return { corrections, counts };
}
