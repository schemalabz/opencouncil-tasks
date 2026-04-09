import Anthropic from '@anthropic-ai/sdk';
import { aiChat, ResultWithUsage, NO_USAGE, addUsage } from '../../lib/ai.js';
import { PDFDocument } from 'pdf-lib';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

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

/**
 * Extract a range of pages from a PDF buffer and return as base64.
 * Pages are 0-indexed: extractPages(buf, 0, 5) → first 5 pages.
 */
async function extractPdfPages(pdfBuffer: Buffer, startPage: number, endPage: number): Promise<string> {
    const srcDoc = await PDFDocument.load(pdfBuffer);
    const totalPages = srcDoc.getPageCount();
    const actualEnd = Math.min(endPage, totalPages);

    const newDoc = await PDFDocument.create();
    const pageIndices = Array.from({ length: actualEnd - startPage }, (_, i) => startPage + i);
    const copiedPages = await newDoc.copyPages(srcDoc, pageIndices);
    for (const page of copiedPages) {
        newDoc.addPage(page);
    }

    const pdfBytes = await newDoc.save();
    return Buffer.from(pdfBytes).toString('base64');
}

// --- Extraction cache ---
// Caches Claude extraction results per PDF URL to avoid re-downloading and re-processing
// during iterative development. Uses a fixed path so it persists across nix-shell sessions.

const CACHE_DIR = '/tmp/opencouncil-decisions-cache';

function getCachePath(pdfUrl: string): string {
    const hash = crypto.createHash('sha256').update(pdfUrl).digest('hex').slice(0, 16);
    return path.join(CACHE_DIR, `decision-${hash}.json`);
}

export function readCache<T>(pdfUrl: string): T | null {
    const cachePath = getCachePath(pdfUrl);
    try {
        const data = fs.readFileSync(cachePath, 'utf-8');
        console.log(`Cache hit for ${pdfUrl}`);
        return JSON.parse(data) as T;
    } catch {
        return null;
    }
}

export function writeCache<T>(pdfUrl: string, data: T): void {
    try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(getCachePath(pdfUrl), JSON.stringify(data, null, 2));
    } catch (err) {
        console.warn('Failed to write extraction cache:', err);
    }
}

// --- PDF extraction types ---

export type AgendaItemRef = {
    agendaItemIndex: number;
    nonAgendaReason: 'outOfAgenda' | null;  // null = regular agenda item
};

export interface AttendanceChange {
    name: string;
    type: 'arrival' | 'departure';
    agendaItem: AgendaItemRef | null;      // null = session-level (start/end)
    timing: 'during' | 'after' | null;     // null when agendaItem is null
    rawText: string;
}

export interface RawExtractedDecision {
    presentMembers: string[];
    absentMembers: string[];
    mayorPresent: { present: boolean; rawText: string } | null;
    decisionExcerpt: string;
    decisionNumber: string | null;
    references: string;
    voteResult: string | null;
    voteDetails: { name: string; vote: 'FOR' | 'AGAINST' | 'ABSTAIN' }[];
    attendanceChanges: AttendanceChange[];
    discussionOrder: AgendaItemRef[] | null;
    subjectInfo: AgendaItemRef | null;
    incomplete: boolean;
}

/**
 * Infer FOR votes when the PDF doesn't list them explicitly.
 *
 * Two cases:
 * - **Unanimous** ("Ομόφωνα"): all present members voted FOR, no explicit details needed.
 * - **Majority** ("κατά πλειοψηφία"): only AGAINST/ABSTAIN voters are named;
 *   all present members not in voteDetails are implicitly FOR.
 *
 * Pure function: returns a new voteDetails array (never mutates input) and the
 * number of inferred FOR votes.
 */
export function inferForVotes(
    presentMembers: string[],
    voteResult: string | null,
    voteDetails: { name: string; vote: 'FOR' | 'AGAINST' | 'ABSTAIN' }[],
): { voteDetails: { name: string; vote: 'FOR' | 'AGAINST' | 'ABSTAIN' }[]; inferredCount: number } {
    const isUnanimous = voteResult && /[οό]μ[οό]φων/i.test(voteResult);
    const isMajority = voteResult && /κατ[άα]\s+πλειοψηφ[ίι]/i.test(voteResult);
    const hasNoForVotes = (voteDetails || []).every(v => v.vote !== 'FOR');

    if ((!isUnanimous && !isMajority) || !hasNoForVotes || presentMembers.length === 0) {
        return { voteDetails: [...(voteDetails || [])], inferredCount: 0 };
    }

    const explicitVoterNames = new Set(voteDetails.map(v => v.name));
    const result = [...voteDetails];
    let inferredCount = 0;
    for (const name of presentMembers) {
        if (!explicitVoterNames.has(name)) {
            result.push({ name, vote: 'FOR' });
            inferredCount++;
        }
    }
    return { voteDetails: result, inferredCount };
}

// --- PDF parsing with Claude ---

const EXTRACTION_SYSTEM_PROMPT = `You are a document parser for Greek municipal council decision PDFs (Αποφάσεις Δημοτικού Συμβουλίου).

Extract the following information from the PDF:

1. **presentMembers**: List of council members marked as present (ΠΑΡΟΝΤΕΣ). Extract just their full names.
2. **absentMembers**: List of council members marked as absent (ΑΠΟΝΤΕΣ). Extract just their full names.
3. **decisionExcerpt**: The decision text, starting from "ΤΟ Δ.Σ αφού έλαβε υπόψη" or similar phrasing through "ΑΠΟΦΑΣΙΖΕΙ" and the decision content. Include the full decision text. Use markdown formatting to preserve structure (bullet points, numbered lists, etc.). Preserve bold formatting from the PDF — if text is bold in the original, wrap it in **bold** markdown. The "decides" statement (e.g. "ΑΠΟΦΑΣΙΖΕΙ", "Το Δημοτικό Συμβούλιο … αποφασίζει ομόφωνα") must be its own paragraph — keep the full sentence on one line, separated by blank lines from surrounding text, not merged with the decision content that follows.
4. **decisionNumber**: The decision number (Αριθμός Απόφασης), e.g. "231/2025".
5. **references**: The legal bases and references from the "αφού έλαβε υπόψη" or "Έχοντας υπόψη" section. List each reference item. Use markdown formatting (numbered list). If the section just says something generic like "τις σχετικές διατάξεις της Νομοθεσίας", return that text as-is.
6. **voteResult**: The vote result phrase, e.g. "Ομόφωνα", "Κατά πλειοψηφία", "Κατά πλειοψηφία με ψήφους 21 υπέρ και 2 κατά". This is usually found right before or after "ΑΠΟΦΑΣΙΖΕΙ".
7. **voteDetails**: When the PDF names specific people who voted differently (against or abstained), list them. For unanimous decisions, return an empty array. Each entry has "name" (full name) and "vote" ("FOR", "AGAINST", or "ABSTAIN").
8. **attendanceChanges**: Extract from "Προσελεύσεις – Αποχωρήσεις" or separate "Προσελεύσεις" / "Αποχωρήσεις" sections. These describe members who arrived late or left early. For each person, extract:
   - "name": full name
   - "type": "arrival" or "departure"
   - "agendaItem": The agenda item during/after which this change occurred. Use an object with:
     - "agendaItemIndex": the item number (e.g., "κατά τη συζήτηση του 3ου θέματος" → 3, "μετά το 1ο έκτακτο θέμα" → 1)
     - "nonAgendaReason": "outOfAgenda" if the item is explicitly an out-of-agenda/emergency item (ΕΚΤΑΚΤΟ ΘΕΜΑ, ΘΕΜΑ ΕΚΤΟΣ Η.Δ.), otherwise null
     Set "agendaItem" to null if no specific item is mentioned (person arrived at session start or left at session end).
   - "timing": The temporal relationship to the agenda item:
     - "during" if the change happened DURING the item discussion (e.g., "κατά τη διάρκεια του 9ου θέματος", "κατά τη συζήτηση του 3ου θέματος")
     - "after" if the change happened AFTER the item ended (e.g., "μετά τη λήξη της συζήτησης του 9ου θέματος", "μετά το 5ο θέμα")
     Set to null when "agendaItem" is null (session-level changes).
     The distinction matters: "after item 9" means the person was present and voted on item 9, while "during item 9" means they left/arrived partway through.
   - "rawText": the original sentence describing this change.
   If no such section exists, return an empty array.
9. **discussionOrder**: When subjects were discussed out of the standard agenda order (e.g. "Προτάθηκε η αλλαγή σειράς συζήτησης", items reordered, or out-of-agenda items inserted between regular items), extract the full discussion sequence including both regular and out-of-agenda/emergency items. Each entry is an object with:
   - "agendaItemIndex": the item number
   - "nonAgendaReason": "outOfAgenda" if the item is an out-of-agenda/emergency item (ΕΚΤΑΚΤΟ ΘΕΜΑ), otherwise null
   Example: if regular item 1 was discussed first, then 3 out-of-agenda items, then regular item 9 was brought forward, the sequence would be: [{"agendaItemIndex":1,"nonAgendaReason":null},{"agendaItemIndex":1,"nonAgendaReason":"outOfAgenda"},{"agendaItemIndex":2,"nonAgendaReason":"outOfAgenda"},{"agendaItemIndex":3,"nonAgendaReason":"outOfAgenda"},{"agendaItemIndex":9,"nonAgendaReason":null},...].
   Return null if subjects were discussed in standard agenda order with no out-of-agenda items interleaved.
10. **subjectInfo**: The agenda item this decision relates to:
   - "agendaItemIndex": The subject/topic number (e.g., "ΘΕΜΑ 3ο" → 3, "1ο ΕΚΤΑΚΤΟ ΘΕΜΑ" → 1, "ΘΕΜΑ ΕΚΤΟΣ Η.Δ. 2ο" → 2)
   - "nonAgendaReason": "outOfAgenda" if this is an out-of-agenda/emergency item (ΕΚΤΑΚΤΟ ΘΕΜΑ, ΘΕΜΑ ΕΚΤΟΣ Η.Δ., etc.), null for regular agenda items (ΘΕΜΑ Η.Δ., τακτικό θέμα)
   - Return null if the subject/topic number cannot be determined.
11. **mayorPresent**: Whether the city mayor (Δήμαρχος/Δήμαρχο) was present at the session. This is usually stated in a narrative paragraph separate from the council member attendance list. Look for phrases like "Ο/Η Δήμαρχος ... προσκλήθηκε νομίμως και παρέστη" or "Ο/Η Δήμαρχος ... παρών/παρούσα" (present), or "Ο/Η Δήμαρχος ... δεν ήταν παρών/παρούσα" or "απουσίαζε" (absent). Return an object with "present" (boolean) and "rawText" (the original sentence from the PDF describing the mayor's presence/absence). Return null if mayor presence is not mentioned.
12. **incomplete**: Set to true ONLY if the document appears physically truncated — i.e. you can see attendance lists and preamble but the decision section starting with "ΑΠΟΦΑΣΙΖΕΙ" is not present because the provided pages end before reaching it. Set to false if you can see the "ΑΠΟΦΑΣΙΖΕΙ" section, even if some fields within it (like the vote result phrase) are missing or unclear. Missing data in a complete document is a data quality issue, not truncation.

Return valid JSON matching this schema:
{
  "presentMembers": string[],
  "absentMembers": string[],
  "mayorPresent": { "present": boolean, "rawText": string } | null,
  "decisionExcerpt": string,
  "decisionNumber": string | null,
  "references": string,
  "voteResult": string | null,
  "voteDetails": { "name": string, "vote": "FOR" | "AGAINST" | "ABSTAIN" }[],
  "attendanceChanges": { "name": string, "type": "arrival" | "departure", "agendaItem": { "agendaItemIndex": number, "nonAgendaReason": "outOfAgenda" | null } | null, "timing": "during" | "after" | null, "rawText": string }[],
  "discussionOrder": { "agendaItemIndex": number, "nonAgendaReason": "outOfAgenda" | null }[] | null,
  "subjectInfo": { "agendaItemIndex": number, "nonAgendaReason": "outOfAgenda" | null } | null,
  "incomplete": boolean
}

If a field cannot be found, use empty array for lists, empty string for text, and null where indicated.`;

// --- Greek name matching ---

/**
 * Normalize a Greek name for matching: strip diacritics (tonos), remove
 * parenthetical nicknames like "(ΜΠΑΜΠΗΣ)", collapse whitespace, lowercase.
 */
export function normalizeGreekName(name: string): string {
    return name
        .replace(/\s*\([^)]*\)\s*/g, ' ')      // strip parenthetical nicknames
        .normalize('NFD')                        // decompose accented chars
        .replace(/[\u0300-\u036f]/g, '')         // strip combining diacriticals (tonos etc.)
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
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
        const personId = keys.map(k => lookup.get(k)).find(Boolean);
        if (personId) {
            matchedIds.push(personId);
        } else {
            unmatched.push(rawName);
        }
    }

    return { matchedIds, unmatched };
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
    return null;
}

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

    const { result: rawResponse, usage } = await aiChat<string>({
        systemPrompt: `You are a Greek name matcher for municipal council members.

Match each name from "unmatchedNames" to its corresponding person from "availablePeople".
Names may differ in:
- Word order or missing middle names
- Accents/diacritics (monotonic vs polytonic, missing accents)
- Hyphenation or spacing (e.g. "ΚΩΝΣΤΑΝΤΙΝΑ - ΟΛΥΜΠΙΑ" vs "Κωνσταντίνα-Ολυμπία")
- Greek diminutives (υποκοριστικά): official documents use formal/legal names while databases often store the commonly used form. These can be very different from the formal name. Examples: Παρασκευή→Βούλα/Εύη, Ελπινίκη→Νίκη, Κωνσταντίνα→Τάνια/Ντίνα, Κωνσταντίνος→Ντίνος/Κώστας, Ευαγγελία→Εύα/Λίτσα, Δημήτριος→Μήτσος/Τάκης, Γεώργιος→Γιώργος, Αθανάσιος→Θανάσης, Χαράλαμπος→Μπάμπης

**Key strategy**: When the surname matches exactly between an unmatched name and only ONE available person shares that surname, the first name is very likely a diminutive — match them even if the first name looks very different. If multiple available people share the same surname, only match when you can confidently identify the diminutive.

Return ONLY a JSON array with one entry per unmatched name, no other text:
[{"name": "<exact name from unmatchedNames>", "personId": "<id from availablePeople or null>"}]

Rules:
- "name" must be the EXACT string from unmatchedNames
- "personId" must be an id from availablePeople, or null if no match
- When the surname matches exactly, match confidently even if the first name differs significantly (it's almost certainly a diminutive)
- Each personId at most once`,
        userPrompt: JSON.stringify({
            unmatchedNames,
            availablePeople: availablePeople.map(p => ({ id: p.id, name: p.name })),
        }),
        prefillSystemResponse: '[',
        prependToResponse: '[',
        parseJson: false,
        model: 'haiku',
    });

    // Strip any trailing text after the JSON array (LLM sometimes adds explanations)
    const jsonEnd = rawResponse.lastIndexOf(']');
    if (jsonEnd === -1) {
        console.warn(`  LLM returned no valid JSON array, treating all as unmatched`);
        return { matched: [], stillUnmatched: unmatchedNames, usage };
    }
    const result: { name: string; personId: string | null }[] = JSON.parse(rawResponse.slice(0, jsonEnd + 1));

    const matched: { name: string; personId: string }[] = [];
    const stillUnmatched: string[] = [];
    const usedIds = new Set<string>();

    for (const entry of result) {
        if (entry.personId && !usedIds.has(entry.personId)) {
            matched.push({ name: entry.name, personId: entry.personId });
            usedIds.add(entry.personId);
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

/**
 * Two-step matching: token-sort first, then LLM fallback for remaining.
 */
export async function matchAllMembers(
    rawNames: string[],
    people: PersonForMatching[],
): Promise<MatchResult> {
    // Step 1: token-sort matching
    const step1 = matchMembersToPersonIds(rawNames, people);

    if (step1.unmatched.length === 0) {
        return step1;
    }

    // Step 2: LLM fallback for unmatched
    const alreadyMatchedIds = new Set(step1.matchedIds);
    const availablePeople = people.filter(p => !alreadyMatchedIds.has(p.id));

    const step2 = await llmMatchMembers(step1.unmatched, availablePeople);

    return {
        matchedIds: [...step1.matchedIds, ...step2.matched.map(m => m.personId)],
        unmatched: step2.stillUnmatched,
    };
}

// --- PDF extraction ---

/** Max output tokens for extraction — the JSON output is small, so we don't need the full 64k default. */
const EXTRACTION_MAX_TOKENS = 8192;

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

export async function extractDecisionFromPdf(pdfUrl: string, mayorName?: string, skipCache?: boolean): Promise<ResultWithUsage<RawExtractedDecision> & { fromCache: boolean }> {
    if (!skipCache) {
        const cached = readCache<RawExtractedDecision>(pdfUrl);
        if (cached) return { result: cached, usage: { ...NO_USAGE }, fromCache: true };
    }

    const pdfBuffer = await downloadPdfAsBuffer(pdfUrl);
    const srcDoc = await PDFDocument.load(pdfBuffer);
    const totalPages = srcDoc.getPageCount();

    const userPromptParts = ['Extract the required information from this Greek municipal council decision PDF.'];
    if (mayorName) {
        userPromptParts.push(`The city mayor is: ${mayorName}`);
    }
    const userPrompt = userPromptParts.join('\n');

    // Small PDFs: send the whole thing in one call
    if (totalPages <= SMALL_PDF_THRESHOLD) {
        console.log(`  PDF has ${totalPages} pages (≤${SMALL_PDF_THRESHOLD}), sending whole document`);
        const base64 = pdfBuffer.toString('base64');
        const { result, usage } = await aiChat<RawExtractedDecision>({
            systemPrompt: EXTRACTION_SYSTEM_PROMPT,
            userPrompt,
            documentBase64: base64,
            prefillSystemResponse: '{',
            prependToResponse: '{',
            model: 'sonnet',
            maxTokens: EXTRACTION_MAX_TOKENS,
        });

        writeCache(pdfUrl, result);
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

        const partialBase64 = await extractPdfPages(pdfBuffer, 0, actualPages);

        const partialPrompt = actualPages < totalPages
            ? `${userPrompt}\n\nNote: You are seeing pages 1-${actualPages} of a ${totalPages}-page document. If the decision section ("ΑΠΟΦΑΣΙΖΕΙ") is not visible in these pages because the document is cut off, set "incomplete" to true. If you can see "ΑΠΟΦΑΣΙΖΕΙ" but some details are missing or unclear, set "incomplete" to false.`
            : userPrompt;

        const { result, usage } = await aiChat<RawExtractedDecision>({
            systemPrompt: EXTRACTION_SYSTEM_PROMPT,
            userPrompt: partialPrompt,
            documentBase64: partialBase64,
            prefillSystemResponse: '{',
            prependToResponse: '{',
            model: 'sonnet',
            maxTokens: EXTRACTION_MAX_TOKENS,
        });

        totalUsage = addUsage(totalUsage, usage);
        lastFrontResult = result;

        if (!result.incomplete || actualPages >= totalPages) {
            if (result.incomplete) {
                console.log(`  Extraction still incomplete after all ${totalPages} pages`);
            } else {
                console.log(`  Extraction complete with ${actualPages} pages`);
            }
            writeCache(pdfUrl, result);
            return { result, usage: totalUsage, fromCache: false };
        }

        console.log(`  Incomplete extraction — decision content not found in first ${actualPages} pages, retrying with more...`);
        pagesToSend += PAGE_INCREMENT;
    }

    // Front pages exhausted — try the last TAIL_PAGES pages
    const tailStart = Math.max(0, totalPages - TAIL_PAGES);
    if (tailStart > MAX_FRONT_PAGES) {
        // Only try tail if it doesn't overlap with pages we already sent
        const tailActual = totalPages - tailStart;
        console.log(`  Front pages exhausted, trying last ${tailActual} pages (${tailStart + 1}-${totalPages})...`);

        const tailBase64 = await extractPdfPages(pdfBuffer, tailStart, totalPages);
        const tailPrompt = `${userPrompt}\n\nNote: You are seeing the last ${tailActual} pages (${tailStart + 1}-${totalPages}) of a ${totalPages}-page document. The earlier pages contained attendance lists and preamble but not the decision section. Extract the decision information from these pages. If the decision section ("ΑΠΟΦΑΣΙΖΕΙ") is not visible in these pages either, set "incomplete" to true.`;

        const { result, usage } = await aiChat<RawExtractedDecision>({
            systemPrompt: EXTRACTION_SYSTEM_PROMPT,
            userPrompt: tailPrompt,
            documentBase64: tailBase64,
            prefillSystemResponse: '{',
            prependToResponse: '{',
            model: 'sonnet',
            maxTokens: EXTRACTION_MAX_TOKENS,
        });

        totalUsage = addUsage(totalUsage, usage);

        if (!result.incomplete) {
            // Merge: attendance from front pages, decision data from tail pages
            const merged: RawExtractedDecision = {
                ...result,
                presentMembers: result.presentMembers?.length ? result.presentMembers : lastFrontResult!.presentMembers,
                absentMembers: result.absentMembers?.length ? result.absentMembers : lastFrontResult!.absentMembers,
                attendanceChanges: result.attendanceChanges?.length ? result.attendanceChanges : lastFrontResult!.attendanceChanges,
                mayorPresent: result.mayorPresent ?? lastFrontResult!.mayorPresent,
            };
            console.log(`  Extraction complete from tail pages (merged with front-page attendance)`);
            writeCache(pdfUrl, merged);
            return { result: merged, usage: totalUsage, fromCache: false };
        }

        console.log(`  Decision content not found in tail pages either`);
    }

    // Fully exhausted — return best partial result we got (with incomplete flag)
    console.log(`  Progressive extraction exhausted (front ${MAX_FRONT_PAGES} + tail ${TAIL_PAGES} pages of ${totalPages}), returning partial data`);
    const bestResult: RawExtractedDecision = { ...lastFrontResult!, incomplete: true };
    writeCache(pdfUrl, bestResult);
    return { result: bestResult, usage: totalUsage, fromCache: false };
}
