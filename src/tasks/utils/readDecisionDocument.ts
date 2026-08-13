import Anthropic from '@anthropic-ai/sdk';
import { PDFDocument } from 'pdf-lib';
import { aiChat, ResultWithUsage, NO_USAGE, addUsage, HAIKU_MODEL } from '../../lib/ai.js';
import { downloadPdfAsBuffer, extractPdfPages, readCache, writeCache } from './decisionPdfExtraction.js';

/**
 * Read a decision document's own statement of which session produced it.
 *
 * Greek municipal decision documents state their session date, session number
 * and Αρ. Απόφασης on page 1. Reading them before matching turns the candidate
 * pool from a date-window guess into an exact partition: the decision names
 * its meeting, so only the subject within that meeting is left to decide
 * (issue #617).
 *
 * A cheap model does the reading — header formats vary too much for patterns,
 * body text contains date-shaped false positives, and scanned documents need
 * OCR, which the model does for free. This reader is deliberately separate
 * from extractDecisionFromPdf: that extracts full content (body, attendance,
 * votes) *after* a decision is matched; this reads only session identity
 * *before* matching. The ordering is the point — they cannot merge.
 */

export interface DecisionReading {
    /** YYYY-MM-DD as printed in the document (Athens-local). Null when not stated or unreadable. */
    meetingDate: string | null;
    /** The decision's own Αρ. Απόφασης, e.g. "425/2026" or "206". Never the protocol number. */
    decisionNumber: string | null;
}

/**
 * Cache key prefix. Bump the version when a prompt or schema change could
 * alter the VALUES of fields we keep — pure field removals don't qualify
 * (cached entries simply carry an ignored extra key).
 */
const READING_CACHE_PREFIX = 'reading-v1-';

/** Page 1 carries the header in every format seen so far; fall back to 3 pages when it does not. */
const PAGE_ATTEMPTS = [1, 3];

const READING_MAX_TOKENS = 1024;

const READING_SCHEMA = {
    type: 'object' as const,
    properties: {
        meetingDate: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        decisionNumber: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    },
    required: ['meetingDate', 'decisionNumber'],
    additionalProperties: false,
};

const READING_SYSTEM_PROMPT = `You read the opening page(s) of Greek municipal decision documents (ΑΠΟΣΠΑΣΜΑ ΠΡΑΚΤΙΚΟΥ / ΑΠΟΦΑΣΗ). Extract two facts the document states about itself:

1. **meetingDate** — the date of the session (συνεδρίαση) that PRODUCED this decision, as stated in the header or preamble (e.g. "συνήλθε ... σήμερα την 2α Ιουνίου 2026", "Στα Χανιά, σήμερα την ...", "της 27ης/29-7-2026 Συνεδρίασης", "στις 15 Ιανουαρίου 2024"). Return it as YYYY-MM-DD.
   CRITICAL: the decision body mentions other dates — of laws, contracts, referenced decisions (e.g. "εγκρίνει την 12 Μαρτίου 2019 σύμβαση"). Those are NOT the session date. The document's own issue date is also NOT the session date: the letterhead date, the protocol date (Αρίθμ. Πρωτ.), the "Ημερομηνία έκδοσης", and the digital-signature date all record when the document was issued or published, days after the session. Only return the date the session itself convened. If the session date is not stated, or you cannot tell which date is the session date, return null. If the document is not a decision of a deliberative session at all (an agenda, an invitation, a mayoral act), every field is null.
2. **decisionNumber** — the decision's own number (labelled Αρ. Απόφασης, ΑΡΙΘΜ. ΑΠΟΦ, ΑΡΙΘΜΟΣ ΑΠΟΦΑΣΗΣ, Α.Δ.Σ., ΑΠΟΦΑΣΗ ΑΡΙΘ., or similar), without the label: "ΑΡΙΘΜ. ΑΠΟΦ: 123 / 2024" → "123/2024", "Αρ. Απόφασης:206" → "206", "ΑΡΙΘΜ. ΑΠΟΦ: 123-2024" → "123/2024". This is NOT the protocol number (ΑΡΙΘΜ. ΠΡΩΤ / Αρ. Πρωτ.) — never return the protocol number. Null if absent.

The document may be a scanned image — read it visually. Labels may use Latin lookalike characters (APIΘM. AΠOΦ). Return null for any field you cannot determine with confidence: a null is recoverable, a wrong value is not.`;

function nullIfBlank(v: string | null | undefined): string | null {
    const t = (v ?? '').trim();
    return t.length > 0 ? t : null;
}

/**
 * Validate and clean a raw model reading. The date must be a real calendar
 * date in YYYY-MM-DD with a plausible year — anything else becomes null, so a
 * malformed read degrades to "unread" rather than partitioning a decision
 * into a nonsense meeting.
 */
export function normalizeReading(raw: {
    meetingDate?: string | null;
    decisionNumber?: string | null;
}): DecisionReading {
    let meetingDate = nullIfBlank(raw.meetingDate);
    if (meetingDate) {
        const m = meetingDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        const year = m ? Number(m[1]) : 0;
        const roundTrips = () => {
            const d = new Date(`${meetingDate}T00:00:00Z`);
            return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === meetingDate;
        };
        if (!m || year < 1990 || year > 2100 || !roundTrips()) meetingDate = null;
    }
    return {
        meetingDate,
        decisionNumber: nullIfBlank(raw.decisionNumber),
    };
}

export async function readDecisionDocument(
    pdfUrl: string,
    opts?: { skipCache?: boolean },
): Promise<ResultWithUsage<DecisionReading> & { fromCache: boolean }> {
    if (!opts?.skipCache) {
        const cached = readCache<DecisionReading>(pdfUrl, READING_CACHE_PREFIX);
        if (cached) return { result: cached, usage: { ...NO_USAGE }, fromCache: true };
    }

    const pdfBuffer = await downloadPdfAsBuffer(pdfUrl);
    const srcDoc = await PDFDocument.load(pdfBuffer);
    const totalPages = srcDoc.getPageCount();

    let totalUsage: Anthropic.Messages.Usage = { ...NO_USAGE };
    let reading: DecisionReading = { meetingDate: null, decisionNumber: null };

    for (const attempt of PAGE_ATTEMPTS) {
        const pages = Math.min(attempt, totalPages);
        const base64 = await extractPdfPages(pdfBuffer, 0, pages);

        const { result: raw, usage } = await aiChat<{
            meetingDate: string | null;
            decisionNumber: string | null;
        }>({
            systemPrompt: READING_SYSTEM_PROMPT,
            userPrompt: 'Extract the session date, session number and decision number this document states about itself.',
            documentBase64: base64,
            outputFormat: { type: 'json_schema', schema: READING_SCHEMA },
            model: HAIKU_MODEL,
            maxTokens: READING_MAX_TOKENS,
            label: 'decision-reading',
        });

        totalUsage = addUsage(totalUsage, usage);
        reading = normalizeReading(raw);
        if (reading.meetingDate || pages >= totalPages) break;
    }

    writeCache(pdfUrl, reading, READING_CACHE_PREFIX);
    return { result: reading, usage: totalUsage, fromCache: false };
}
