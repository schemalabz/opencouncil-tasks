import { foldGreekHomoglyphs } from "../../tasks/utils/decisionPdfExtraction.js";

/**
 * Text normalisation shared by every step that compares minutes text with
 * anything else: the section picker, the turn parser, the model check's
 * locator and the aligner. The original text is never changed; these forms
 * exist for comparison only.
 *
 * `normalizeGreekName` (decision reader) and `normalizeName` (speaker
 * identification) fold names the same way but drop or replace punctuation.
 * The forms here keep every character, so a search in the folded text maps
 * back to an offset in the original (see foldedWithOffsets).
 */

/** Lower case, NFC, accents removed, Latin homoglyphs folded, final sigma folded. Keeps punctuation and spacing. */
export function foldText(text: string): string {
    return foldGreekHomoglyphs(text)
        .normalize("NFD")
        .replace(/\p{M}+/gu, "")
        .toLowerCase()
        .replace(/ς/g, "σ")
        .normalize("NFC");
}

/** foldText plus whitespace collapsed to one space and trimmed. */
export function foldLine(text: string): string {
    return foldText(text).replace(/\s+/g, " ").trim();
}

const NUMBER_WORDS: Record<string, string> = {
    μηδεν: "0", ενα: "1", ενασ: "1", μια: "1", δυο: "2", τρια: "3", τρεισ: "3", τεσσερα: "4", τεσσερισ: "4",
    πεντε: "5", εξι: "6", εφτα: "7", επτα: "7", οχτω: "8", οκτω: "8", εννεα: "9", εννια: "9", δεκα: "10",
    εντεκα: "11", ενδεκα: "11", δωδεκα: "12", δεκατρια: "13", δεκατεσσερα: "14", δεκαπεντε: "15", δεκαεξι: "16",
    δεκαεφτα: "17", δεκαεπτα: "17", δεκαοχτω: "18", δεκαοκτω: "18", δεκαεννεα: "19", δεκαεννια: "19",
    εικοσι: "20", τριαντα: "30", σαραντα: "40", πενηντα: "50", εξηντα: "60", εβδομηντα: "70", ογδοντα: "80", ενενηντα: "90",
    εκατο: "100", διακοσια: "200", τριακοσια: "300", τετρακοσια: "400", πεντακοσια: "500", εξακοσια: "600",
    εφτακοσια: "700", επτακοσια: "700", οχτακοσια: "800", οκτακοσια: "800", εννιακοσια: "900", χιλια: "1000",
};

/**
 * Spellings that are both correct and that a secretary and a transcriber pick
 * differently: the honorific and its abbreviation («κύριος», «κ.»), the
 * elided forms («κι», «απ'», «μένα») and the movable final ν («τον», «το»).
 * Each maps to one form so that the aligner pairs them and none of them is
 * ever a correction.
 */
const VARIANTS: Record<string, string> = {
    κυριοσ: "κ", κυριε: "κ", κυριου: "κ", κυριο: "κ", κκ: "κ", κυριοι: "κ", κυριων: "κ", κυριουσ: "κ",
    κυρια: "κα", κυριασ: "κα", κυριεσ: "κα",
    κι: "και", απ: "απο", μενα: "εμενα", σενα: "εσενα", σ: "σε", μ: "με", τ: "το", ειν: "ειναι",
    τον: "το", την: "τη", στον: "στο", στην: "στη", εναν: "ενα", δεν: "δε", μην: "μη", σαν: "σα", αυτην: "αυτη",
};

/**
 * The comparison form of one word: folded, with every character that is not a
 * letter or a digit removed, a spelling variant replaced by its one form, and
 * a number word replaced by its digits so that «δύο» and «2» compare equal.
 * Empty for a token that is only punctuation.
 */
export function normalizeToken(token: string): string {
    const folded = foldText(token).replace(/[^\p{L}\p{N}]+/gu, "");
    const variant = VARIANTS[folded] ?? folded;
    return NUMBER_WORDS[variant] ?? variant;
}

/**
 * Splits text into tokens on whitespace. Each token keeps its original text
 * (for output) next to its comparison form; tokens with an empty comparison
 * form (punctuation only) are left out, so «–» and «…» never count as words.
 */
export type Token = {
    text: string;
    norm: string;
    /** Position in the whitespace split of the text, punctuation-only pieces included, for writing the text back. */
    index: number;
};

export function tokenize(text: string): Token[] {
    const tokens: Token[] = [];
    let index = 0;
    for (const match of text.matchAll(/\S+/g)) {
        const norm = normalizeToken(match[0]);
        if (norm) tokens.push({ text: match[0], norm, index });
        index++;
    }
    return tokens;
}

/**
 * A folded copy of `text` with runs of whitespace collapsed to one space, or
 * to one newline when the run holds a line break, and, for every character of
 * the copy, the index of the character in the original it came from. A search
 * in the copy then maps back to an offset in the original: this is how a label
 * and a few words the model returns are located without the model ever
 * returning an offset.
 */
export function foldedWithOffsets(text: string): { folded: string; offsets: number[] } {
    let folded = "";
    const offsets: number[] = [];
    let pending: "" | " " | "\n" = "";
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (/\s/.test(ch)) {
            if (folded.length > 0 && pending !== "\n") pending = ch === "\n" ? "\n" : " ";
            continue;
        }
        const f = foldText(ch);
        if (f === "") continue;
        if (pending) {
            folded += pending;
            offsets.push(i);
            pending = "";
        }
        for (const c of f) {
            folded += c;
            offsets.push(i);
        }
    }
    return { folded, offsets };
}

/**
 * The sound of a Greek word, roughly: the vowel digraphs and the letters that
 * share a sound fold to one symbol, and a doubled letter counts once. A word
 * our recogniser misheard sounds like the word the minutes print («Μεσόγειον»
 * and «Μεσογείων», «διαπερής» and «διαμπερής»); a word the secretary chose
 * instead («Ωραία» for «Λοιπόν») does not. Digits stay as they are: «3.200.000»
 * and «3.200» are different amounts, not one sound.
 */
export function phoneticKey(token: string): string {
    return normalizeToken(token)
        .replace(/ου/g, "u")
        .replace(/αι/g, "e")
        .replace(/ει|οι|υι/g, "i")
        .replace(/[ηιυ]/g, "i")
        .replace(/[οω]/g, "o")
        .replace(/ε/g, "e")
        .replace(/μπ/g, "b")
        .replace(/ντ/g, "d")
        .replace(/γκ|γγ/g, "g")
        .replace(/(\p{L})\1+/gu, "$1");
}

/** Edit distance between two sequences: two strings, or two lists of words. */
export function levenshtein(a: ArrayLike<string>, b: ArrayLike<string>): number {
    const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        let diagonal = prev[0];
        prev[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const temp = prev[j];
            prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
            diagonal = temp;
        }
    }
    return prev[b.length];
}
