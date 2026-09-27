import Anthropic from '@anthropic-ai/sdk';
import { aiChat, ResultWithUsage, NO_USAGE, addUsage, HAIKU_MODEL } from '../../lib/ai.js';
import type { AttendancePhase, StatedName, StatedPresence, StatedPresentList } from '../../types.js';
import { PDFDocument } from 'pdf-lib';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { sameDecisionNumber } from './decisionNumberCompare.js';
import type { DecisionWarning } from './decisionValidation.js';

// --- PDF download ---

export function adaToPdfUrl(ada: string): string {
    return `https://diavgeia.gov.gr/doc/${encodeURIComponent(ada)}`;
}

export async function downloadPdfAsBuffer(source: string): Promise<Buffer> {
    // Local file path
    if (source.startsWith('/') || source.startsWith('./') || source.startsWith('../')) {
        const filePath = decodeURIComponent(source);
        console.log(`Reading local file: ${filePath}...`);
        const buffer = fs.readFileSync(filePath);
        console.log(`Read file: ${(buffer.length / 1024).toFixed(0)} KB`);
        return buffer;
    }

    console.log(`Downloading file from ${source}...`);
    const response = await fetch(source);
    if (!response.ok) {
        throw new Error(`Failed to download PDF from ${source}: HTTP ${response.status} ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    console.log(`Downloaded file: ${(buffer.length / 1024).toFixed(0)} KB`);
    return buffer;
}

/** @deprecated Use downloadPdfAsBuffer instead */
export async function downloadPdfToBase64(source: string): Promise<string> {
    const buffer = await downloadPdfAsBuffer(source);
    return buffer.toString('base64');
}

// PDF page selection lives in pdfPages.ts; imported for use below and
// re-exported so existing callers keep importing it from here.
import { describePageRanges, extractPdfPages, extractPdfPageSet, headAndTailPages } from './pdfPages.js';
export { extractPdfPages, extractPdfPageSet, headAndTailPages };

// --- Extraction cache ---
// Caches Claude extraction results per PDF URL to avoid re-downloading and re-processing
// during iterative development. Uses a fixed path so it persists across nix-shell sessions.

const CACHE_DIR = '/tmp/opencouncil-decisions-cache';

function getCachePath(pdfUrl: string, prefix: string): string {
    const hash = crypto.createHash('sha256').update(pdfUrl).digest('hex').slice(0, 16);
    return path.join(CACHE_DIR, `${prefix}${hash}.json`);
}

export function readCache<T>(pdfUrl: string, prefix = 'decision-'): T | null {
    const cachePath = getCachePath(pdfUrl, prefix);
    try {
        const data = fs.readFileSync(cachePath, 'utf-8');
        console.log(`Cache hit for ${pdfUrl}`);
        return JSON.parse(data) as T;
    } catch {
        return null;
    }
}

export function writeCache<T>(pdfUrl: string, data: T, prefix = 'decision-'): void {
    try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(getCachePath(pdfUrl, prefix), JSON.stringify(data, null, 2));
    } catch (err) {
        console.warn('Failed to write extraction cache:', err);
    }
}

// --- PDF extraction types ---

export type AgendaItemRef = {
    agendaItemIndex: number;
    nonAgendaReason: 'outOfAgenda' | null;  // null = regular agenda item
};

/**
 * What a document pins an attendance change to — the vocabulary of the page, as
 * read. It is not the wire vocabulary: `wireAnchor` maps it to
 * `AttendanceAnchorKind` in types.ts, which has `subject` where this has
 * `this_document` and no `this_document` of its own.
 */
export type DocumentAnchorKind =
    | 'agenda_item' | 'decision_number' | 'phase' | 'this_document' | 'session_start' | 'session_end';

export interface AttendanceAnchor {
    kind: DocumentAnchorKind;
    agendaItem: AgendaItemRef | null;      // when kind is agenda_item
    decisionNumber: string | null;         // when kind is decision_number, e.g. "286"; the first number of a range
    /** The last number when the page names a range («στις με αρ. 31 – 40» → "40"); absent on readings from before ranges were read. */
    decisionNumberTo?: string | null;
    phase: AttendancePhase | null;         // when kind is phase: the block the page names
    timing: 'before' | 'during' | 'after' | null;
}

export interface AttendanceChange {
    name: string;
    /** absent_for_vote: «Κατά τη διαδικασία της ψηφοφορίας απουσίαζε…» — out for the decisions the anchor names (this document's, or a range). */
    type: 'arrival' | 'departure' | 'absent_for_vote';
    agendaItem: AgendaItemRef | null;      // null = session-level (start/end) or anchored elsewhere
    timing: 'during' | 'after' | null;     // null when agendaItem is null
    /** Absent on cached extractions from before anchors existed; readers must tolerate that. */
    anchor?: AttendanceAnchor;
    rawText: string;
}

/** The anchor of a change, reconstructed for extractions cached before anchors existed. */
export function changeAnchor(change: AttendanceChange): AttendanceAnchor {
    if (change.anchor) return change.anchor;
    if (change.type === 'absent_for_vote') return { kind: 'this_document', agendaItem: null, decisionNumber: null, phase: null, timing: null };
    if (change.agendaItem) return { kind: 'agenda_item', agendaItem: change.agendaItem, decisionNumber: null, phase: null, timing: change.timing };
    return { kind: change.type === 'arrival' ? 'session_start' : 'session_end', agendaItem: null, decisionNumber: null, phase: null, timing: null };
}

export type VoteValue = 'FOR' | 'AGAINST' | 'ABSTAIN' | 'PRESENT' | 'DID_NOT_VOTE';

/**
 * Raw shape returned by the LLM. The attendance section varies by PDF format:
 * - "composition_and_absent": PDF lists all members (ΣΥΝΘΕΣΗ) + absent separately
 * - "explicit_present_absent": PDF has explicit ΠΑΡΟΝΤΕΣ / ΑΠΟΝΤΕΣ lists
 */
interface RawLlmExtraction {
    attendanceFormat: 'composition_and_absent' | 'explicit_present_absent';
    /** All council members listed in ΣΥΝΘΕΣΗ — only when attendanceFormat is "composition_and_absent" */
    compositionMembers: string[] | null;
    /** Members from ΠΑΡΟΝΤΕΣ list — only when attendanceFormat is "explicit_present_absent" */
    presentMembers: string[] | null;
    /** Members from ΑΠΟΝΤΕΣ / "απουσίαζαν" list — always present */
    absentMembers: string[];
    mayorPresent: StatedPresence | null;
    decisionExcerpt: string;
    decisionNumber: string | null;
    references: string;
    voteResult: string | null;
    voteDetails: { name: string; vote: VoteValue }[];
    attendanceChanges: LlmAttendanceChange[];
    discussionOrder: AgendaItemRef[] | null;
    subjectInfo: AgendaItemRef | null;
    incomplete: boolean;
    /** Who presided in the mayor's or president's place; name "" when the page says nothing. */
    presidedBy: StatedName;
    /** Who kept the minutes in the secretary's place («εκτελούσα χρέη Γραμματέα»); name "" when the page says nothing. */
    actingSecretary: StatedName;
    /** The item heading as printed («ΘΕΜΑ 3ο», «1ο ΕΚΤΑΚΤΟ ΘΕΜΑ»); "" when the page prints no item number for this decision. */
    subjectHeading: string;
    /** The members listed as present for THIS decision after the decision text (ΤΑ ΜΕΛΗ); empty when the page prints no such list. */
    decisionAttendance: StatedPresentList;
    /** Counts printed in the vote phrase; -1 for a value the page does not count. */
    voteTally: Record<VoteValue, number>;
    /** Only on a read of part of the document: the pages end before this decision's closing block does. */
    closingBlockContinues?: boolean;
}

/**
 * The change as the model returns it. Structured outputs cap the number of
 * nullable parameters per schema, so "not applicable" is an empty string,
 * a zero or "none" here and becomes null in normalizeExtraction.
 */
interface LlmAttendanceChange {
    name: string;
    type: 'arrival' | 'departure' | 'absent_for_vote';
    anchor: {
        kind: DocumentAnchorKind;
        agendaItemIndex: number;      // 0 when kind is not agenda_item
        outOfAgenda: boolean;
        decisionNumber: string;       // "" when not decision_number
        decisionNumberTo: string;     // "" unless the page names a range of decisions
        phase: AttendancePhase | 'none';  // 'none' when kind is not phase
        timing: 'before' | 'during' | 'after' | 'none';
    };
    rawText: string;
}

function fromLlmChange(c: LlmAttendanceChange): AttendanceChange {
    const a = c.anchor;
    const agendaItem: AgendaItemRef | null = a.kind === 'agenda_item' && a.agendaItemIndex > 0
        ? { agendaItemIndex: a.agendaItemIndex, nonAgendaReason: a.outOfAgenda ? 'outOfAgenda' : null }
        : null;
    const anchor: AttendanceAnchor = {
        kind: a.kind,
        agendaItem,
        decisionNumber: a.kind === 'decision_number' && a.decisionNumber ? a.decisionNumber : null,
        decisionNumberTo: a.kind === 'decision_number' && a.decisionNumberTo ? a.decisionNumberTo : null,
        phase: a.kind === 'phase' && a.phase !== 'none' ? a.phase : null,
        timing: a.timing === 'none' ? null : a.timing,
    };
    // «Πριν» means the member was not there for the item, which is what 'during' has always meant here.
    const timing: 'during' | 'after' | null = agendaItem ? (anchor.timing === 'after' ? 'after' : 'during') : null;
    return { name: c.name, type: c.type, agendaItem, timing, anchor, rawText: c.rawText };
}

/**
 * Normalize the LLM extraction into the standard shape used by the pipeline.
 * When the PDF uses "composition + absent" format, computes present = composition - absent
 * so the LLM doesn't have to do any subtraction.
 */
export function normalizeExtraction(raw: RawLlmExtraction): RawExtractedDecision {
    let presentMembers: string[];
    let absentMembers = raw.absentMembers || [];

    if (raw.attendanceFormat === 'composition_and_absent') {
        if (raw.compositionMembers && raw.compositionMembers.length > 0) {
            // Compute present = composition - absent. Absentees are often printed
            // abbreviated («Αθανασάκης Σ.») against a spelled-out composition.
            presentMembers = raw.compositionMembers.filter(n => !greekNameInList(n, absentMembers));
        } else {
            console.warn('⚠ LLM returned attendanceFormat "composition_and_absent" but compositionMembers is empty — attendance may be incomplete');
            presentMembers = raw.presentMembers || [];
        }
    } else {
        presentMembers = raw.presentMembers || [];
    }
    // Whatever the layout, a member the page lists as absent is not present:
    // the model has been seen returning the whole ΣΥΝΘΕΣΗ as the present list.
    presentMembers = presentMembers.filter(n => !greekNameInList(n, absentMembers));

    // The anchor is the fact; agendaItem/timing are its agenda-item projection,
    // kept for every reader that predates anchors.
    const attendanceChanges = (raw.attendanceChanges || []).map(fromLlmChange);

    const VOTE_VALUES: VoteValue[] = ['FOR', 'AGAINST', 'ABSTAIN', 'PRESENT', 'DID_NOT_VOTE'];
    const voteTally = Object.fromEntries(VOTE_VALUES.map(k => [k, raw.voteTally?.[k] >= 0 ? raw.voteTally[k] : null])) as Record<VoteValue, number | null>;

    return {
        attendanceFormat: raw.attendanceFormat,
        compositionMembers: raw.compositionMembers,
        presentMembers,
        absentMembers,
        mayorPresent: raw.mayorPresent,
        presidedBy: raw.presidedBy?.name ? raw.presidedBy : null,
        actingSecretary: raw.actingSecretary?.name ? raw.actingSecretary : null,
        // The heading is kept as a fact beside the number, not as a gate on it:
        // nulling the number whenever the heading came back empty cost 15 correct
        // numbers on the fixture (the reader takes the number from places it does
        // not call a heading) and fixed none of the five invented ones.
        subjectInfo: raw.subjectInfo,
        subjectHeading: raw.subjectHeading?.trim() ?? '',
        voteTally,
        decisionAttendance: raw.decisionAttendance?.present?.length ? raw.decisionAttendance : null,
        decisionExcerpt: raw.decisionExcerpt,
        decisionNumber: raw.decisionNumber,
        references: raw.references,
        voteResult: raw.voteResult,
        voteDetails: raw.voteDetails,
        attendanceChanges,
        discussionOrder: raw.discussionOrder,
        incomplete: raw.incomplete,
    };
}

export interface RawExtractedDecision {
    /** The layout the page used and the composition it printed, when it printed one. */
    attendanceFormat: 'composition_and_absent' | 'explicit_present_absent';
    compositionMembers: string[] | null;
    presentMembers: string[];
    absentMembers: string[];
    mayorPresent: StatedPresence | null;
    decisionExcerpt: string;
    decisionNumber: string | null;
    references: string;
    voteResult: string | null;
    voteDetails: { name: string; vote: VoteValue }[];
    attendanceChanges: AttendanceChange[];
    /** Kept as a document fact, read only by the CLI — deliberately not on the wire. */
    discussionOrder: AgendaItemRef[] | null;
    subjectInfo: AgendaItemRef | null;
    incomplete: boolean;
    presidedBy: StatedName | null;
    actingSecretary: StatedName | null;
    /** The item heading as printed; "" when the page prints none, in which case subjectInfo is null. */
    subjectHeading: string;
    voteTally: Record<VoteValue, number | null>;
    /** The page's own list of who was present for this decision (ΤΑ ΜΕΛΗ after the decision), never the opening roll call. */
    decisionAttendance: StatedPresentList | null;
}

// --- PDF parsing with Claude ---

const EXTRACTION_SYSTEM_PROMPT = `You are a document parser for Greek municipal council decision PDFs (Αποφάσεις Δημοτικού Συμβουλίου).

Extract the following information from the PDF:

1. **attendanceFormat**: How attendance is structured in this PDF. One of:
   - "composition_and_absent" — The PDF has a "ΣΥΝΘΕΣΗ ΔΗΜΟΤΙΚΟΥ ΣΥΜΒΟΥΛΙΟΥ" section listing ALL council members, followed by a separate "απουσίαζαν" / "ΑΠΟΝΤΕΣ" section listing absent members.
   - "explicit_present_absent" — The PDF has separate "Παρόντες" / "ΠΑΡΟΝΤΕΣ" and "Απόντες" / "ΑΠΟΝΤΕΣ" lists, OR a sentence naming who was present ("Παρόντες κατά την έναρξη της συνεδρίασης ήταν …"). A sentence that names the present members wins over any roster printed above it: use "explicit_present_absent" and copy exactly the names it gives.
   A committee roster split into "ΤΑΚΤΙΚΑ" and "ΑΝΑΠΛΗΡΩΜΑΤΙΚΑ" (regular and substitute members) is NOT an attendance list: substitutes are present only when the document names them as present (e.g. "ΠΟΛΙΤΗΣ ΘΩΜΑΣ (αναπλ. μέλος)"). Never count the ΑΝΑΠΛΗΡΩΜΑΤΙΚΑ list into compositionMembers.
2. **compositionMembers**: When attendanceFormat is "composition_and_absent", extract ALL names from the ΣΥΝΘΕΣΗ ΔΗΜΟΤΙΚΟΥ ΣΥΜΒΟΥΛΙΟΥ section — this is the complete council membership. Set to null when attendanceFormat is "explicit_present_absent".
3. **presentMembers**: When attendanceFormat is "explicit_present_absent", extract names from the ΠΑΡΟΝΤΕΣ list. Set to null when attendanceFormat is "composition_and_absent".
4. **absentMembers**: Names from the ΑΠΟΝΤΕΣ / "απουσίαζαν" section. Always extract this regardless of format. Do NOT remove someone from this list just because they arrived later (Προσελεύσεις) — that information goes in attendanceChanges.
5. **decisionExcerpt**: The decision text, starting from "ΤΟ Δ.Σ αφού έλαβε υπόψη" or similar phrasing through "ΑΠΟΦΑΣΙΖΕΙ" and the decision content. Include the full decision text — do not skip or omit any sections. Use markdown formatting to preserve structure (tables, bullet points, numbered lists, etc.). When the PDF contains tabular data, render it as a markdown table with all rows including summary/total rows. Not all tables follow the same columnar format — budget amendments may include title-change tables (ΑΠΟ/ΣΕ), revenue limit tables, or other non-standard layouts. Represent these faithfully using the most appropriate markdown structure (table, list, or formatted text). Preserve bold formatting from the PDF — if text is bold in the original, wrap it in **bold** markdown. The "decides" statement (e.g. "ΑΠΟΦΑΣΙΖΕΙ", "Το Δημοτικό Συμβούλιο … αποφασίζει ομόφωνα") must be its own paragraph — keep the full sentence on one line, separated by blank lines from surrounding text, not merged with the decision content that follows.
6. **decisionNumber**: The decision number (Αριθμός Απόφασης), e.g. "231/2025".
7. **references**: The legal bases and references from the "αφού έλαβε υπόψη" or "Έχοντας υπόψη" section. List each reference item. Use markdown formatting (numbered list). If the section just says something generic like "τις σχετικές διατάξεις της Νομοθεσίας", return that text as-is.
8. **voteResult**: The vote result phrase, e.g. "Ομόφωνα", "Κατά πλειοψηφία", "Κατά πλειοψηφία με ψήφους 21 υπέρ και 2 κατά". This is usually found right before or after "ΑΠΟΦΑΣΙΖΕΙ".
9. **voteDetails**: Every person the PDF names with a vote or a declaration. Usually that is only dissenters and declarations; when the page lists those in favour by name ("ΥΠΕΡ ψήφισαν …", "Οι κάτωθι Δημοτικοί Σύμβουλοι έδωσαν θετική ψήφο: …"), list every one of them as FOR too. Never invent a FOR entry for someone the page does not name. For a unanimous decision that names nobody, return an empty array. Some bodies name every voter, those in favour included, only when the vote is split: on such a page list every name it gives; under «Ομόφωνα» the same body names nobody, and the array stays empty. Each entry has "name" (full name) and "vote":
   - "FOR" (ΥΠΕΡ) — voted in favor
   - "AGAINST" (ΚΑΤΑ) — voted against
   - "ABSTAIN" (ΛΕΥΚΟ) — blank vote, no position taken (still a vote)
   - "PRESENT" (ΠΑΡΩΝ/ΠΑΡΟΥΣΑ) — declared physical presence but did not participate in the vote (declaration, not a vote)
   - "DID_NOT_VOTE" (ΑΠΟΧΗ) — declined to participate (declaration, not a vote)
10. **attendanceChanges**: Members who arrived late, left early, or were absent for this decision's vote. Look in "Προσελεύσεις – Αποχωρήσεις" sections, in the attendance preamble (e.g. "Ο κ. Χ απεχώρησε στην 286 ΑΚΣ", "προσήλθε κατά τη συζήτηση του 3ου θέματος"), and at the end of the document ("Κατά τη διαδικασία της ψηφοφορίας απουσίαζε ο κ. Χ"). Include the mayor when the page says the mayor arrived or left («Η Δήμαρχος … προσήλθε στη λήξη της συζήτησης του 8ου θέματος»), with the name as printed. For each person, extract:
   - "name": full name as printed
   - "type": "arrival", "departure", or "absent_for_vote" (the document says the member was out of the room for THIS decision's vote — «απουσίαζε κατά τη διαδικασία της ψηφοφορίας», «απουσίαζαν από την αίθουσα κατά την ψήφιση του θέματος» — or for a range of decisions it names — «Εκτός αιθούσης στις με αρ. 31 – 40 ΑΔΣ»)
   - "anchor": WHAT the document pins the change to. Copy the document; never convert one kind into another.
     - "kind": "agenda_item" (a numbered item: "κατά τη συζήτηση του 3ου θέματος", "μετά το 1ο έκτακτο θέμα"); "decision_number" (a decision number: "στην 286 ΑΚΣ", "μετά την 230 απόφαση"); "phase" (a moment named without an item number: "pre_agenda" for anything before the agenda items — «πριν την έναρξη της ημερήσιας διάταξης», «κατά τις ερωτήσεις της προ ημερησίας», «μετά την ανάδειξη του Προεδρείου», «στην ανάγνωση των δια περιφοράς»; "out_of_agenda" for «κατά τη συζήτηση των θεμάτων εκτός ημερήσιας διάταξης»); "this_document" (for absent_for_vote about this decision; an absent_for_vote that names decision numbers is "decision_number"); "session_start" / "session_end" (arrived at the start or left at the end, nothing more specific)
     - "agendaItemIndex": the item number when kind is "agenda_item", else 0
     - "outOfAgenda": true when that item is ΕΚΤΑΚΤΟ / ΕΚΤΟΣ Η.Δ., else false
     - "decisionNumber": the number as printed (e.g. "286") when kind is "decision_number", else "". For a range, the first number («στις με αρ. 31 – 40» → "31")
     - "decisionNumberTo": the last number of a range («στις με αρ. 31 – 40» → "40"); "" when the page names one decision or kind is not "decision_number"
     - "phase": "pre_agenda" or "out_of_agenda" when kind is "phase", else "none". A printed clock time («ώρα 19:18») is never an anchor: use the item printed with it, or "session_start" when the sentence says only «κατά τη διάρκεια της συνεδρίασης».
     - "timing": "before" ("πριν τη συζήτηση"), "during" ("κατά τη διάρκεια", "κατά τη συζήτηση", "στην 286 ΑΚΣ"), "after" ("μετά τη λήξη", "μετά το 5ο θέμα", "μετά την 230 ΑΚΣ"), or "none" when the kind carries no timing
   - "rawText": the original sentence describing this change
   If no such statements exist, return an empty array.
11. **discussionOrder**: When subjects were discussed out of the standard agenda order (e.g. "Προτάθηκε η αλλαγή σειράς συζήτησης", items reordered, or out-of-agenda items inserted between regular items), extract the full discussion sequence including both regular and out-of-agenda/emergency items. Each entry is an object with:
   - "agendaItemIndex": the item number
   - "nonAgendaReason": "outOfAgenda" if the item is an out-of-agenda/emergency item (ΕΚΤΑΚΤΟ ΘΕΜΑ), otherwise null
   Example: if regular item 1 was discussed first, then 3 out-of-agenda items, then regular item 9 was brought forward, the sequence would be: [{"agendaItemIndex":1,"nonAgendaReason":null},{"agendaItemIndex":1,"nonAgendaReason":"outOfAgenda"},{"agendaItemIndex":2,"nonAgendaReason":"outOfAgenda"},{"agendaItemIndex":3,"nonAgendaReason":"outOfAgenda"},{"agendaItemIndex":9,"nonAgendaReason":null},...].
   Return null if subjects were discussed in standard agenda order with no out-of-agenda items interleaved.
12. **subjectInfo**: The agenda item this decision relates to:
   - "agendaItemIndex": The subject/topic number (e.g., "ΘΕΜΑ 3ο" → 3, "1ο ΕΚΤΑΚΤΟ ΘΕΜΑ" → 1, "ΘΕΜΑ ΕΚΤΟΣ Η.Δ. 2ο" → 2)
   - "nonAgendaReason": "outOfAgenda" if this is an out-of-agenda/emergency item (ΕΚΤΑΚΤΟ ΘΕΜΑ, ΘΕΜΑ ΕΚΤΟΣ Η.Δ., etc.), null for regular agenda items (ΘΕΜΑ Η.Δ., τακτικό θέμα)
   - Return null if the subject/topic number cannot be determined. Return null when the page prints no item number for THIS decision; never infer one from position, from the decision number, or from a "1ο" in a heading that belongs to another item.
   - "subjectHeading" (a separate top-level field): the heading you read the number from, exactly as printed («ΘΕΜΑ 3ο», «1ο ΕΚΤΑΚΤΟ ΘΕΜΑ», «ΘΕΜΑ ΕΚΤΟΣ Η.Δ. 2ο»). Return "" when there is no such heading — a decision that prints only «Αριθμός Απόφασης 129/2026» and calls its item «το παρακάτω θέμα» has no heading and no item number.
13. **mayorPresent**: Whether the city mayor (Δήμαρχος/Δήμαρχο) was present at the session. This is usually stated in a narrative paragraph separate from the council member attendance list. Look for phrases like "Ο/Η Δήμαρχος ... προσκλήθηκε νομίμως και παρέστη" or "Ο/Η Δήμαρχος ... παρών/παρούσα" (present), or "Ο/Η Δήμαρχος ... δεν ήταν παρών/παρούσα" or "απουσίαζε" (absent). Return an object with "present" (boolean) and "rawText" (the original sentence from the PDF describing the mayor's presence/absence). Return null if mayor presence is not mentioned.
14. **incomplete**: Set to true ONLY if the document appears physically truncated — i.e. you can see attendance lists and preamble but the decision section starting with "ΑΠΟΦΑΣΙΖΕΙ" is not present because the provided pages end before reaching it. Set to false if you can see the "ΑΠΟΦΑΣΙΖΕΙ" section, even if some fields within it (like the vote result phrase) are missing or unclear. Missing data in a complete document is a data quality issue, not truncation.

15. **presidedBy**: When the page says someone presided over the session in place of the mayor or the president («ο Αντιπρόεδρος κ. Χ, ο οποίος προήδρευσε λόγω της απουσίας της Δημάρχου», «προεδρεύοντος του Αντιδημάρχου κ. Χ»), return {"name": the full name as printed, "rawText": the sentence}. Presiding means chairing the meeting (προήδρευσε, προεδρεύων, προεδρεύοντος). A deputy standing in for the absent mayor in the mayor's capacity («του Δημάρχου απουσιάζοντος και αναπληρούμενου από τον Αντιδήμαρχο κ. Χ») is NOT presiding unless the page also says he chaired; the session's usual president still presides. Otherwise {"name": "", "rawText": ""}.

16. **actingSecretary**: When the page says someone kept the minutes in the secretary's place («Η εκτελούσα χρέη Γραμματέα κα. Χ», «χρέη γραμματέα εκτέλεσε ο κ. Χ»), return {"name": the full name as printed, "rawText": the sentence}. Otherwise {"name": "", "rawText": ""}.

17. **voteTally**: The counts printed in the vote phrase, per value: FOR (υπέρ / θετικές ψήφοι), AGAINST (κατά / αρνητικές), ABSTAIN (λευκά), PRESENT (παρών), DID_NOT_VOTE (αποχή). Use -1 for every value the page does not count. «Κατά πλειοψηφία με 12 υπέρ και 3 κατά» → FOR 12, AGAINST 3, the rest -1. «Ομόφωνα» → all -1. Never count names yourself.

18. **decisionAttendance**: Some bodies print, AFTER the decision text, the members present for THIS decision: a list headed ΤΑ ΜΕΛΗ / ΠΑΡΟΝΤΑ ΜΕΛΗ. Return {"present": the names in that list, "rawText": the heading and its first line}. A list of who had LEFT (ΑΠΟΧΩΡΗΣΑΝΤΕΣ) is not a present list: never put its names in "present". When the page prints no such list, return {"present": [], "rawText": ""}. Never copy the opening roll call (ΠΑΡΟΝΤΕΣ/ΣΥΝΘΕΣΗ at the top) here, and never remove anyone from presentMembers because of this list.

If a field cannot be found, use empty array for lists, empty string for text, and null where indicated.`;
// The output shape itself is not described here — it is enforced by
// EXTRACTION_OUTPUT_SCHEMA via structured outputs, so the prompt only needs
// the field-finding guidance above.

// --- Greek name matching ---

/**
 * Normalize a Greek name for matching: strip diacritics (tonos), remove
 * parenthetical nicknames like "(ΜΠΑΜΠΗΣ)", collapse whitespace, lowercase.
 */
/**
 * Latin letters that are indistinguishable from a Greek letter in the fonts
 * these documents use, folded towards Greek.
 *
 * Municipal templates really do mix them: \u00ab\u0391\u03b3\u03c1o\u03b3\u03b9\u03ac\u03bd\u03bd\u03b7-\u039c\u03bf\u03c5\u03ba\u03c1\u03b9\u03ce\u03c4\u03bf\u03c5\u00bb carries a
 * Latin o in the roll call of `\u03a1\u039f\u03a8\u0398\u03a96\u039c-2\u03a58` and a Greek omicron elsewhere on
 * the same page. Without this, two spellings of one name compare unequal over
 * a character nobody can see \u2014 the matcher drops the person, and the scorer
 * reports a disagreement that flips between runs depending on which occurrence
 * the model happened to read.
 */
const LATIN_TO_GREEK: Record<string, string> = {
    A: '\u0391', B: '\u0392', E: '\u0395', Z: '\u0396', H: '\u0397', I: '\u0399', K: '\u039a', M: '\u039c',
    N: '\u039d', O: '\u039f', P: '\u03a1', T: '\u03a4', X: '\u03a7', Y: '\u03a5',
    a: '\u03b1', e: '\u03b5', i: '\u03b9', k: '\u03ba', o: '\u03bf', p: '\u03c1', t: '\u03c4', x: '\u03c7', y: '\u03c5', v: '\u03bd',
};

export function foldGreekHomoglyphs(s: string): string {
    return s.replace(/[ABEZHIKMNOPTXYaeikoptxyv]/g, c => LATIN_TO_GREEK[c] ?? c);
}

export function normalizeGreekName(name: string): string {
    return foldGreekHomoglyphs(name)
        .replace(/\s*\([^)]*\)\s*/g, ' ')      // strip parenthetical nicknames
        .replace(/[\u2010-\u2015\u2212]/g, ' ')  // normalize Unicode dashes (en-dash, em-dash, etc.) to spaces; preserve ASCII hyphen-minus in compound surnames
        .normalize('NFD')                        // decompose accented chars
        .replace(/[\u0300-\u036f]/g, '')         // strip combining diacriticals (tonos etc.)
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Does `short` name the same person as `full`? Documents abbreviate members
 * as «Αθανασάκης Σ.» or «Καρύδας Δ.-Ε.» while the composition and the roster
 * spell them out. Every whole word of `short` must be a word of `full`, and
 * every initial must open some remaining word of `full`.
 */
export function sameGreekPerson(short: string, full: string): boolean {
    const a = normalizeGreekName(short);
    const b = normalizeGreekName(full);
    if (a === b) return true;
    const words = (n: string) => n.split(/[\s-]+/).filter(Boolean);
    const fullWords = words(b);
    const initials: string[] = [];
    const whole: string[] = [];
    // «Ντ.» and «Μπ.» are one initial each, so a trailing dot marks an initial
    // whatever its length; a bare single letter counts as one too.
    for (const w of words(a)) {
        if (w.endsWith('.')) initials.push(w.slice(0, -1));
        else if (w.length === 1) initials.push(w);
        else whole.push(w);
    }
    if (whole.length === 0) return false;
    const remaining = [...fullWords];
    for (const w of whole) {
        const i = remaining.indexOf(w);
        if (i < 0) return false;
        remaining.splice(i, 1);
    }
    for (const ch of initials) {
        const i = remaining.findIndex(w => w.startsWith(ch));
        if (i < 0) return false;
        remaining.splice(i, 1);
    }
    return true;
}

/** Is `name` listed in `list`, allowing abbreviated forms on either side? */
export function greekNameInList(name: string, list: string[]): boolean {
    return list.some(other => sameGreekPerson(name, other) || sameGreekPerson(other, name));
}

/**
 * Build a sorted token key from a normalized name string.
 */
function buildSortKey(normalized: string): string {
    return normalized
        .replace(/[-–—]/g, ' ')   // treat hyphens as word separators
        .split(/\s+/)
        .filter(Boolean)
        .sort()
        .join(' ');
}

/**
 * Generate token-sort keys for a name. Returns multiple keys when the name
 * contains a parenthetical nickname like "(ΚΩΣΤΗΣ)": one key with the nickname
 * stripped and one with the nickname replacing the preceding name part.
 * This handles Greek naming conventions where the DB may store the informal name
 * (e.g. "Κωστής Παπαναστασόπουλος") while the PDF has the formal name + nickname
 * (e.g. "ΠΑΠΑΝΑΣΤΑΣΟΠΟΥΛΟΣ ΚΩΝΣΤΑΝΤΙΝΟΣ (ΚΩΣΤΗΣ)").
 */
export function tokenSortKeys(name: string): string[] {
    const keys: string[] = [];

    // Key 1: standard — strip nickname entirely
    keys.push(buildSortKey(normalizeGreekName(name)));

    // Key 2: nickname variant — if "(NICKNAME)" is present, replace the word
    // immediately before it with the nickname
    const nicknameMatch = name.match(/(\S+)\s*\(([^)]+)\)/);
    if (nicknameMatch) {
        const replaced = name
            .replace(/\S+\s*\([^)]+\)/, nicknameMatch[2]); // replace "WORD (NICK)" with "NICK"
        const nicknameKey = buildSortKey(normalizeGreekName(replaced));
        if (nicknameKey !== keys[0]) {
            keys.push(nicknameKey);
        }
    }

    return keys;
}

/** Convenience: primary token-sort key (nickname stripped). */
export function tokenSortKey(name: string): string {
    return tokenSortKeys(name)[0];
}

export interface PersonForMatching {
    id: string;
    name: string;
}

interface MatchResult {
    matchedIds: string[];
    unmatched: string[];
}

/**
 * Step 1: Token-sort matching. Handles name order differences, hyphenation,
 * and nickname-as-first-name variants.
 * Returns matched personIds and remaining unmatched raw names.
 */
export function matchMembersToPersonIds(
    rawNames: string[],
    people: PersonForMatching[],
): MatchResult {
    // Build token-sorted lookup: sortedTokens → personId
    // Include all key variants from each person's name
    const lookup = new Map<string, string>();
    for (const person of people) {
        for (const key of tokenSortKeys(person.name)) {
            lookup.set(key, person.id);
        }
    }

    const matchedIds: string[] = [];
    const unmatched: string[] = [];

    for (const rawName of rawNames) {
        const keys = tokenSortKeys(rawName);
        const personId = keys.map(k => lookup.get(k)).find(Boolean) ?? uniqueAbbreviatedMatch(rawName, people);
        if (personId) {
            matchedIds.push(personId);
        } else {
            unmatched.push(rawName);
        }
    }

    return { matchedIds, unmatched };
}

/**
 * «Αθανασάκης Σ.» or «Ευαγγελία Λίλιαν Γαζή» against a roster that spells
 * names fully or without the middle name. Only a unique candidate counts:
 * two Παπαδόπουλοι and an initial is a question for the model, not a match.
 */
function uniqueAbbreviatedMatch(rawName: string, people: PersonForMatching[]): string | null {
    const candidates = people.filter(p => sameGreekPerson(rawName, p.name) || sameGreekPerson(p.name, rawName));
    return candidates.length === 1 ? candidates[0].id : null;
}

/**
 * Step 1: Token-sort match for a single name.
 */
export function matchPersonByName(
    rawName: string,
    people: PersonForMatching[],
): string | null {
    const rawKeys = tokenSortKeys(rawName);
    for (const person of people) {
        const personKeys = tokenSortKeys(person.name);
        for (const rk of rawKeys) {
            for (const pk of personKeys) {
                if (rk === pk) return person.id;
            }
        }
    }
    return uniqueAbbreviatedMatch(rawName, people);
}

// Structured-outputs schema for llmMatchMembers — replaces the '[' assistant
// prefill, which Claude 4.6+ models reject
const MEMBER_MATCH_SCHEMA = {
    type: 'object' as const,
    properties: {
        matches: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    personId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                },
                required: ['name', 'personId'],
                additionalProperties: false,
            },
        },
    },
    required: ['matches'],
    additionalProperties: false,
};

/**
 * Step 2: LLM fallback for names that couldn't be matched by token-sort.
 * Sends unmatched names + available people to haiku for semantic matching.
 */
export async function llmMatchMembers(
    unmatchedNames: string[],
    availablePeople: PersonForMatching[],
): Promise<{ matched: { name: string; personId: string }[]; stillUnmatched: string[]; usage: Anthropic.Messages.Usage }> {
    if (unmatchedNames.length === 0 || availablePeople.length === 0) {
        return { matched: [], stillUnmatched: unmatchedNames, usage: { ...NO_USAGE } };
    }

    console.log(`  LLM matching ${unmatchedNames.length} unmatched names against ${availablePeople.length} people`);

    const { result: response, usage } = await aiChat<{ matches: { name: string; personId: string | null }[] }>({
        systemPrompt: `You are a Greek name matcher for municipal council members.

Match each name from "unmatchedNames" to its corresponding person from "availablePeople".
Names may differ in:
- Word order or missing middle names
- Accents/diacritics (monotonic vs polytonic, missing accents)
- Hyphenation or spacing (e.g. "ΚΩΝΣΤΑΝΤΙΝΑ - ΟΛΥΜΠΙΑ" vs "Κωνσταντίνα-Ολυμπία")
- First-initial abbreviations (e.g., "Ε. Χριστούλη" → "ΕΛΕΝΗ ΧΡΙΣΤΟΥΛΗ", "Κ. Αγγελής" → "ΚΩΝΣΤΑΝΤΙΝΟΣ ΑΓΓΕΛΗΣ"). Match by surname — if the surname is unique among available people, the initial is enough.
- Greek diminutives (υποκοριστικά): official documents use formal/legal names while databases often store the commonly used form. These can be very different from the formal name. Examples: Παρασκευή→Βούλα/Εύη, Ελπινίκη→Νίκη, Κωνσταντίνα→Τάνια/Ντίνα, Κωνσταντίνος→Ντίνος/Κώστας, Ευαγγελία→Εύα/Λίτσα, Δημήτριος→Μήτσος/Τάκης, Γεώργιος→Γιώργος, Αθανάσιος→Θανάσης, Χαράλαμπος→Μπάμπης

**Key strategy**: When the surname matches exactly between an unmatched name and only ONE available person shares that surname, the first name is very likely a diminutive — match them even if the first name looks very different. If multiple available people share the same surname, only match when you can confidently identify the diminutive.

Return one entry in "matches" per unmatched name:
{"matches": [{"name": "<exact name from unmatchedNames>", "personId": "<id from availablePeople or null>"}]}

Rules:
- "name" must be the EXACT string from unmatchedNames
- "personId" must be an id from availablePeople, or null if no match
- When the surname matches exactly, match confidently even if the first name differs significantly (it's almost certainly a diminutive)
- The same personId may be returned for several names. "unmatchedNames" is collected across every document of one meeting, and two documents often spell the same member differently`,
        userPrompt: JSON.stringify({
            unmatchedNames,
            availablePeople: availablePeople.map(p => ({ id: p.id, name: p.name })),
        }),
        outputFormat: { type: 'json_schema', schema: MEMBER_MATCH_SCHEMA },
        model: HAIKU_MODEL,
        label: 'member-match',
    });

    const result = response.matches;

    const matched: { name: string; personId: string }[] = [];
    const stillUnmatched: string[] = [];
    // The model copies ids as text and has been seen splicing two of them into
    // one that exists nowhere; such a row would fail the foreign key downstream
    // and take the whole subject's attendance with it.
    const knownIds = new Set(availablePeople.map(p => p.id));

    // One personId may be claimed by several names. The caller collects the
    // unmatched names of a whole meeting, so two documents spelling one member
    // differently arrive together; rejecting the second spelling would leave it
    // identified by its raw text and split the member across two groups.
    for (const entry of result) {
        if (!entry || typeof entry.name !== 'string' || !entry.name) continue;
        if (entry.personId && !knownIds.has(entry.personId)) {
            console.warn(`  LLM matcher returned an id not in the roster for "${entry.name}": ${entry.personId} — treating as unmatched`);
        }
        if (entry.personId && knownIds.has(entry.personId)) {
            matched.push({ name: entry.name, personId: entry.personId });
        } else {
            stillUnmatched.push(entry.name);
        }
    }

    // Names from input that LLM didn't return at all → still unmatched
    const returnedNames = new Set(result.map(r => r.name));
    for (const name of unmatchedNames) {
        if (!returnedNames.has(name)) {
            stillUnmatched.push(name);
        }
    }

    console.log(`  LLM matched ${matched.length}, still unmatched: ${stillUnmatched.length}`);
    return { matched, stillUnmatched, usage };
}

// --- PDF extraction ---

const EXTRACTION_MODEL = 'claude-sonnet-4-6';

/**
 * Max output tokens for extraction — needs headroom for decisions with large
 * tables (budget amendments, etc.). Structured outputs cannot use aiChat's
 * max_tokens continuation (hitting the cap is a hard failure), so this is
 * Sonnet 4.6's full output ceiling; aiChat streams, so large values don't
 * risk HTTP timeouts.
 */
const EXTRACTION_MAX_TOKENS = 64000;

// Structured-outputs schemas mirroring RawLlmExtraction — they replace the
// '{' assistant prefill, which Claude 4.6+ models reject

const AGENDA_ITEM_REF_SCHEMA = {
    type: 'object' as const,
    properties: {
        agendaItemIndex: { type: 'integer' },
        nonAgendaReason: { anyOf: [{ type: 'string', enum: ['outOfAgenda'] }, { type: 'null' }] },
    },
    required: ['agendaItemIndex', 'nonAgendaReason'],
    additionalProperties: false,
};

/*
 * One schema fragment per stated-fact shape, mirroring StatedName,
 * StatedPresence and StatedPresentList. A field's schema and its TypeScript
 * type have to agree, and there is no fragment left to change on its own.
 */
const STATED_NAME_SCHEMA = {
    type: 'object' as const,
    properties: { name: { type: 'string' }, rawText: { type: 'string' } },
    required: ['name', 'rawText'],
    additionalProperties: false,
};

const STATED_PRESENCE_SCHEMA = {
    type: 'object' as const,
    properties: { present: { type: 'boolean' }, rawText: { type: 'string' } },
    required: ['present', 'rawText'],
    additionalProperties: false,
};

const STATED_PRESENT_LIST_SCHEMA = {
    type: 'object' as const,
    properties: { present: { type: 'array', items: { type: 'string' } }, rawText: { type: 'string' } },
    required: ['present', 'rawText'],
    additionalProperties: false,
};

const EXTRACTION_OUTPUT_SCHEMA = {
    type: 'object' as const,
    properties: {
        attendanceFormat: { type: 'string', enum: ['composition_and_absent', 'explicit_present_absent'] },
        compositionMembers: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
        presentMembers: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
        absentMembers: { type: 'array', items: { type: 'string' } },
        mayorPresent: { anyOf: [STATED_PRESENCE_SCHEMA, { type: 'null' }] },
        decisionExcerpt: { type: 'string' },
        decisionNumber: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        references: { type: 'string' },
        voteResult: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        voteDetails: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    vote: { type: 'string', enum: ['FOR', 'AGAINST', 'ABSTAIN', 'PRESENT', 'DID_NOT_VOTE'] },
                },
                required: ['name', 'vote'],
                additionalProperties: false,
            },
        },
        attendanceChanges: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    type: { type: 'string', enum: ['arrival', 'departure', 'absent_for_vote'] },
                    anchor: {
                        type: 'object',
                        properties: {
                            kind: { type: 'string', enum: ['agenda_item', 'decision_number', 'phase', 'this_document', 'session_start', 'session_end'] },
                            agendaItemIndex: { type: 'integer' },
                            outOfAgenda: { type: 'boolean' },
                            decisionNumber: { type: 'string' },
                            decisionNumberTo: { type: 'string' },
                            phase: { type: 'string', enum: ['pre_agenda', 'out_of_agenda', 'none'] },
                            timing: { type: 'string', enum: ['before', 'during', 'after', 'none'] },
                        },
                        required: ['kind', 'agendaItemIndex', 'outOfAgenda', 'decisionNumber', 'decisionNumberTo', 'phase', 'timing'],
                        additionalProperties: false,
                    },
                    rawText: { type: 'string' },
                },
                required: ['name', 'type', 'anchor', 'rawText'],
                additionalProperties: false,
            },
        },
        discussionOrder: { anyOf: [{ type: 'array', items: AGENDA_ITEM_REF_SCHEMA }, { type: 'null' }] },
        subjectInfo: { anyOf: [AGENDA_ITEM_REF_SCHEMA, { type: 'null' }] },
        incomplete: { type: 'boolean' },
        presidedBy: STATED_NAME_SCHEMA,
        actingSecretary: STATED_NAME_SCHEMA,
        subjectHeading: { type: 'string' },
        decisionAttendance: STATED_PRESENT_LIST_SCHEMA,
        voteTally: {
            type: 'object',
            properties: { FOR: { type: 'integer' }, AGAINST: { type: 'integer' }, ABSTAIN: { type: 'integer' }, PRESENT: { type: 'integer' }, DID_NOT_VOTE: { type: 'integer' } },
            required: ['FOR', 'AGAINST', 'ABSTAIN', 'PRESENT', 'DID_NOT_VOTE'],
            additionalProperties: false,
        },
    },
    required: [
        'attendanceFormat', 'compositionMembers', 'presentMembers', 'absentMembers',
        'mayorPresent', 'decisionExcerpt', 'decisionNumber', 'references',
        'voteResult', 'voteDetails', 'attendanceChanges', 'discussionOrder',
        'subjectInfo', 'incomplete', 'presidedBy', 'actingSecretary', 'subjectHeading', 'voteTally', 'decisionAttendance',
    ],
    additionalProperties: false,
};

/** A read of part of the document: the whole-document schema and the flag that the closing block runs past its pages. */
const PARTIAL_READ_OUTPUT_SCHEMA = {
    ...EXTRACTION_OUTPUT_SCHEMA,
    properties: { ...EXTRACTION_OUTPUT_SCHEMA.properties, closingBlockContinues: { type: 'boolean' } },
    required: [...EXTRACTION_OUTPUT_SCHEMA.required, 'closingBlockContinues'],
};

/** Page count threshold: PDFs with this many pages or fewer are sent whole. */
const SMALL_PDF_THRESHOLD = 10;

/** Initial number of pages to send for large PDFs. */
const INITIAL_PAGES = 5;

/** How many additional pages to add on each retry. */
const PAGE_INCREMENT = 5;

/** Maximum front pages to try before switching to tail extraction. */
const MAX_FRONT_PAGES = 15;

/** Number of pages to try from the end of the document as a last resort. */
const TAIL_PAGES = 5;

/** Tail windows a read may try after the front pages: cost per document stays bounded whatever its page count. */
const MAX_TAIL_WINDOWS = 2;

/** The largest tail window: the size of the last front window. */
const MAX_TAIL_WINDOW_PAGES = MAX_FRONT_PAGES;

/**
 * The size of each tail window: the pages after the front read, split over
 * the tail windows, from TAIL_PAGES up to MAX_TAIL_WINDOW_PAGES.
 *
 * Windows of TAIL_PAGES alone would leave pages 16 to N-10 unread: the
 * Vrilissia decision `ΨΡΖΒΩ9Ρ-Γ1Τ` prints «Αποφασίζει» on page 27 of 38. With
 * this size, every page of a document of up to 45 pages is read. A read makes
 * at most 5 calls and sends at most 60 pages: 5 + 10 + 15 in front and
 * 15 + 15 in the tail. A read whose front pages reach the decision makes at
 * most 5 calls and sends at most 36 pages: 5 + 10 + 15, then
 * CONTINUATION_PAGES and CLOSING_PAGES.
 */
function tailWindowPages(totalPages: number): number {
    return Math.min(MAX_TAIL_WINDOW_PAGES, Math.max(TAIL_PAGES, Math.ceil((totalPages - MAX_FRONT_PAGES) / MAX_TAIL_WINDOWS)));
}

/**
 * Pages read from the end of a document whose decision the front pages already
 * reached, for what the page prints after the decision (`withClosingFacts`).
 *
 * In the local corpus every document with closing facts past page 10 carries
 * them in its last two pages: `6Χ65ΩΞΒ-1ΒΝ` spreads its dissents over pages
 * 11-12 of 12, and `9ΑΙΚΩΞΒ-Υ4Ρ` closes on page 12 of 13 before a page that
 * prints only the ADA. The third page covers both shapes in one document.
 */
const CLOSING_PAGES = 3;

/**
 * Pages read from the last page of the front window on, when the front read
 * says the closing block of its decision runs past it. Argos 359/2025
 * (`62ΟΒΩΨΔ-Ε7Π`, 154 pages) prints names 1-13 of «Τα Μέλη» on page 5 and
 * names 14-20, all five named dissenters among them, on page 6. A front read
 * without hints returned none of names 1-13, so the continuation reads page 5
 * again; that page also prints the number that `withContinuationFacts` checks.
 */
const CONTINUATION_PAGES = 3;

/**
 * A pass has reached the decision only when it says so AND carries text. Long
 * Sparta documents embed earlier decisions in the preamble, and the model
 * reports "complete" on those pages with an empty excerpt.
 */
function reachedTheDecision(result: RawExtractedDecision): boolean {
    return !result.incomplete && (result.decisionExcerpt?.trim().length ?? 0) > 0;
}

/**
 * A later window of a long document may hold the named vote lists the decision
 * window did not (Vrilissia 8/12: ΑΠΟΦΑΣΙΖΕΙ on page 27, the nineteen ΥΠΕΡ and
 * eight «παρών» names on page 37). They are adopted only when they are the same
 * vote: the decision window names nobody in favour and printed a count of at
 * least one that the candidate's named ΥΠΕΡ list matches exactly. An embedded
 * decision of another body (its own count, its own names) never matches and is
 * left where it is.
 *
 * The names are added to the decision window's own rows, not substituted for
 * them. The window that names nobody in favour can still name a dissenter, and
 * replacing the list would drop that person unless the later window happened to
 * reprint them — turning a stated AGAINST into an inferred FOR.
 */
export function adoptLaterVoteNames(winner: RawExtractedDecision, later: RawExtractedDecision[]): RawExtractedDecision {
    const printedFor = winner.voteTally?.FOR ?? null;
    const winnerNamesFor = winner.voteDetails.some(v => v.vote === 'FOR');
    // A printed zero would be matched by the first later window that names
    // nobody in favour, whatever else that window holds.
    if (printedFor == null || printedFor < 1 || winnerNamesFor) return winner;
    const ownNames = winner.voteDetails.map(v => v.name);
    for (const w of later) {
        const namedFor = w.voteDetails.filter(v => v.vote === 'FOR').length;
        const sameCount = w.voteTally?.FOR == null || w.voteTally.FOR === printedFor;
        if (namedFor !== printedFor || !sameCount) continue;
        return { ...winner, voteDetails: withNamedVotes(winner.voteDetails, w.voteDetails) };
    }
    return winner;
}

/** The decision window's own rows, then the rows of another window for people it does not name. */
function withNamedVotes(own: RawExtractedDecision['voteDetails'], other: RawExtractedDecision['voteDetails']): RawExtractedDecision['voteDetails'] {
    const ownNames = own.map(v => v.name);
    return [...own, ...other.filter(v => !greekNameInList(v.name, ownNames))];
}

/**
 * Whether two changes happen at one point of the meeting. Timing is left out:
 * two reads can give one change a different timing, and the app's `anchorKey`
 * groups the pages' changes the same way.
 */
function samePoint(x: AttendanceChange, y: AttendanceChange): boolean {
    const a = changeAnchor(x), b = changeAnchor(y);
    const sameNumber = (m: string | null | undefined, n: string | null | undefined) => (m ?? null) === (n ?? null) || (!!m && !!n && sameDecisionNumber(m, n));
    return a.kind === b.kind && a.phase === b.phase
        && a.agendaItem?.agendaItemIndex === b.agendaItem?.agendaItemIndex && a.agendaItem?.nonAgendaReason === b.agendaItem?.nonAgendaReason
        && sameNumber(a.decisionNumber, b.decisionNumber) && sameNumber(a.decisionNumberTo, b.decisionNumberTo);
}

/**
 * The decision window's own changes, then the changes of another window that it
 * does not state. A member can arrive twice (Orestiada 97ΤΓΩΞΒ-Ψ0Μ: arrives,
 * is out for the vote, returns), so a change repeats one only at the same point.
 */
function withChanges(own: AttendanceChange[], other: AttendanceChange[]): AttendanceChange[] {
    const stated = (c: AttendanceChange) => own.some(f => f.type === c.type && greekNameInList(c.name, [f.name]) && samePoint(f, c));
    return [...own, ...other.filter(c => !stated(c))];
}

/** The model returns "" for a text field the page does not state. */
function statedText(text: string | null): string | null {
    return text?.trim() ? text : null;
}

/** A decision number that can be compared: it holds a digit (C8: a business name read as the number holds none). */
function numberedDecision(decisionNumber: string | null): decisionNumber is string {
    return !!decisionNumber && /\d/.test(decisionNumber);
}

/**
 * Whether the last pages close the decision the front pages read, rather than
 * an attached document: a Δημοτική Επιτροπή decision bound in after a council
 * decision prints its own number and its own count.
 */
function closesTheSameDecision(front: RawExtractedDecision, closing: RawExtractedDecision): boolean {
    if (numberedDecision(front.decisionNumber) && numberedDecision(closing.decisionNumber) && !sameDecisionNumber(front.decisionNumber, closing.decisionNumber)) return false;
    const VOTE_VALUES: VoteValue[] = ['FOR', 'AGAINST', 'ABSTAIN', 'PRESENT', 'DID_NOT_VOTE'];
    return !VOTE_VALUES.some(k => front.voteTally?.[k] != null && closing.voteTally?.[k] != null && front.voteTally[k] !== closing.voteTally[k]);
}

/**
 * The front read with what the last pages of the document state after the
 * decision: named votes, a per-vote absence («Κατά τη διαδικασία της
 * ψηφοφορίας απουσίαζε…»), the members present for this decision, «Η απόφαση
 * έλαβε τον αριθμό …». Papagos ΔΣ `ΡΟ7ΞΩΞ1-85Χ` prints all of them on page 14
 * of 14 and ΑΠΟΦΑΣΙΣΕ on page 8, so a read that stops at page 10 lost them.
 *
 * The closing adds; it never replaces. A fact the front read stated stays, and
 * a named vote is added only for a person the front read does not name, as in
 * `adoptLaterVoteNames`. A front number with no digit is not a stated number,
 * so a closing number with digits takes its place.
 *
 * The member list and the counts are taken from the closing only when it
 * prints the front read's own decision number. An attached document whose last
 * pages print no number and no count cannot be told apart otherwise, and its
 * member list would become this decision's attendance (`9ΔΕ6ΩΞΒ-Λ0Θ` closes its
 * decision on page 7 of 27).
 */
export function withClosingFacts(front: RawExtractedDecision, closing: RawExtractedDecision): RawExtractedDecision {
    if (!closesTheSameDecision(front, closing)) return front;
    const sameNumberPrinted = numberedDecision(front.decisionNumber) && numberedDecision(closing.decisionNumber) && sameDecisionNumber(front.decisionNumber, closing.decisionNumber);
    const decisionNumber = numberedDecision(front.decisionNumber) ? front.decisionNumber
        : numberedDecision(closing.decisionNumber) ? closing.decisionNumber
        : statedText(front.decisionNumber) ?? statedText(closing.decisionNumber);
    return {
        ...front,
        decisionNumber,
        voteResult: statedText(front.voteResult) ?? statedText(closing.voteResult),
        voteTally: hasCountedTally(front.voteTally) || !sameNumberPrinted ? front.voteTally : closing.voteTally,
        voteDetails: withNamedVotes(front.voteDetails, closing.voteDetails),
        attendanceChanges: withChanges(front.attendanceChanges, closing.attendanceChanges),
        decisionAttendance: front.decisionAttendance ?? (sameNumberPrinted ? closing.decisionAttendance : null),
    };
}

/**
 * The front read with what the pages right after it state: the rest of the
 * member list, named votes and changes. It only adds, as `withClosingFacts`
 * does. The number and the counts are filled only when the front read has
 * none. A continuation that prints another decision number is not this
 * decision's closing block.
 */
export function withContinuationFacts(front: RawExtractedDecision, continuation: RawExtractedDecision): RawExtractedDecision {
    if (numberedDecision(front.decisionNumber) && numberedDecision(continuation.decisionNumber) && !sameDecisionNumber(front.decisionNumber, continuation.decisionNumber)) return front;
    const frontList = front.decisionAttendance?.present ?? [];
    const added = (continuation.decisionAttendance?.present ?? []).filter(n => !greekNameInList(n, frontList));
    return {
        ...front,
        decisionNumber: numberedDecision(front.decisionNumber) || !numberedDecision(continuation.decisionNumber) ? front.decisionNumber : continuation.decisionNumber,
        voteTally: hasCountedTally(front.voteTally) ? front.voteTally : continuation.voteTally,
        voteDetails: withNamedVotes(front.voteDetails, continuation.voteDetails),
        attendanceChanges: withChanges(front.attendanceChanges, continuation.attendanceChanges),
        decisionAttendance: added.length === 0 ? front.decisionAttendance
            : { present: [...frontList, ...added], rawText: front.decisionAttendance?.rawText || continuation.decisionAttendance!.rawText },
    };
}

/** Did this pass read any count out of the vote phrase? */
function hasCountedTally(tally: RawExtractedDecision['voteTally'] | undefined): boolean {
    return !!tally && Object.values(tally).some(v => v !== null);
}

/**
 * Bumped whenever the prompt or the output schema changes what a reading means,
 * so a reading in the old shape is never served to code expecting the new one.
 * v4 retired the `clock_time` and `session_phase` anchor kinds and the free-text
 * `phase` that came with them. v5 read the item heading and the acting
 * secretary, and nulled the item number when the heading came back empty; v6
 * keeps the number — the cache holds the normalised result, so the readings
 * v5 nulled had to be retired with it. v7 keys the cache on the mayor name as
 * well; a v6 entry cannot be told apart, because a caller that named the mayor
 * and a caller that did not wrote to the same key. v8 keeps the anchor the page
 * states for a per-vote absence (v7 forced «this document») and reads a range
 * of decision numbers. v9 reads the last pages of a document whose decision the
 * front pages reached, so a v8 reading of a long document may lack what its
 * closing states; it also tells the reader about bodies that name every voter
 * on a split vote only. v10 takes the member list and the counts from the
 * closing pages only when both reads print the same decision number, so a v9
 * entry of a document with an annex may hold the annex's list. v11 sizes the
 * tail windows to the pages the front read left, so a v10 entry of a 26-45
 * page document may be `incomplete` over pages that v11 reads. v12 reads the
 * last page of the front window and up to two pages after it when the front
 * read says the closing block runs past it, so a v11 entry of a long document
 * may lack the rest of its member list and named votes.
 */
export const EXTRACTION_SCHEMA_VERSION = 12;

/** Everything besides the document that steers a reading, and so has to key its cache entry. */
export interface ExtractionSteering {
    /** Steers mayorPresent and presidedBy: the prompt appends "The city mayor is: …". */
    mayorName?: string;
    /** The body's conventions, appended to the prompt verbatim. */
    hints?: string;
}

/**
 * The cache key. Two callers read the same document with different steering —
 * `pollDecisions` names the mayor, the scorer does not — so the steering is part
 * of the key. Without it, whichever ran first owned the entry both read.
 */
export function extractionCacheKey(pdfUrl: string, steering?: ExtractionSteering): string {
    const versioned = `${pdfUrl}#v${EXTRACTION_SCHEMA_VERSION}`;
    const parts = [steering?.mayorName, steering?.hints].filter(Boolean);
    if (parts.length === 0) return versioned;
    return `${versioned}#${crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 8)}`;
}

/** A phase as the retired `session_phase` anchor stated it: the block as the page printed it. */
function phaseFromFreeText(raw: unknown): AttendancePhase | null {
    if (raw === 'pre_agenda' || raw === 'out_of_agenda') return raw;
    if (typeof raw !== 'string' || !raw.trim()) return null;
    // «εκτός ημερησίας διατάξεως» / «Ε.Η.Δ.» name the out-of-agenda block; every
    // other phrase the old prompt produced («προ ημερησίας», «μετά την ψήφιση
    // του κατεπείγοντος») sits before the agenda proper.
    const normalized = normalizeGreekName(raw);
    return normalized.includes('εκτος ημερησ') || /(^|[^α-ω])ε\.?η\.?δ([^α-ω]|$)/.test(normalized) ? 'out_of_agenda' : 'pre_agenda';
}

/** The anchor as v4 declares it, from an anchor a pre-v4 reading stated. */
function migrateAnchor(anchor: AttendanceAnchor): AttendanceAnchor {
    const kind: string = anchor.kind;
    if (kind === 'session_phase') return { ...anchor, kind: 'phase', phase: phaseFromFreeText(anchor.phase) };
    if (kind === 'clock_time') return { ...anchor, kind: 'session_start', phase: null };
    // A free-text phase can ride any kind; only the two enum values are on the wire.
    if (anchor.phase !== null && anchor.phase !== 'pre_agenda' && anchor.phase !== 'out_of_agenda') return { ...anchor, phase: null };
    return anchor;
}

/**
 * The belt to the cache key's braces: entries written on this branch before a
 * field existed are read as absent, and any anchor vocabulary predating v4 is
 * migrated rather than passed onto the wire.
 */
export function withDefaults(raw: RawExtractedDecision): RawExtractedDecision {
    const r = raw as Partial<RawExtractedDecision>;
    return {
        ...raw,
        attendanceFormat: r.attendanceFormat ?? 'explicit_present_absent',
        compositionMembers: r.compositionMembers ?? null,
        presidedBy: r.presidedBy?.name ? r.presidedBy : null,
        actingSecretary: r.actingSecretary?.name ? r.actingSecretary : null,
        // A reading cached before the heading was read keeps its subjectInfo: "" here means "not read", not "no heading".
        subjectHeading: r.subjectHeading ?? '',
        voteTally: r.voteTally ?? { FOR: null, AGAINST: null, ABSTAIN: null, PRESENT: null, DID_NOT_VOTE: null },
        decisionAttendance: r.decisionAttendance?.present?.length ? r.decisionAttendance : null,
        attendanceChanges: (r.attendanceChanges ?? []).map(c => c.anchor ? { ...c, anchor: migrateAnchor(c.anchor) } : c),
    };
}

/** One extraction call over a PDF, whole or in part. */
function readPdfPart(userPrompt: string, documentBase64: string, label: string, schema: typeof PARTIAL_READ_OUTPUT_SCHEMA | typeof EXTRACTION_OUTPUT_SCHEMA = EXTRACTION_OUTPUT_SCHEMA): Promise<ResultWithUsage<RawLlmExtraction>> {
    return aiChat<RawLlmExtraction>({
        systemPrompt: EXTRACTION_SYSTEM_PROMPT,
        userPrompt,
        documentBase64,
        outputFormat: { type: 'json_schema', schema },
        model: EXTRACTION_MODEL,
        maxTokens: EXTRACTION_MAX_TOKENS,
        label,
    });
}

/** What the model is told when it holds only the last pages of a document whose decision was read already. */
function closingPagesNote(pageIndices: number[], totalPages: number): string {
    const pages = `${pageIndices.length === 1 ? 'page' : 'pages'} ${describePageRanges(pageIndices)}`;
    return `Note: You are seeing ${pages} of a ${totalPages}-page document. The decision itself ("ΑΠΟΦΑΣΙΖΕΙ" and its text) was read from the earlier pages. From these pages report only what the document states after the decision: the vote phrase and its counts, every named vote or declaration, members absent for this decision's vote or who left before it, the list of members present for this decision, and the decision number («Η απόφαση έλαβε τον αριθμό …»). Return "" for decisionExcerpt and references, and set "incomplete" to false. If these pages belong to another document (an attached decision of another body, a study, a table), return empty lists and "" or null for every field.`;
}

/** What the model is told when it holds the last page of a front window that ended inside the decision's closing block, and the pages after it. */
function continuationPagesNote(pageIndices: number[], totalPages: number, frontPages: number, decisionNumber: string | null): string {
    const pages = `${pageIndices.length === 1 ? 'page' : 'pages'} ${describePageRanges(pageIndices)}`;
    const decision = statedText(decisionNumber) ? `decision ${decisionNumber}` : 'the decision';
    return `Note: You are seeing ${pages} of a ${totalPages}-page document. The text of ${decision} was read from pages 1-${frontPages}, which end before its closing block does; these pages start at page ${frontPages}. From these pages report only that closing block: the whole list of members present for this decision (ΤΑ ΜΕΛΗ) as these pages print it, every named vote or declaration, members absent for this decision's vote or who left before it, and the decision number if these pages print it. Return "" for decisionExcerpt and references, and set "incomplete" to false. If these pages belong to another document (an attached decision of another body, a study, a table), return empty lists and "" or null for every field. Set "closingBlockContinues" to true if the closing block still continues past page ${pageIndices[pageIndices.length - 1] + 1}.`;
}

export async function extractDecisionFromPdf(pdfUrl: string, mayorName?: string, skipCache?: boolean, hints?: string): Promise<ResultWithUsage<RawExtractedDecision> & { fromCache: boolean; warnings?: DecisionWarning[] }> {
    const cacheKey = extractionCacheKey(pdfUrl, { mayorName, hints });
    if (!skipCache) {
        // Entries written before the warnings were cached have none.
        const cached = readCache<RawExtractedDecision & { warnings?: DecisionWarning[] }>(cacheKey);
        if (cached) {
            const { warnings, ...reading } = cached;
            return { result: withDefaults(reading), usage: { ...NO_USAGE }, fromCache: true, ...(warnings?.length && { warnings }) };
        }
    }

    const pdfBuffer = await downloadPdfAsBuffer(pdfUrl);
    const srcDoc = await PDFDocument.load(pdfBuffer);
    const totalPages = srcDoc.getPageCount();

    const userPromptParts = ['Extract the required information from this Greek municipal council decision PDF.'];
    if (mayorName) {
        userPromptParts.push(`The city mayor is: ${mayorName}`);
    }
    if (hints) {
        userPromptParts.push(hints);
    }
    const userPrompt = userPromptParts.join('\n');

    // Small PDFs: send the whole thing in one call
    if (totalPages <= SMALL_PDF_THRESHOLD) {
        console.log(`  PDF has ${totalPages} pages (≤${SMALL_PDF_THRESHOLD}), sending whole document`);
        const base64 = pdfBuffer.toString('base64');
        const { result: raw, usage } = await readPdfPart(userPrompt, base64, 'decision-extraction');

        const result = normalizeExtraction(raw);
        writeCache(cacheKey, result);
        return { result, usage, fromCache: false };
    }

    // Large PDFs: progressive page loading
    console.log(`  PDF has ${totalPages} pages (>${SMALL_PDF_THRESHOLD}), using progressive extraction`);
    let pagesToSend = INITIAL_PAGES;
    let totalUsage: Anthropic.Messages.Usage = { ...NO_USAGE };
    let lastFrontResult: RawExtractedDecision | null = null;

    while (pagesToSend <= MAX_FRONT_PAGES) {
        const actualPages = Math.min(pagesToSend, totalPages);
        console.log(`  Trying with first ${actualPages}/${totalPages} pages...`);

        const partialBase64 = await extractPdfPages(srcDoc, 0, actualPages);

        const windowed = actualPages < totalPages;
        const partialPrompt = windowed
            ? `${userPrompt}\n\nNote: You are seeing pages 1-${actualPages} of a ${totalPages}-page document. If the decision section ("ΑΠΟΦΑΣΙΖΕΙ") is not visible in these pages because the document is cut off, set "incomplete" to true. If you can see "ΑΠΟΦΑΣΙΖΕΙ" but some details are missing or unclear, set "incomplete" to false. Set "closingBlockContinues" to true when these pages end before this decision's closing block is complete: the list of members (ΤΑ ΜΕΛΗ), the signatures or the named votes continue past page ${actualPages}.`
            : userPrompt;

        const { result: raw, usage } = await readPdfPart(partialPrompt, partialBase64, 'decision-extraction:partial', windowed ? PARTIAL_READ_OUTPUT_SCHEMA : EXTRACTION_OUTPUT_SCHEMA);

        totalUsage = addUsage(totalUsage, usage);
        let result = normalizeExtraction(raw);
        lastFrontResult = result;

        if (reachedTheDecision(result)) {
            console.log(`  Extraction complete with ${actualPages} pages`);
            // The front window stops at the decision; what the page prints
            // after it can sit on pages the window never reached.
            if (actualPages >= totalPages) {
                writeCache(cacheKey, result);
                return { result, usage: totalUsage, fromCache: false };
            }
            const warnings: DecisionWarning[] = [];
            // The continuation takes its pages first; the closing read takes
            // what is left of the last pages.
            const continuationPages = windowed && raw.closingBlockContinues
                ? Array.from({ length: CONTINUATION_PAGES }, (_, i) => actualPages - 1 + i).filter(i => i < totalPages)
                : [];
            const closingPages = headAndTailPages(totalPages, 0, CLOSING_PAGES).filter(i => i >= actualPages && !continuationPages.includes(i));
            console.log(`  closingBlockContinues=${raw.closingBlockContinues ?? '-'} past page ${actualPages}`);
            if (continuationPages.length > 0) {
                console.log(`  Reading the rest of the closing block on pages ${describePageRanges(continuationPages)} of ${totalPages}...`);
                let continuation: ResultWithUsage<RawLlmExtraction>;
                try {
                    continuation = await readPdfPart(
                        `${userPrompt}\n\n${continuationPagesNote(continuationPages, totalPages, actualPages, result.decisionNumber)}`,
                        await extractPdfPageSet(srcDoc, continuationPages),
                        'decision-extraction:continuation',
                        PARTIAL_READ_OUTPUT_SCHEMA,
                    );
                } catch (error) {
                    // As for the closing read: the front read stands, and is not cached.
                    const msg = error instanceof Error ? error.message : String(error);
                    console.warn(`  Continuation read failed, keeping the front read: ${msg}`);
                    return {
                        result, usage: totalUsage, fromCache: false,
                        warnings: [{ code: 'CLOSING_READ_FAILED', severity: 'warning', message: `Pages ${describePageRanges(continuationPages)} of ${totalPages} could not be read (${msg}); the rest of the decision's closing block is missing` }],
                    };
                }
                totalUsage = addUsage(totalUsage, continuation.usage);
                const withContinuation = withContinuationFacts(result, normalizeExtraction(continuation.result));
                console.log(`  Continuation added ${(withContinuation.decisionAttendance?.present.length ?? 0) - (result.decisionAttendance?.present.length ?? 0)} listed members and ${withContinuation.voteDetails.length - result.voteDetails.length} named votes; closingBlockContinues=${continuation.result.closingBlockContinues}`);
                result = withContinuation;
                const lastRead = continuationPages[continuationPages.length - 1];
                if (continuation.result.closingBlockContinues && lastRead + 1 < totalPages && !closingPages.includes(lastRead + 1)) {
                    warnings.push({ code: 'CLOSING_BLOCK_CUT', severity: 'warning', message: `The closing block of the decision continues past page ${lastRead + 1} of ${totalPages}, and the pages after it are not read; the members, named votes or changes that they list are missing` });
                }
            }
            if (closingPages.length === 0) {
                writeCache(cacheKey, { ...result, ...(warnings.length > 0 && { warnings }) });
                return { result, usage: totalUsage, fromCache: false, ...(warnings.length > 0 && { warnings }) };
            }
            console.log(`  Reading the closing on pages ${describePageRanges(closingPages)} of ${totalPages}...`);
            let closing: ResultWithUsage<RawLlmExtraction>;
            try {
                closing = await readPdfPart(
                    `${userPrompt}\n\n${closingPagesNote(closingPages, totalPages)}`,
                    await extractPdfPageSet(srcDoc, closingPages),
                    'decision-extraction:closing',
                );
            } catch (error) {
                // The front read stands on its own. It is not cached, so the
                // next read tries the closing pages again.
                const msg = error instanceof Error ? error.message : String(error);
                console.warn(`  Closing read failed, keeping the front read: ${msg}`);
                return {
                    result, usage: totalUsage, fromCache: false,
                    warnings: [...warnings, { code: 'CLOSING_READ_FAILED', severity: 'warning', message: `Pages ${describePageRanges(closingPages)} of ${totalPages} could not be read (${msg}); what they state after the decision is missing` }],
                };
            }
            const { result: closingRaw, usage: closingUsage } = closing;
            totalUsage = addUsage(totalUsage, closingUsage);
            const withClosing = withClosingFacts(result, normalizeExtraction(closingRaw));
            console.log(`  Closing added ${withClosing.voteDetails.length - result.voteDetails.length} named votes and ${withClosing.attendanceChanges.length - result.attendanceChanges.length} attendance changes`);
            writeCache(cacheKey, { ...withClosing, ...(warnings.length > 0 && { warnings }) });
            return { result: withClosing, usage: totalUsage, fromCache: false, ...(warnings.length > 0 && { warnings }) };
        }
        if (actualPages >= totalPages) {
            console.log(`  Extraction still incomplete after all ${totalPages} pages`);
            const exhausted = { ...result, incomplete: true };
            writeCache(cacheKey, exhausted);
            return { result: exhausted, usage: totalUsage, fromCache: false };
        }

        console.log(`  Incomplete extraction — decision content not found in first ${actualPages} pages, retrying with more...`);
        pagesToSend += PAGE_INCREMENT;
    }

    // Front pages exhausted — walk the unseen pages in windows from the end,
    // because the decision sits at the end and the pages between the front
    // slice and the tail are exactly where 16-19-page documents keep it. The
    // walk stops after MAX_TAIL_WINDOWS: a 317-page document would otherwise
    // take about 60 calls.
    let windowEnd = totalPages;
    const windowPages = tailWindowPages(totalPages);
    const laterWindows: RawExtractedDecision[] = [];
    while (windowEnd > MAX_FRONT_PAGES && laterWindows.length < MAX_TAIL_WINDOWS) {
        const windowStart = Math.max(MAX_FRONT_PAGES, windowEnd - windowPages);
        console.log(`  Front pages exhausted, trying pages ${windowStart + 1}-${windowEnd} of ${totalPages}...`);

        const tailBase64 = await extractPdfPages(srcDoc, windowStart, windowEnd);
        const tailPrompt = `${userPrompt}\n\nNote: You are seeing pages ${windowStart + 1}-${windowEnd} of a ${totalPages}-page document. The earlier pages contained attendance lists and preamble but not the decision section. Extract the decision information from these pages. If the decision section ("ΑΠΟΦΑΣΙΖΕΙ") is not visible in these pages either, set "incomplete" to true.`;

        const { result: tailRaw, usage } = await readPdfPart(tailPrompt, tailBase64, 'decision-extraction:tail');

        totalUsage = addUsage(totalUsage, usage);
        const tailResult = normalizeExtraction(tailRaw);

        if (reachedTheDecision(tailResult)) {
            // Merge: attendance + preamble from front pages, decision data from tail pages.
            // The tail window carries neither the roll call nor the presiding
            // sentence, so every preamble fact falls back to the front read;
            // the decision facts fall back the other way.
            const tailSawRollCall = !!(tailResult.presentMembers?.length || tailResult.absentMembers?.length || tailResult.compositionMembers?.length);
            const merged: RawExtractedDecision = {
                ...tailResult,
                presentMembers: tailResult.presentMembers?.length ? tailResult.presentMembers : lastFrontResult!.presentMembers,
                absentMembers: tailResult.absentMembers?.length ? tailResult.absentMembers : lastFrontResult!.absentMembers,
                attendanceChanges: tailResult.attendanceChanges?.length ? tailResult.attendanceChanges : lastFrontResult!.attendanceChanges,
                mayorPresent: tailResult.mayorPresent ?? lastFrontResult!.mayorPresent,
                discussionOrder: tailResult.discussionOrder ?? lastFrontResult!.discussionOrder,
                subjectInfo: tailResult.subjectInfo ?? lastFrontResult!.subjectInfo,
                attendanceFormat: tailSawRollCall ? tailResult.attendanceFormat : lastFrontResult!.attendanceFormat,
                compositionMembers: tailSawRollCall ? tailResult.compositionMembers : lastFrontResult!.compositionMembers,
                presidedBy: tailResult.presidedBy ?? lastFrontResult!.presidedBy,
                actingSecretary: tailResult.actingSecretary ?? lastFrontResult!.actingSecretary,
                subjectHeading: tailResult.subjectHeading || lastFrontResult!.subjectHeading,
                voteTally: hasCountedTally(tailResult.voteTally) ? tailResult.voteTally : lastFrontResult!.voteTally,
                decisionAttendance: tailResult.decisionAttendance ?? lastFrontResult!.decisionAttendance,
            };
            const withNames = adoptLaterVoteNames(merged, laterWindows);
            if (withNames !== merged) console.log(`  Named votes adopted from a later window (${withNames.voteDetails.length - merged.voteDetails.length} names added to ${merged.voteDetails.length} already read)`);
            console.log(`  Extraction complete from pages ${windowStart + 1}-${windowEnd} (merged with front-page attendance)`);
            writeCache(cacheKey, withNames);
            return { result: withNames, usage: totalUsage, fromCache: false };
        }
        // Windows after the decision are kept: they may hold the vote's named lists.
        laterWindows.push(tailResult);
        console.log(`  Decision content not found in pages ${windowStart + 1}-${windowEnd}`);
        windowEnd = windowStart;
    }

    // Exhausted or capped — return the best partial result, flagged incomplete.
    const unread = windowEnd > MAX_FRONT_PAGES ? `, pages ${MAX_FRONT_PAGES + 1}-${windowEnd} not read` : '';
    console.log(`  Progressive extraction stopped (front ${MAX_FRONT_PAGES} and ${laterWindows.length} tail windows of ${totalPages} pages${unread}), returning partial data`);
    const bestResult: RawExtractedDecision = { ...lastFrontResult!, incomplete: true };
    writeCache(cacheKey, bestResult);
    return { result: bestResult, usage: totalUsage, fromCache: false };
}
