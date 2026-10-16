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
 * A word whose phonetic key is shorter than this is never corrected. «η» and
 * «οι», «να» and «θα», «το» and «τα» share a key or differ by one sound, and
 * none of them is a mishearing of the other: the secretary chose the word.
 */
export const MIN_PHONETIC_KEY_LENGTH = 4;

/** Whether one word could be a mishearing of the other. */
export function soundsAlike(ours: string, theirs: string): boolean {
    const a = phoneticKey(ours);
    const b = phoneticKey(theirs);
    const length = Math.max(a.length, b.length);
    if (length < MIN_PHONETIC_KEY_LENGTH) return false;
    return levenshtein(a, b) <= Math.floor(MAX_PHONETIC_DISTANCE_SHARE * length);
}

const digits = (norm: string) => norm.replace(/\P{N}+/gu, "");

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
 * one turn, and that turn passes the gate. Everything else is counted and
 * left alone.
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
        if (spacingOnly) continue;
        const bounded = edit.aStart > 0 && edit.aEnd < ours.length
            && alignment.aToB[edit.aStart - 1] === edit.bStart - 1 && alignment.aToB[edit.aEnd] === edit.bEnd;
        const oneForOne = ourWords.length > 0 && ourWords.length === theirWords.length && ourWords.length <= MAX_SUBSTITUTION_TOKENS;
        const oneUtterance = ourWords.length > 0 && ourWords[0].source === ourWords[ourWords.length - 1].source;
        const substitution = bounded && oneForOne && oneUtterance && ourWords.every((word, i) => mayReplace(word, theirWords[i], vocabulary));
        if (!substitution) {
            counts.insertionsSkipped += theirWords.length;
            counts.deletionsSkipped += ourWords.length;
            continue;
        }
        const utteranceIndex = ourWords[0].source;
        const entry = byUtterance.get(utteranceIndex) ?? { replacements: [], turnIndex };
        entry.replacements.push(...ourWords.map((word, i) => ({ index: word.index, word: theirWords[i].text })));
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
