import mammoth from "mammoth";
import type { TextItem, TextMarkedContent } from "pdfjs-dist/types/src/display/api.js";
import { checkDocxExpansion, detectDocumentFormat, downloadBounded, MAX_DOCUMENT_BYTES } from "../documentConversion.js";
import { foldLine } from "./text.js";

/**
 * Reading the municipality's minutes: the text of every page, the section of
 * the meeting we want when the document holds several, and the running
 * headers and page numbers removed from it.
 *
 * The text comes from the PDF's own text layer, never from a model: the
 * minutes of one meeting reach 14 MB and 180 pages, past what a document
 * block carries, and text extraction costs nothing.
 */

/** One page of the document as lines of text. A DOCX has no pages and arrives as page 1. */
export type MinutesPage = { page: number; lines: string[] };

/** A line of the section with the page it was printed on. */
export type SectionLine = { text: string; page: number };

/** The part of the document that records one meeting. */
export type MinutesSection = {
    /** 1-based first page. */
    page: number;
    pages: number;
    /** The section's text, running lines and page numbers removed. */
    lines: SectionLine[];
    /** Running lines and page numbers removed from this section. */
    stripped: number;
    /** YYYY-MM-DD as the section's header states it; null when the header prints no date. */
    date: string | null;
    /** The session number the header states; null when it prints none. */
    sessionNumber: number | null;
};

/** The text layer of a scanned document is empty; below this many letters the document counts as one. */
const MIN_TEXT_CHARS = 200;

/** Text items on one line of a PDF share a baseline; a drop of more than this fraction of the height is a new line. */
const LINE_BREAK_RATIO = 0.5;
/** A horizontal gap wider than this fraction of the height between two items is a space the PDF left out. */
const WORD_GAP_RATIO = 0.25;

const isTextItem = (item: TextItem | TextMarkedContent): item is TextItem => "str" in item;

/**
 * Rebuilds lines from a page's text items. pdf.js hands out positioned runs,
 * not lines: runs that share a baseline join into one line, and a run that
 * starts clear of the previous run's end gets a space in front of it.
 */
export function linesFromTextItems(items: (TextItem | TextMarkedContent)[]): string[] {
    const lines: string[] = [];
    let current = "";
    let lastY: number | null = null;
    let lastEndX: number | null = null;
    let lastHeight = 0;

    const flush = () => {
        if (current.trim()) lines.push(current.replace(/\s+/g, " ").trim());
        current = "";
        lastEndX = null;
    };

    for (const item of items) {
        if (!isTextItem(item)) continue;
        const x = item.transform[4] as number;
        const y = item.transform[5] as number;
        const height = item.height || lastHeight || 10;
        // A superscript ordinal («27ης») sits above the baseline in a smaller
        // font; measured against the larger of the two heights it stays on its line.
        if (lastY !== null && Math.abs(y - lastY) > LINE_BREAK_RATIO * Math.max(height, lastHeight)) flush();
        if (item.str) {
            if (current && lastEndX !== null && x - lastEndX > WORD_GAP_RATIO * height && !/\s$/.test(current)) current += " ";
            current += item.str;
            lastEndX = x + item.width;
        }
        lastY = y;
        lastHeight = height;
        if (item.hasEOL) flush();
    }
    flush();
    return lines;
}

/**
 * The pages of a PDF as lines. pdf.js is loaded here and not at module load:
 * the server imports this module at startup, and pdf.js pulls in a native
 * canvas binding that costs 50 MB and prints warnings on an older Node. Its
 * fake worker runs on the main thread, so the loop yields between pages to
 * let the server answer requests and send progress.
 */
export async function readPdfPages(bytes: Buffer): Promise<MinutesPage[]> {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, disableFontFace: true, isEvalSupported: false, verbosity: 0 });
    const doc = await task.promise;
    try {
        const pages: MinutesPage[] = [];
        for (let p = 1; p <= doc.numPages; p++) {
            const page = await doc.getPage(p);
            const content = await page.getTextContent();
            pages.push({ page: p, lines: linesFromTextItems(content.items) });
            page.cleanup();
            await new Promise<void>(resolve => setImmediate(resolve));
        }
        return pages;
    } finally {
        await doc.destroy();
    }
}

export async function readDocxPages(bytes: Buffer): Promise<MinutesPage[]> {
    checkDocxExpansion(bytes);
    const { value } = await mammoth.extractRawText({ buffer: bytes });
    return [{ page: 1, lines: value.split(/\r?\n/).map(l => l.trim()).filter(Boolean) }];
}

/** Fails when the document has no text to read: a scan, or an empty file. */
export function checkTextLayer(pages: MinutesPage[]): void {
    const letters = pages.reduce((n, p) => n + p.lines.join("").replace(/[^\p{L}]/gu, "").length, 0);
    if (letters < MIN_TEXT_CHARS) throw new Error("scanned document, no text layer");
}

/** The pages of a PDF or a DOCX, with a text layer. Any other format fails with the reason. */
export async function readPages(bytes: Buffer): Promise<MinutesPage[]> {
    const format = detectDocumentFormat(bytes);
    let pages: MinutesPage[];
    if (format === "pdf") pages = await readPdfPages(bytes);
    else if (format === "docx") pages = await readDocxPages(bytes);
    else if (format === "doc") throw new Error("unsupported document format: legacy Word (.doc); provide a PDF or a .docx");
    else throw new Error("unsupported document format: expected a PDF or a .docx");
    checkTextLayer(pages);
    return pages;
}

export async function fetchMinutesPages(url: string): Promise<MinutesPage[]> {
    console.log(`Downloading the minutes from ${url}`);
    const bytes = await downloadBounded(url, MAX_DOCUMENT_BYTES);
    console.log(`Downloaded ${Math.round(bytes.length / 1024)}KB (${detectDocumentFormat(bytes)})`);
    return readPages(bytes);
}

// --- Running headers, footers and page numbers ---

/** Lines this close to the top or the bottom of a page can be a running header or footer. */
const EDGE_LINES = 3;
/** A line is a running line when it recurs at a page edge on this many pages, and at least this share of them. */
const MIN_RUNNING_PAGES = 3;
const MIN_RUNNING_SHARE = 0.2;
/** A running line recurs at the edges; a line that also appears mid-page («ΠΡΟΕΔΡΟΣ: Ναι.») is speech. */
const MIN_EDGE_SHARE = 0.8;

/** The comparison key of a line: folded, with every digit replaced, so «σελ. 5» and «σελ. 6» are one key. */
const runningKey = (line: string): string => foldLine(line).replace(/\d+/g, "#");

const pageNumberOf = (line: string): number | null => (/^\s*\d{1,4}\s*$/.test(line) ? Number(line) : null);

/**
 * The offset between a printed page number and the page index, when the
 * document numbers its pages. The year's minutes of Καλαμαριά run on from
 * 1480; a cover page can leave the first number on page 2. The offset is
 * the one most page edges agree on, or null when too few pages carry one.
 */
function pageNumberOffset(pages: MinutesPage[], minPages: number): number | null {
    const votes = new Map<number, number>();
    for (const { page, lines } of pages) {
        for (const [i, line] of lines.entries()) {
            const atEdge = i < EDGE_LINES || i >= lines.length - EDGE_LINES;
            const value = pageNumberOf(line);
            if (atEdge && value !== null) votes.set(value - page, (votes.get(value - page) ?? 0) + 1);
        }
    }
    const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    return best && best[1] >= minPages ? best[0] : null;
}

/**
 * Removes the lines that repeat from page to page with only a number changing:
 * the municipality's running header, the session title on every other page,
 * the page numbers. They land in the middle of a turn in the extracted text,
 * and the aligner would see them as words the speaker never said. Runs on
 * the pages of one section: a document of several meetings repeats each
 * meeting's title on its own pages only.
 */
export function stripRunningLines(pages: MinutesPage[]): { pages: MinutesPage[]; stripped: number } {
    if (pages.length < MIN_RUNNING_PAGES) return { pages, stripped: 0 };
    const minPages = Math.max(MIN_RUNNING_PAGES, Math.ceil(MIN_RUNNING_SHARE * pages.length));

    const edgePages = new Map<string, Set<number>>();
    const total = new Map<string, number>();
    const edgeCount = new Map<string, number>();
    for (const { page, lines } of pages) {
        lines.forEach((line, i) => {
            const key = runningKey(line);
            if (!key || pageNumberOf(line) !== null) return;
            total.set(key, (total.get(key) ?? 0) + 1);
            if (i < EDGE_LINES || i >= lines.length - EDGE_LINES) {
                edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
                if (!edgePages.has(key)) edgePages.set(key, new Set());
                edgePages.get(key)!.add(page);
            }
        });
    }
    const running = new Set<string>();
    for (const [key, onPages] of edgePages) {
        if (onPages.size >= minPages && edgeCount.get(key)! / total.get(key)! >= MIN_EDGE_SHARE) running.add(key);
    }
    // A page number sits wherever pdf.js put it in the page's reading order, so
    // it is recognised by its value, not by its position.
    const numberOffset = pageNumberOffset(pages, minPages);

    let stripped = 0;
    const cleaned = pages.map(({ page, lines }) => ({
        page,
        lines: lines.filter((line, i) => {
            const atEdge = i < EDGE_LINES || i >= lines.length - EDGE_LINES;
            const drop = (atEdge && running.has(runningKey(line))) || (numberOffset !== null && pageNumberOf(line) === page + numberOffset);
            if (drop) stripped++;
            return !drop;
        }),
    }));
    return { pages: cleaned, stripped };
}

// --- Sections: one per meeting in the document ---

/** Lines at the top of a page that can state which meeting the page opens. */
const HEAD_LINES = 8;

const MONTHS: [RegExp, number][] = [
    [/^ιανουαρ/, 1], [/^φεβρουαρ/, 2], [/^μαρτ/, 3], [/^απριλ/, 4], [/^μαι/, 5], [/^ιουν/, 6],
    [/^ιουλ/, 7], [/^αυγουστ/, 8], [/^σεπτεμβρ/, 9], [/^οκτωβρ/, 10], [/^νοεμβρ/, 11], [/^δεκεμβρ/, 12],
];
const MONTH_WORD = "(ιανουαρ|φεβρουαρ|μαρτ|απριλ|μαι|ιουν|ιουλ|αυγουστ|σεπτεμβρ|οκτωβρ|νοεμβρ|δεκεμβρ)\\p{L}*";
const NUMERIC_DATE = /(?<!\d)(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?!\d)/u;
const WORDED_DATE = new RegExp(`(?<!\\d)(\\d{1,2})\\s*(?:ησ|η|ασ|ου|ο)?\\s+${MONTH_WORD}\\s+(?:του\\s+ετουσ\\s+)?(\\d{4})(?!\\d)`, "u");

const toIsoDate = (day: number, month: number, year: number): string | null =>
    day >= 1 && day <= 31 && month >= 1 && month <= 12 ? `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` : null;

/** The first date a line states, as YYYY-MM-DD: «20/10/2025», «7.10.2026», «20ης Οκτωβρίου 2025», «27 Ιανουαρίου του έτους 2021». */
export function findDate(line: string): string | null {
    const folded = foldLine(line);
    const numeric = NUMERIC_DATE.exec(folded);
    if (numeric) return toIsoDate(Number(numeric[1]), Number(numeric[2]), Number(numeric[3]));
    const worded = WORDED_DATE.exec(folded);
    if (worded) {
        const month = MONTHS.find(([re]) => re.test(worded[2]))?.[1];
        if (month) return toIsoDate(Number(worded[1]), month, Number(worded[3]));
    }
    return null;
}

/** An ordinal («27ης», «1ο») that a month does not follow: «της 20ης Οκτωβρίου» is a date, not a session. */
const ORDINAL = `(\\d{1,3})\\s*(?:ησ|η|ου|ο|ασ|α)(?!\\p{L})(?!\\s*${MONTH_WORD})`;
const SESSION_FORMS: RegExp[] = [
    // «27ης (ΤΑΚΤΙΚΗΣ) ΣΥΝΕΔΡΙΑΣΗΣ», «16η τακτική συνεδρίαση», «ΠΡΑΚΤΙΚΟ 1ο»
    new RegExp(`${ORDINAL}[^\\n]{0,40}?(?:συνεδρ|πρακτικ)`, "u"),
    // «ΣΥΝΕΔΡΙΑΣΗ 20η», «Συνεδρίαση 19η (με τηλεδιάσκεψη)», «ΠΡΑΚΤΙΚΟ 1ο»
    new RegExp(`(?:συνεδρ|πρακτικ)\\p{L}*[^\\n\\d]{0,20}?${ORDINAL}`, "u"),
    // «ΠΡΑΚΤΙΚΟ ΤΗΣ 16/24.07.2017 ΣΥΝΕΔΡΙΑΣΗΣ»
    /πρακτικ\p{L}*\s+τησ\s+(\d{1,3})\s*\/\s*\d{1,2}[./-]\d{1,2}[./-]\d{4}/u,
];

/** The session number a line states next to «συνεδρίαση» or «πρακτικό», or null. */
export function findSessionNumber(line: string): number | null {
    const folded = foldLine(line);
    // An agenda item («ΘΕΜΑ 5ο: Έγκριση πρακτικών 15ης συνεδρίασης») names other meetings.
    if (/^(θεμα|\d+[.)])/.test(folded)) return null;
    for (const form of SESSION_FORMS) {
        const match = form.exec(folded);
        if (match) return Number(match[1]);
    }
    return null;
}

type Header = { sessionNumber: number; date: string | null };

/**
 * A line of speech that continues onto a new page can name another session
 * («το 1ο θέμα είναι η έγκριση των πρακτικών της 26ης συνεδρίασης»). A title
 * has no verb and no particle; a sentence has one of these, or a speaker label.
 */
const SPEECH_LINE = /(?:^[^:]{1,60}:\s)|(?<!\p{L})(?:ειναι|ηταν|να|θα|οτι|που|δεν|μην|εχει|εχουμε|εχω|λεω|λεμε|ειπε|ειπα|θελω|μπορει|πρεπει)(?!\p{L})/u;

/** What the top of a page says about the meeting it opens, when a title line there states a session number. */
function readHeader(lines: string[]): Header | null {
    const head = lines.slice(0, HEAD_LINES).filter(line => !SPEECH_LINE.test(foldLine(line)));
    let sessionNumber: number | null = null;
    let date: string | null = null;
    for (const line of head) {
        sessionNumber ??= findSessionNumber(line);
        date ??= findDate(line);
    }
    return sessionNumber === null ? null : { sessionNumber, date };
}

const sameMeeting = (a: Header, b: Header) => a.sessionNumber === b.sessionNumber && (a.date === null || b.date === null || a.date === b.date);

type PageGroup = { header: Header | null; pages: MinutesPage[] };

/**
 * Cuts the document at the pages whose head states a session number, and
 * groups the pages until the next such head into one section. A cover page
 * and a title page that both state the same session stay in one section; a
 * cover page that states no session belongs to the meeting that follows it.
 * A document whose pages state no session is one section with no identity.
 *
 * The cut comes before the running lines are stripped: in a document of
 * several meetings each meeting's title repeats on its own pages, and
 * stripped first it would take the headers with it.
 */
export function splitSections(pages: MinutesPage[]): MinutesSection[] {
    const groups: PageGroup[] = [];
    let current: PageGroup | null = null;
    for (const page of pages) {
        const header = readHeader(page.lines);
        const startsNew = header !== null && (current?.header == null || !sameMeeting(current.header, header));
        if (startsNew || current === null) {
            current = { header, pages: [] };
            groups.push(current);
        } else if (header && current.header && current.header.date === null) {
            current.header.date = header.date;
        }
        current.pages.push(page);
    }
    if (groups.length > 1 && groups[0].header === null) {
        groups[1].pages.unshift(...groups[0].pages);
        groups.shift();
    }

    return groups.map(group => {
        const { pages: cleaned, stripped } = stripRunningLines(group.pages);
        return {
            page: group.pages[0].page,
            pages: group.pages.length,
            lines: cleaned.flatMap(({ page, lines }) => lines.map(text => ({ text, page }))),
            stripped,
            date: group.header?.date ?? null,
            sessionNumber: group.header?.sessionNumber ?? null,
        };
    });
}

export const describeSection = (s: MinutesSection) =>
    `session ${s.sessionNumber ?? "?"} of ${s.date ?? "an unstated date"} (pages ${s.page}–${s.page + s.pages - 1})`;

/**
 * The one section that records the requested meeting. A section matches when
 * every identity field it states agrees with the request; a section that
 * states nothing matches anything, and a request field of null constrains
 * nothing. None or several matches fail with the reason, before any model call.
 */
export function pickSection(sections: MinutesSection[], meetingDate: string | null, sessionNumber: number | null): MinutesSection {
    const matches = sections.filter(s =>
        (s.date === null || meetingDate === null || s.date === meetingDate) && (s.sessionNumber === null || sessionNumber === null || s.sessionNumber === sessionNumber));
    const wanted = `meeting${meetingDate === null ? "" : ` of ${meetingDate}`}${sessionNumber === null ? "" : `, session ${sessionNumber}`}`;
    if (matches.length === 1) return matches[0];
    const held = sections.map(describeSection).join("; ");
    if (matches.length === 0) throw new Error(`no section of the minutes matches the ${wanted}; the document holds: ${held}`);
    throw new Error(`${matches.length} sections of the minutes match the ${wanted}: ${matches.map(describeSection).join("; ")}`);
}
