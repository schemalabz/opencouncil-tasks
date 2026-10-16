import { matchPersonByName } from "../../tasks/utils/decisionPdfExtraction.js";
import type { SectionLine } from "./read.js";
import { foldLine } from "./text.js";

/**
 * Cutting a section of the minutes into speaker turns.
 *
 * Almost every verbatim document we have read shares one grammar: a turn
 * starts a line with a label and a colon. The label is a role word in capitals
 * («ΠΡΟΕΔΡΟΣ», «ΔΗΜΑΡΧΟΣ») or a short name («Κ. ΤΟΜΠΟΥΛΟΓΛΟΥ», «κα Κανατσίδη»,
 * «ΔΑΡΔΑΜΑΝΕΛΗΣ Θ.»), with an optional parenthesis after it. Ρέθυμνο puts the
 * whole label in a parenthesis («(Πρόεδρος Δ.Σ., Λουκογεωργάκης Ευστάθιος):»).
 * Θεσσαλονίκη prints the label alone on a line with no colon; the parser reads
 * that style only when the colon style finds almost nothing (see
 * findBareLabels). The title block of many documents names the officers in the
 * same grammar («ΔΗΜΑΡΧΟΣ: ΜΠΑΜΠΑΛΟΣ ΝΙΚΟΛΑΟΣ»); those lines are not turns (see
 * isTitleField). The parser is deterministic; a model then checks its work
 * (see check.ts).
 */

/** The text of a section as one string, with the offset where each page starts. */
export type SectionText = {
    text: string;
    pageStarts: { offset: number; page: number }[];
};

/** Where a turn starts: the label line's first character, and the first character of speech after the colon. */
export type Boundary = {
    offset: number;
    labelEnd: number;
    /** The label as printed, parenthesis included. */
    label: string;
    /** The comparison key of the label (see labelKey), shared by «ΠΡΟΕΔΡΟΣ» and «Ο ΠΡΟΕΔΡΟΣ». */
    key: string;
};

export type Turn = {
    /** 0-based position in the section. */
    index: number;
    label: string;
    key: string;
    page: number;
    /** Offset of the label in the section text. */
    offset: number;
    /** The speech, stage directions removed, as printed otherwise. */
    text: string;
    /** Stage directions removed from this turn. */
    stageDirections: number;
};

/**
 * Role words a label can be, in their comparison form (see foldLine), each
 * mapped to the one form the roster's roles are compared with. The generic
 * labels of a voice nobody names («ΣΥΜΒΟΥΛΟΣ», «ΟΜΙΛΗΤΗΣ», «ΜΕΛΗ») are here
 * too: they are speakers, and they resolve to nobody without a model call.
 * A bare «ΝΟΜΙΚΟΣ» is not here: it is a surname (councillor Νομικός), and the
 * legal adviser is labelled «ΝΟΜΙΚΟΣ ΣΥΜΒΟΥΛΟΣ».
 */
const ROLE_ALIASES: Record<string, string> = {
    προεδροσ: "προεδροσ", "προεδροσ δσ": "προεδροσ", προεδρευων: "προεδροσ", προεδρευουσα: "προεδροσ",
    αντιπροεδροσ: "αντιπροεδροσ", "αντιπροεδροσ δσ": "αντιπροεδροσ",
    δημαρχοσ: "δημαρχοσ", αντιδημαρχοσ: "αντιδημαρχοσ", αντιδ: "αντιδημαρχοσ",
    γραμματεασ: "γραμματεασ", "γραμματεασ δσ": "γραμματεασ",
    "γενικοσ γραμματεασ": "γενικοσ γραμματεασ", "γενικη γραμματεασ": "γενικοσ γραμματεασ", "γεν γραμματεασ": "γενικοσ γραμματεασ",
    πρακτικογραφοσ: "πρακτικογραφοσ", εισηγητησ: "εισηγητησ", εισηγητρια: "εισηγητησ",
    συμβουλοσ: "συμβουλοσ", "δημοτικοσ συμβουλοσ": "συμβουλοσ", "δημοτικη συμβουλοσ": "συμβουλοσ",
    ομιλητησ: "ομιλητησ", ομιλητρια: "ομιλητησ", μελη: "μελη", μελοσ: "μελη", "νομικοσ συμβουλοσ": "νομικοσ συμβουλοσ",
    "υπ/κοσ παραγων": "υπηρεσιακοσ παραγων", "υπηρεσιακοσ παραγων": "υπηρεσιακοσ παραγων", υπαλληλοσ: "υπαλληλοσ",
    δημοτησ: "δημοτησ", κατοικοσ: "δημοτησ", πολιτησ: "δημοτησ", φωνη: "φωνη", φωνεσ: "φωνη",
};

/**
 * The one comparison form of a role a label or a roster line names, with the
 * dots of an abbreviation removed; null for anything else. A role word with a
 * portfolio or a body after it («ΑΝΤΙΔΗΜΑΡΧΟΣ ΠΑΙΔΕΙΑΣ», «Πρόεδρος Δημοτικής
 * Κοινότητας») is a role of its own: it resolves on a roster title that says
 * the same, never on the bare role word, since the chair of a community is
 * not the chair of the council.
 */
export function canonicalRole(folded: string): string | null {
    const key = folded.replace(/\./g, "").replace(/\s+/g, " ").trim();
    if (ROLE_ALIASES[key]) return ROLE_ALIASES[key];
    const [first, ...rest] = key.split(" ");
    return rest.length > 0 && ROLE_ALIASES[first] ? `${ROLE_ALIASES[first]} ${rest.join(" ")}` : null;
}

/** Honorifics that precede a surname in a label, in folded form. */
const HONORIFIC = /^(κ\.|κ|κα\.?|κοσ|κυριοσ|κυρια|κ\.κ\.)$/u;
/** «Δ.», «Ντ.», «Δ.-Ε.»: an initial. «ΓΕΝ.», «Δ.Σ.»: the abbreviation of a role word, read by canonicalRole. */
const INITIAL = /^(\p{Lu}\p{Ll}?\.|\p{Lu}{1,2}\.)$/u;
const ABBREVIATED_ROLE_WORD = /^(\p{Lu}{2,5}\.|(?:\p{Lu}\.){2,})$/u;
const DASH = /^[-–—]$/u;
const WORD = /^\p{Lu}[\p{L}'’/-]*$/u;
const ARTICLE = /^(ο|η)$/u;
const MAX_LABEL_TOKENS = 5;
const MAX_LABEL_CHARS = 60;

const LABEL_LINE = /^(\s*)([^:\n]{1,160}?)\s*:\s?(.*)$/u;
/**
 * The headings of a vote, of the attendance and of a decision, in comparison
 * form without dots: «ΥΠΕΡ (22)», «ΚΑΤΑ», «ΛΕΥΚΑ (3)», «ΑΠΟΧΗ», «ΑΠΟΝΤΕΣ (13)»,
 * «Αρ. Απόφασης». They follow the label grammar and they repeat at each
 * decision, but nobody speaks under them.
 */
const RECORD_HEADING = /^(υπερ|κατα|λευκ[οα]|αποχ(η|εσ)|απειχαν|παροντεσ|αποντεσ|αρ(ιθ(μ(οσ)?)?)? αποφασησ)$/u;
const TRAILING_PARENTHESIS = /\s*\(([^()]{0,100})\)\s*$/u;
/** «(Πρόεδρος Δ.Σ., Λουκογεωργάκης Ευστάθιος)», «(Ομιλητής)»: the whole label in a parenthesis, a comma between its two parts. */
const WHOLE_PARENTHESIS = /^\(([^(),]{1,60})(?:,\s*([^(),]{1,60}))?\)$/u;

export type ParsedLabel = {
    /** The label as printed. */
    raw: string;
    /**
     * The comparison key of the label, shared by «ΠΡΟΕΔΡΟΣ» and «Ο ΠΡΟΕΔΡΟΣ».
     * A role label keeps its parenthesis in the key: «ΑΝΤΙΔΗΜΑΡΧΟΣ (κ. Τράκας)»
     * and «ΑΝΤΙΔΗΜΑΡΧΟΣ (κ. Πέτρου)» are two speakers.
     */
    key: string;
    /** The role the label names, in canonical form, or null for a name label. */
    role: string | null;
    /** The name to look up on the roster, honorifics and parenthesis removed; null for a role label. */
    name: string | null;
    /** The name a role label's parenthesis gives («Δήμαρχος (κ. Γεώργιος Κουτουζής)»), honorifics removed; null otherwise. */
    parenthesisName: string | null;
    /**
     * One mixed-case word with nothing else («Ειδικότερα», «Προτείνει»): the
     * shape of a sentence opener in a pasted decision, which repeats too. Such a
     * label counts only when the roster knows the name.
     */
    bareWord: boolean;
};

/** The name tokens of a label piece: honorifics and dashes dropped. Null when a token fails the grammar. */
function nameTokensOf(tokens: string[]): { nameTokens: string[]; words: string[] } | null {
    const words: string[] = [];
    const nameTokens: string[] = [];
    for (const token of tokens) {
        if (HONORIFIC.test(foldLine(token)) || DASH.test(token)) continue;
        if (INITIAL.test(token) || ABBREVIATED_ROLE_WORD.test(token)) {
            nameTokens.push(token);
            continue;
        }
        if (!WORD.test(token)) return null;
        words.push(token);
        nameTokens.push(token);
    }
    return { nameTokens, words };
}

/**
 * Reads a label candidate: the text before the colon. Returns null when the
 * text does not follow the grammar («ΘΕΜΑ 1ο», «Τηλ.», «Το Δ.Σ. αφού πήρε
 * υπόψη», «ως εξής» all fail it) or is a heading of the record (see
 * RECORD_HEADING). This is the one place that knows what a
 * label is: the check's locator and the speaker resolution read its output.
 */
export function parseLabel(raw: string): ParsedLabel | null {
    let core = raw.trim();
    const whole = WHOLE_PARENTHESIS.exec(core);
    if (whole) {
        const [, first, second] = whole;
        // «(role, name)» reads as «role (name)». When the first part is not a role
        // («Εκπρόσωπος Κατοίκων, Μοάτσου Μαρία»), the name alone is the label.
        const described = second ? parseLabel(first) : null;
        if (second && !described) return null;
        const parsed = parseLabel(!second ? first : described?.role ? `${first.trim()} (${second.trim()})` : second);
        // The parenthesis and the colon mark the label: one word in it is a name («(Δικηγόρος Ιδιοκτήτη, Παπαδάκης)»), not a sentence opener.
        return parsed && { ...parsed, raw: raw.trim(), bareWord: false };
    }
    // «Δήμαρχος (κ. Γεώργιος Κουτουζής)», «ΒΑΝΔΩΡΟΣ Π. (ΥΠΑΛΛΗΛΟΣ ...)»: the parenthesis names or describes, it is not part of the label's grammar.
    const parenthesis = TRAILING_PARENTHESIS.exec(core)?.[1]?.trim() || null;
    core = core.replace(TRAILING_PARENTHESIS, "").trim();
    if (!core || core.length > MAX_LABEL_CHARS) return null;

    let tokens = core.split(/\s+/);
    if (tokens.length > 1 && ARTICLE.test(foldLine(tokens[0]))) tokens = tokens.slice(1);
    if (tokens.length === 0 || tokens.length > MAX_LABEL_TOKENS) return null;

    if (RECORD_HEADING.test(foldLine(tokens.join(" ")).replace(/\./g, ""))) return null;
    const parsed = nameTokensOf(tokens);
    if (!parsed) return null;
    const { nameTokens, words } = parsed;
    const role = canonicalRole(foldLine(nameTokens.join(" ")));
    if (words.length === 0 && role === null) return null;

    const key = foldLine(role && parenthesis ? `${tokens.join(" ")} (${parenthesis})` : tokens.join(" "));
    const bareWord = role === null && tokens.length === 1 && words.length === 1 && words[0] !== words[0].toUpperCase();
    const parenthesisName = role && parenthesis ? nameTokensOf(parenthesis.split(/\s+/))?.nameTokens.join(" ") || null : null;
    return { raw: raw.trim(), key, role, name: role ? null : nameTokens.join(" "), parenthesisName, bareWord };
}

/** The comparison key of any label text, parsed when it follows the grammar and folded otherwise. */
export function labelKey(raw: string): string {
    return parseLabel(raw)?.key ?? foldLine(raw);
}

/**
 * Joins the two lines of a label whose parenthesis wrapped («ΜΑΥΡΟΜΜΑΤΗ Δ.
 * (ΠΡΟΪΣΤΑΜΕΝΗ ΤΜΗΜΑΤΟΣ ... ΑΝΘΡΩΠΙΝΟΥ» / «ΔΥΝΑΜΙΚΟΥ): Όταν ...»), so the
 * label grammar sees the whole label on one line.
 */
export function joinWrappedLabels(lines: SectionLine[]): SectionLine[] {
    const out: SectionLine[] = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const next = lines[i + 1];
        if (next && /^\s*[^():]{1,80}\([^()]*$/u.test(line.text) && /^[^()]{0,60}\)\s*:/u.test(next.text)) {
            out.push({ text: `${line.text.trimEnd()} ${next.text.trimStart()}`, page: line.page });
            i++;
            continue;
        }
        out.push(line);
    }
    return out;
}

/** A line that ends in a hyphen or a soft hyphen before a lower-case continuation: one word the layout broke. */
const BROKEN_WORD = /(\p{L})[-\u00ad]$/u;

/**
 * Rejoins words the page layout broke at a line end («παρακολου-» / «θούντων»).
 * Left apart, the aligner sees two words where we have one and the minutes
 * would seem to correct a spelling.
 */
export function joinBrokenWords(lines: SectionLine[]): SectionLine[] {
    const out: SectionLine[] = [];
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        while (BROKEN_WORD.test(line.text) && lines[i + 1] && /^\p{Ll}/u.test(lines[i + 1].text)) {
            line = { text: line.text.replace(/[-\u00ad]$/u, "") + lines[i + 1].text, page: line.page };
            i++;
        }
        out.push(line);
    }
    return out;
}

export function buildSectionText(lines: SectionLine[]): SectionText {
    const pageStarts: { offset: number; page: number }[] = [];
    let text = "";
    let lastPage: number | null = null;
    for (const line of joinBrokenWords(joinWrappedLabels(lines))) {
        if (line.page !== lastPage) {
            pageStarts.push({ offset: text.length, page: line.page });
            lastPage = line.page;
        }
        text += line.text + "\n";
    }
    return { text, pageStarts };
}

export function pageAt(section: SectionText, offset: number): number {
    let page = section.pageStarts[0]?.page ?? 1;
    for (const start of section.pageStarts) {
        if (start.offset > offset) break;
        page = start.page;
    }
    return page;
}

/** A line of sentence text ends in one of these; a label alone on its line does not. */
const SENTENCE_END = /[.;!?,:…»]$/u;

type Candidate = Boundary & {
    parsed: ParsedLabel;
    /** A role and, on the same line, a name and nothing else: the shape of a field of the title block (see isTitleField). */
    titleField: boolean;
};

/** A word of a name, an initial or a nickname in a parenthesis; in a line of two fields, the label of the second one. */
const TITLE_NAME_TOKEN = /^\(?\p{Lu}[\p{L}'’./-]*\)?:?$/u;
const LEADING_HONORIFIC = /^(κ\.|κα\.?|κος)\s*/u;
const MAX_TITLE_TOKENS = 8;

/**
 * «ΔΗΜΑΡΧΟΣ: ΜΠΑΜΠΑΛΟΣ ΝΙΚΟΛΑΟΣ», «ΠΡΟΕΔΡΟΣ: κ. ΙΩΑΝΝΗΣ ΤΣΑΡΠΑΛΗΣ», «Πρόεδρος
 * ΔΣ Νέων: Αρμάος Μιχάλης»: the title block of many documents names the
 * officers in the grammar of a label. The rest of the line is a name and
 * nothing else: capitalised words, with no sentence punctuation. Two fields
 * can share a line («ΠΡΟΕΔΡΟΣ: ΚΟΡΜΑ Δ. ΓΡΑΜΜΑΤΕΑΣ: ΚΕΦΑΛΑΣ ΕΥΑΓΓΕΛΟΣ»).
 */
function isTitleField(parsed: ParsedLabel, rest: string): boolean {
    return parsed.role !== null && isNameOnly(rest);
}

function isNameOnly(rest: string): boolean {
    const name = rest.trim().replace(LEADING_HONORIFIC, "");
    if (SENTENCE_END.test(name)) return false;
    const tokens = name.split(/\s+/);
    return tokens.length <= MAX_TITLE_TOKENS && tokens.every(t => TITLE_NAME_TOKEN.test(t)) && tokens.filter(t => /\p{L}{3}/u.test(t)).length >= 2;
}

/**
 * Whether the line of a turn start holds, after the label, a name and nothing
 * else. The model check asks this of a turn start it adds before the first
 * turn (see applyCheckAnswers). It does not ask for a role as isTitleField
 * does: the title block also abbreviates one («ΑΝΤ/ΔΡΟΣ: ΓΕΩΡΓΑΚΗΣ ΣΤΑΥΡΟΣ»),
 * and no label grammar reads every abbreviation.
 */
export function namesNoSpeech(text: string, boundary: Boundary): boolean {
    const newline = text.indexOf("\n", boundary.offset);
    const lineEnd = newline < 0 ? text.length : newline;
    return isNameOnly(text.slice(Math.min(boundary.labelEnd, lineEnd), lineEnd));
}

/** Every line that follows the label grammar, with its position. */
export function findLabelCandidates(section: SectionText): Candidate[] {
    const candidates: Candidate[] = [];
    let offset = 0;
    for (const line of section.text.split("\n")) {
        const match = LABEL_LINE.exec(line);
        if (match) {
            const parsed = parseLabel(match[2]);
            if (parsed) {
                const start = offset + match[1].length;
                const labelEnd = offset + line.length - match[3].length;
                candidates.push({ offset: start, labelEnd, label: parsed.raw, key: parsed.key, parsed, titleField: isTitleField(parsed, match[3]) });
            }
        }
        offset += line.length + 1;
    }
    return candidates;
}

export type RosterName = { id: string; name: string };

/**
 * Keeps the candidates that are speaker labels: a label that repeats in the
 * section, names a role, or names a person of the roster. «ΘΕΜΑ 1ο», «ΠΡΟΣ»
 * and «Παρόντες» fail all three. The fields of the title block come before
 * the first turn and are not turns: the first label with speech after it ends
 * the title block, and a later line of the same shape is a turn (a secretary
 * who calls a name).
 */
export function confirmLabels(candidates: Candidate[], roster: RosterName[]): { boundaries: Boundary[]; rejected: string[] } {
    const counts = new Map<string, number>();
    for (const c of candidates) counts.set(c.key, (counts.get(c.key) ?? 0) + 1);
    const resolved = new Map<string, boolean>();
    const resolves = (c: Candidate): boolean => {
        if (!resolved.has(c.key)) resolved.set(c.key, c.parsed.name !== null && matchPersonByName(c.parsed.name, roster) !== null);
        return resolved.get(c.key)!;
    };

    const boundaries: Boundary[] = [];
    const rejected = new Set<string>();
    let titleBlock = true;
    for (const c of candidates) {
        const repeats = (counts.get(c.key) ?? 0) >= 2 && !c.parsed.bareWord;
        const isSpeaker = repeats || c.parsed.role !== null || resolves(c);
        if (!isSpeaker) {
            rejected.add(c.label);
            continue;
        }
        titleBlock &&= c.titleField;
        if (!titleBlock) boundaries.push({ offset: c.offset, labelEnd: c.labelEnd, label: c.label, key: c.key });
    }
    return { boundaries, rejected: [...rejected] };
}

/** A nickname in a list of names: «Κυριακή (Κούλα) Γιαννακίδου». */
const NICKNAME = /\([^()]{1,20}\)/gu;
/** An attendance list is at least this many lines in a row that each hold names and nothing else. */
const MIN_LIST_LINES = 3;
/** The shortest word of a list of names that can be a label: «Ρία» and «Κων.» are not surnames. */
const MIN_NAME_CHARS = 4;
/** The bare style needs this many labels, and this many times the labels of the colon style, before the parser reads it. */
const MIN_BARE_LABELS = 10;
const BARE_TO_COLON = 2;

/** The words of a line that holds two to six names and nothing else, in comparison form; null for any other line. */
function nameListWords(line: string): string[] | null {
    const text = line.replace(NICKNAME, " ").trim();
    if (!text || SENTENCE_END.test(text)) return null;
    const tokens = text.split(/\s+/);
    if (tokens.length < 2 || tokens.length > 6 || !tokens.every(t => WORD.test(t) && t !== t.toUpperCase())) return null;
    return tokens.map(foldLine);
}

/**
 * The second label style (Θεσσαλονίκη): the label stands alone on a line with
 * no colon, and the speech starts on the next line. Without a colon the label
 * grammar alone accepts «Λοιπόν» and «Ναι», so a bare line is a label only when
 * it names a role, a person of the roster, or a person of the document's own
 * attendance list (lines in a row that hold names and nothing else). A label
 * has speech on both sides: a bare line next to another bare line is a list.
 */
export function findBareLabels(section: SectionText, roster: RosterName[]): Boundary[] {
    const lines = section.text.split("\n");
    const listWords = lines.map(nameListWords);
    const known = new Set<string>();
    for (let i = 0; i < lines.length; i++) {
        let end = i;
        while (end < lines.length && listWords[end]) end++;
        if (end - i >= MIN_LIST_LINES) for (const words of listWords.slice(i, end)) for (const w of words ?? []) if (w.length >= MIN_NAME_CHARS) known.add(w);
        i = Math.max(i, end - 1);
    }

    const labels = lines.map(line => {
        const text = line.trim();
        // A whole line in a parenthesis is a note of the secretary («(Αποχώρησαν ... οι Δ.Σ. Μ. Κούπκας, Β. Τομπουλίδης)»).
        if (!text || SENTENCE_END.test(text) || text.includes(":") || text.startsWith("(")) return null;
        const parsed = parseLabel(text);
        if (!parsed) return null;
        if (parsed.role !== null) return parsed;
        const words = (parsed.name ?? "").split(/\s+/).map(foldLine).filter(w => !INITIAL.test(w) && w.length >= MIN_NAME_CHARS);
        const inList = words.length > 0 && words.every(w => known.has(w));
        return inList || (parsed.name !== null && matchPersonByName(parsed.name, roster) !== null) ? parsed : null;
    });

    const boundaries: Boundary[] = [];
    let offset = 0;
    lines.forEach((line, i) => {
        const parsed = labels[i];
        if (parsed && !labels[i - 1] && !labels[i + 1] && !listWords[i - 1] && !listWords[i + 1]) {
            const start = offset + (line.length - line.trimStart().length);
            boundaries.push({ offset: start, labelEnd: offset + line.length, label: parsed.raw, key: parsed.key });
        }
        offset += line.length + 1;
    });
    return boundaries;
}

/** What a secretary writes where there is no speech to transcribe. */
const STAGE_WORDS = /διαλογικ|μικροφων|ακουγ|ακουστ|παρεμβασ|χειροκροτ|γελι|θορυβ|διακοπ|διαλειμμα|παυση|σημειωση|ακαταληπτ|απομαγνητοφων|προσηλθ|αποχωρ|προσελευσ|ταυτοχρον|ομιλ|φωνεσ|συζητησ|ηχογραφ|εγγραφ/u;
const PARENTHESIS = /\(([^()]{0,160})\)/gu;
const BRACKETS = /\[[^\[\]]{0,40}\]/gu;

/** Removes stage directions («(Διαλογικές συζητήσεις)», «…(δεν ακούγεται καθαρά)...», «[…]») and counts them. */
export function stripStageDirections(text: string): { text: string; count: number } {
    let count = 0;
    const withoutParentheses = text.replace(PARENTHESIS, (whole, inner: string) => {
        if (!STAGE_WORDS.test(foldLine(inner))) return whole;
        count++;
        return " ";
    });
    const cleaned = withoutParentheses.replace(BRACKETS, () => {
        count++;
        return " ";
    });
    return { text: cleaned, count };
}

/** The turns the boundaries cut: each runs from its label to the next boundary. */
export function cutTurns(section: SectionText, boundaries: Boundary[]): Turn[] {
    const sorted = [...boundaries].sort((a, b) => a.offset - b.offset);
    return sorted.map((b, i) => {
        const end = sorted[i + 1]?.offset ?? section.text.length;
        const { text, count } = stripStageDirections(section.text.slice(b.labelEnd, end));
        return { index: i, label: b.label, key: b.key, page: pageAt(section, b.offset), offset: b.offset, text: text.trim(), stageDirections: count };
    });
}

/** Share (0–1) of the section's non-blank characters that fall inside a turn. */
export function coverage(section: SectionText, turns: Turn[]): number {
    const nonBlank = (s: string) => s.replace(/\s+/g, "").length;
    const total = nonBlank(section.text);
    if (total === 0) return 0;
    const sorted = [...turns].sort((a, b) => a.offset - b.offset);
    let inside = 0;
    sorted.forEach((t, i) => {
        const end = sorted[i + 1]?.offset ?? section.text.length;
        inside += nonBlank(section.text.slice(t.offset, end));
    });
    return inside / total;
}

export type ParsedTurns = {
    section: SectionText;
    boundaries: Boundary[];
    turns: Turn[];
    /** Candidate labels the parser did not accept as speakers. */
    rejectedLabels: string[];
};

/** The deterministic pass: candidates, confirmation, turns. */
export function parseTurns(lines: SectionLine[], roster: RosterName[]): ParsedTurns {
    const section = buildSectionText(lines);
    const colon = confirmLabels(findLabelCandidates(section), roster);
    const bare = findBareLabels(section, roster);
    const readBare = bare.length >= MIN_BARE_LABELS && bare.length > BARE_TO_COLON * colon.boundaries.length;
    const boundaries = readBare ? [...colon.boundaries, ...bare].sort((a, b) => a.offset - b.offset) : colon.boundaries;
    return { section, boundaries, turns: cutTurns(section, boundaries), rejectedLabels: colon.rejected };
}

/**
 * The share of the section's text that must fall inside speaker turns. Below
 * it the document is not verbatim minutes the parser can read, and the task
 * fails with the reason. A starting value: the council minutes we read measure
 * 91% to 99.9%, and one Πόρος document 84.5% because its contents page,
 * invitation and attendance list are 15% of its 19 pages. The committee
 * documents that are decisions with a few turns measure 59% and 67%.
 */
export const COVERAGE_FLOOR = 0.8;
