import { matchPersonByName } from "../../tasks/utils/decisionPdfExtraction.js";
import type { SectionLine } from "./read.js";
import { foldLine } from "./text.js";

/**
 * Cutting a section of the minutes into speaker turns.
 *
 * Every verbatim document we have read shares one grammar: a turn starts a
 * line with a label and a colon. The label is a role word in capitals
 * («ΠΡΟΕΔΡΟΣ», «ΔΗΜΑΡΧΟΣ») or a short name («Κ. ΤΟΜΠΟΥΛΟΓΛΟΥ», «κα Κανατσίδη»,
 * «ΔΑΡΔΑΜΑΝΕΛΗΣ Θ.»), with an optional parenthesis after it. The parser is
 * deterministic; a model then checks its work (see check.ts).
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
const TRAILING_PARENTHESIS = /\s*\(([^()]{0,100})\)\s*$/u;

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
 * υπόψη», «ως εξής» all fail it). This is the one place that knows what a
 * label is: the check's locator and the speaker resolution read its output.
 */
export function parseLabel(raw: string): ParsedLabel | null {
    let core = raw.trim();
    // «Δήμαρχος (κ. Γεώργιος Κουτουζής)», «ΒΑΝΔΩΡΟΣ Π. (ΥΠΑΛΛΗΛΟΣ ...)»: the parenthesis names or describes, it is not part of the label's grammar.
    const parenthesis = TRAILING_PARENTHESIS.exec(core)?.[1]?.trim() || null;
    core = core.replace(TRAILING_PARENTHESIS, "").trim();
    if (!core || core.length > MAX_LABEL_CHARS) return null;

    let tokens = core.split(/\s+/);
    if (tokens.length > 1 && ARTICLE.test(foldLine(tokens[0]))) tokens = tokens.slice(1);
    if (tokens.length === 0 || tokens.length > MAX_LABEL_TOKENS) return null;

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

type Candidate = Boundary & { parsed: ParsedLabel };

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
                candidates.push({ offset: start, labelEnd, label: parsed.raw, key: parsed.key, parsed });
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
 * and «Παρόντες» fail all three.
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
    for (const c of candidates) {
        const repeats = (counts.get(c.key) ?? 0) >= 2 && !c.parsed.bareWord;
        const isSpeaker = repeats || c.parsed.role !== null || resolves(c);
        if (isSpeaker) boundaries.push({ offset: c.offset, labelEnd: c.labelEnd, label: c.label, key: c.key });
        else rejected.add(c.label);
    }
    return { boundaries, rejected: [...rejected] };
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
    const { boundaries, rejected } = confirmLabels(findLabelCandidates(section), roster);
    return { section, boundaries, turns: cutTurns(section, boundaries), rejectedLabels: rejected };
}

/**
 * The share of the section's text that must fall inside speaker turns. Below
 * it the document is not verbatim minutes the parser can read, and the task
 * fails with the reason. A starting value: the five documents we read measure
 * 95% to 99.8%, and Πόρος 84.5% because its contents page, invitation and
 * attendance list are 15% of a 19-page document.
 */
export const COVERAGE_FLOOR = 0.8;
