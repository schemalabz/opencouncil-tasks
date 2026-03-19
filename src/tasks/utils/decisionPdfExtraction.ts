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
