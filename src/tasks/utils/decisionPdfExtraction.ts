import { aiChat } from '../../lib/ai.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

// --- PDF download ---

export async function downloadPdfToBase64(url: string): Promise<string> {
    console.log(`Downloading file from ${url}...`);
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to download PDF from ${url}: HTTP ${response.status} ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');
    console.log(`Downloaded file: ${(base64.length / 1024).toFixed(0)} KB base64`);
    return base64;
}

// --- Extraction cache ---
// Caches Claude extraction results per PDF URL to avoid re-downloading and re-processing
// during iterative development. Persists across runs in os.tmpdir().

const CACHE_DIR = path.join(os.tmpdir(), 'opencouncil-decisions-cache');

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

export interface AttendanceChange {
    name: string;
    type: 'arrival' | 'departure';
    duringAgendaItem: number | null;
    atSessionBoundary: 'start' | 'end' | null;
    rawText: string;
}

export interface RawExtractedDecision {
    presentMembers: string[];
    absentMembers: string[];
    decisionExcerpt: string;
    decisionNumber: string | null;
    references: string;
    voteResult: string | null;
    voteDetails: { name: string; vote: 'FOR' | 'AGAINST' | 'ABSTAIN' }[];
    attendanceChanges: AttendanceChange[];
    discussionOrder: number[] | null;
}

/**
 * Infer FOR votes for majority decisions. When voteResult says "κατά πλειοψηφία"
 * and the PDF only explicitly names AGAINST/ABSTAIN voters, all present members
 * not in voteDetails are implicitly FOR.
 *
 * Pure function: returns a new voteDetails array (never mutates input) and the
 * number of inferred FOR votes.
 */
export function inferForVotes(
    presentMembers: string[],
    voteResult: string | null,
    voteDetails: { name: string; vote: 'FOR' | 'AGAINST' | 'ABSTAIN' }[],
): { voteDetails: { name: string; vote: 'FOR' | 'AGAINST' | 'ABSTAIN' }[]; inferredCount: number } {
    const isMajority = voteResult && /κατ[άα]\s+πλειοψηφ[ίι]/i.test(voteResult);
    const hasNoForVotes = (voteDetails || []).every(v => v.vote !== 'FOR');

    if (!isMajority || !hasNoForVotes || presentMembers.length === 0) {
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
3. **decisionExcerpt**: The decision text, starting from "ΤΟ Δ.Σ αφού έλαβε υπόψη" or similar phrasing through "ΑΠΟΦΑΣΙΖΕΙ" and the decision content. Include the full decision text. Use markdown formatting to preserve structure (bullet points, numbered lists, etc.).
4. **decisionNumber**: The decision number (Αριθμός Απόφασης), e.g. "231/2025".
5. **references**: The legal bases and references from the "αφού έλαβε υπόψη" or "Έχοντας υπόψη" section. List each reference item. Use markdown formatting (numbered list). If the section just says something generic like "τις σχετικές διατάξεις της Νομοθεσίας", return that text as-is.
6. **voteResult**: The vote result phrase, e.g. "Ομόφωνα", "Κατά πλειοψηφία", "Κατά πλειοψηφία με ψήφους 21 υπέρ και 2 κατά". This is usually found right before or after "ΑΠΟΦΑΣΙΖΕΙ".
7. **voteDetails**: When the PDF names specific people who voted differently (against or abstained), list them. For unanimous decisions, return an empty array. Each entry has "name" (full name) and "vote" ("FOR", "AGAINST", or "ABSTAIN").
8. **attendanceChanges**: Extract from "Προσελεύσεις – Αποχωρήσεις" or separate "Προσελεύσεις" / "Αποχωρήσεις" sections. These describe members who arrived late or left early. For each person, extract:
   - "name": full name
   - "type": "arrival" or "departure"
   - "duringAgendaItem": the agenda item number during which they arrived/departed (e.g. if the text says "κατά τη συζήτηση του 3ου θέματος", extract 3). Use null if no specific item is mentioned.
   - "atSessionBoundary": "start" if they arrived at the beginning of the session (before any agenda items), "end" if they left at the end, or null otherwise.
   - "rawText": the original sentence describing this change.
   If no such section exists, return an empty array.
9. **discussionOrder**: When subjects were discussed out of agenda order (e.g. "Προτάθηκε η αλλαγή σειράς συζήτησης" or items are explicitly reordered), extract the agenda item numbers in the actual discussion sequence as an array of numbers. Return null if subjects were discussed in standard agenda order.

Return valid JSON matching this schema:
{
  "presentMembers": string[],
  "absentMembers": string[],
  "decisionExcerpt": string,
  "decisionNumber": string | null,
  "references": string,
  "voteResult": string | null,
  "voteDetails": { "name": string, "vote": "FOR" | "AGAINST" | "ABSTAIN" }[],
  "attendanceChanges": { "name": string, "type": "arrival" | "departure", "duringAgendaItem": number | null, "atSessionBoundary": "start" | "end" | null, "rawText": string }[],
  "discussionOrder": number[] | null
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
): Promise<{ matched: { name: string; personId: string }[]; stillUnmatched: string[] }> {
    if (unmatchedNames.length === 0 || availablePeople.length === 0) {
        return { matched: [], stillUnmatched: unmatchedNames };
    }

    console.log(`  LLM matching ${unmatchedNames.length} unmatched names against ${availablePeople.length} people`);

    const { result: rawResponse } = await aiChat<string>({
        systemPrompt: `You are a Greek name matcher for municipal council members.

Match each name from "unmatchedNames" to its corresponding person from "availablePeople".
Names may differ in: word order, accents/diacritics, hyphenation, or nicknames.

Return ONLY a JSON array with one entry per unmatched name, no other text:
[{"name": "<exact name from unmatchedNames>", "personId": "<id from availablePeople or null>"}]

Rules:
- "name" must be the EXACT string from unmatchedNames
- "personId" must be an id from availablePeople, or null if no match
- Only match if confident — use null otherwise
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
        return { matched: [], stillUnmatched: unmatchedNames };
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
    return { matched, stillUnmatched };
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

export async function extractDecisionFromPdf(pdfUrl: string): Promise<RawExtractedDecision> {
    const cached = readCache<RawExtractedDecision>(pdfUrl);
    if (cached) return cached;

    const base64 = await downloadPdfToBase64(pdfUrl);

    const { result } = await aiChat<RawExtractedDecision>({
        systemPrompt: EXTRACTION_SYSTEM_PROMPT,
        userPrompt: 'Extract the required information from this Greek municipal council decision PDF.',
        documentBase64: base64,
        prefillSystemResponse: '{',
        prependToResponse: '{',
        model: 'sonnet',
    });

    writeCache(pdfUrl, result);
    return result;
}
