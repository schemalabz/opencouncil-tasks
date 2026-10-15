import { PDFDocument } from "pdf-lib";
import { aiChat, type UsageStats } from "./ai.js";
import { extractPdfPageSet } from "../tasks/utils/pdfPages.js";
import { fetchAgendaDocument, type AgendaDocument } from "./documentConversion.js";
import { bodyTypeOfLabel, sameBody } from "../tasks/utils/decisionPartition.js";
import type { AdministrativeBodyType, AgendaMeeting, AgendaMeetingRecord, MeetingFormat, MeetingKind, TaskWarning } from "../types.js";

export type MeetingRecordWarningCode = 'MEETING_RECORD_UNREAD' | 'MULTIPLE_MEETINGS';

const MEETING_KINDS = ['ordinary', 'special', 'accountability', 'activityReport', 'budget', 'presidencyElection', 'financialAccounts'] as const satisfies readonly MeetingKind[];
const MEETING_FORMATS = ['inPerson', 'remote', 'hybrid', 'byCirculation'] as const satisfies readonly MeetingFormat[];

/**
 * The kinds of meeting, as the Code of Municipalities defines them
 * (schemalabz/opencouncil#150 holds the table). Its own constant because
 * opencouncil will send these definitions as rendered text, the way
 * pollDecisions receives the decision conventions; this is the stand-in.
 */
export const MEETING_KIND_RULES = `kind: το είδος της συνεδρίασης, όπως το ορίζει ο Κώδικας (ν. 5314/2026).
- "ordinary": τακτική συνεδρίαση, χωρίς ειδικό σκοπό (άρθρα 123–124). Και όταν η πρόσκληση δεν γράφει είδος και δεν τη λέει ειδική. Και η κατεπείγουσα («έκτακτη») συνεδρίαση χωρίς ειδικό σκοπό: "ordinary" με urgent true.
- "accountability": Ειδική Συνεδρίαση Λογοδοσίας της δημοτικής αρχής (άρθρο 150).
- "activityReport": Ειδική Συνεδρίαση Απολογισμού Πεπραγμένων της δημοτικής αρχής (άρθρο 151).
- "budget": η ειδική συνεδρίαση για την ψήφιση του προϋπολογισμού (άρθρο 368 §5).
- "presidencyElection": η ειδική συνεδρίαση για την εκλογή του προεδρείου (άρθρα 118–119), συχνά μαζί με την εκλογή των μελών της Δημοτικής Επιτροπής.
- "financialAccounts": η έγκριση των οικονομικών καταστάσεων της χρήσης: ισολογισμός, αποτελέσματα χρήσης, απολογισμός εσόδων και εξόδων, διαχειριστική έκθεση (άρθρα 515, 518). Οι προσκλήσεις τη γράφουν «ειδική».
- "special": συνεδρίαση που η πρόσκληση λέει «ειδική» για άλλο σκοπό από τους παραπάνω, π.χ. η έκθεση πεπραγμένων της Δημοτικής Επιτροπής, οι εγγραφές στους παιδικούς σταθμούς, ένα πρόγραμμα δράσης.
- null: μόνο όταν το έγγραφο δεν είναι πρόσκληση και δεν λέει το είδος.
Η ειδική συνεδρίαση αναγνωρίζεται από τον σκοπό της, όχι μόνο από τη λέξη «ειδική»: μια «Ειδική Συνεδρίαση» με μοναδικό θέμα την εκλογή προεδρείου είναι "presidencyElection", με μοναδικό θέμα τον προϋπολογισμό είναι "budget". Μια τακτική συνεδρίαση που απλώς έχει τον προϋπολογισμό ή τον ισολογισμό ανάμεσα σε άλλα θέματα μένει "ordinary".
Όταν η πρόσκληση γράφει και «τακτική» και «ειδική» («σε τακτική, ειδική συνεδρίαση», «σε ειδική τακτική συνεδρίαση»), αποφασίζει το «ειδική»: το είδος δίνεται από τον σκοπό της.
Ο «απολογισμός» μόνος του δεν λέει το είδος: ο απολογισμός πεπραγμένων της δημοτικής αρχής είναι "activityReport", ο οικονομικός απολογισμός (εσόδων και εξόδων, ισολογισμός) είναι "financialAccounts".
Η Δημοτική Επιτροπή και οι Δημοτικές Κοινότητες συνεδριάζουν μόνο τακτικά, κατεπειγόντως ή όχι: το kind τους είναι "ordinary", και για συνεδρίαση για το σχέδιο του προϋπολογισμού ή για την εκλογή αντιπροέδρου.

urgent: true όταν η πρόσκληση συγκαλεί τη συνεδρίαση κατεπειγόντως: «κατεπείγουσα», «επείγουσα» ή «έκτακτη» συνεδρίαση (άρθρα 125, 143, 167). Συνήθως η πρόσκληση είναι της ίδιας μέρας και το σώμα ψηφίζει για το κατεπείγον. Η κατεπείγουσα συνεδρίαση μπορεί να είναι οποιουδήποτε είδους, π.χ. κατεπείγουσα ειδική συνεδρίαση προϋπολογισμού: "budget" με urgent true. Αλλιώς false.
ΠΡΟΣΟΧΗ: το «ΕΠΕΙΓΟΝ» ή «ΚΑΤΕΠΕΙΓΟΝ» στην κεφαλίδα του εγγράφου είναι χαρακτηρισμός προτεραιότητας του εγγράφου, όχι της συνεδρίασης. Τα «έκτακτα θέματα» ή τα θέματα «εκτός ημερήσιας διάταξης» μιας τακτικής συνεδρίασης δεν την κάνουν κατεπείγουσα.`;

/**
 * The meetings of an agenda as its invitation states them (schemalabz/opencouncil#150).
 *
 * Two readers share these rules: processAgenda, which reads the meetings and
 * their subjects in one call, and the archive backfill, which reads only the
 * meetings (`extractAgendaMeetings`). One definition keeps the two readers
 * identical.
 */
export const MEETING_RULES = `ΚΑΝΟΝΕΣ ΓΙΑ ΤΙΣ ΣΥΝΕΔΡΙΑΣΕΙΣ (meetings):
Για κάθε συνεδρίαση που καλεί το έγγραφο επιστρέφεις ένα στοιχείο στο meetings, με τη σειρά του εγγράφου. Συνήθως είναι μία. Ένα έγγραφο μπορεί να καλεί περισσότερες: μια Ειδική Συνεδρίαση Λογοδοσίας και μια τακτική συνεδρίαση την ίδια μέρα σε άλλη ώρα, ή δύο προσκλήσεις (π.χ. Δημοτικού Συμβουλίου και Δημοτικής Επιτροπής) σε ένα αρχείο. Μια ανακοίνωση αναβολής ή αλλαγής ημερομηνίας που επαναλαμβάνει την αρχική πρόσκληση αφορά την ίδια συνεδρίαση: ένα στοιχείο.

municipality: ο δήμος που καλεί τη συνεδρίαση, όπως τον γράφει το έγγραφο (π.χ. «ΔΗΜΟΣ ΧΑΛΑΝΔΡΙΟΥ», «Δήμος Ρόδου»). Κενό "" αν δεν φαίνεται.
bodyName: το όργανο που συνεδριάζει, όπως το γράφει το έγγραφο (π.χ. «Δημοτικό Συμβούλιο», «Δημοτική Επιτροπή», «1η Δημοτική Κοινότητα»). Η αίθουσα της συνεδρίασης («αίθουσα Δημοτικού Συμβουλίου») και ο τίτλος όποιου υπογράφει δεν είναι το όργανο. Κενό "" αν δεν φαίνεται.
date: η ημερομηνία της συνεδρίασης όπως τη γράφει η πρόσκληση, σε μορφή ΕΕΕΕ-ΜΜ-ΗΗ (π.χ. «την 5η Φεβρουαρίου 2025» → "2025-02-05"). Όχι η ημερομηνία του εγγράφου ή του πρωτοκόλλου. Κενό "" αν δεν γράφεται.
time: η ώρα έναρξης της συνεδρίασης όπως τη γράφει η πρόσκληση, σε μορφή ΩΩ:ΛΛ (π.χ. «ώρα 19:00» → "19:00", «ώρα 8.30 π.μ.» → "08:30"). Κενό "" αν δεν γράφεται.

${MEETING_KIND_RULES}

sessionNumber: ο αριθμός της ΣΥΝΕΔΡΙΑΣΗΣ, όπως είναι τυπωμένος. Παραδείγματα: «στην 15η Συνεδρίαση» → 15, «ΣΥΝΕΔΡΙΑΣΗ: 40» → 40, «Συνεδρίαση : 20η / 2026» → 20, «ΤΑΚΤΙΚΗ ΣΥΝΕΔΡΙΑΣΗ (13η)» → 13, «Για την 12η/2026 Τακτική Συνεδρίαση» → 12, «4η Ειδική Συνεδρίαση Λογοδοσίας» → 4.
ΠΡΟΣΟΧΗ: ο αριθμός της ΠΡΟΣΚΛΗΣΗΣ δεν είναι αριθμός συνεδρίασης, ακόμα κι αν μοιάζει. «Αριθμός Πρόσκλησης: 45-2026», «ΑΡΙΘ. ΠΡΟΣΚΛΗΣΕΩΣ: 48», «ΠΡΟΣΚΛΗΣΗ (Αριθ.37/2026)», «ΠΡΟΣΚΛΗΣΗ ΜΕ ΑΡΙΘΜΟ 18/2026», «41η ΠΡΟΣΚΛΗΣΗ» → null. Ούτε ο αριθμός πρωτοκόλλου (Α.Π., Αρ. Πρωτ.), ούτε ο αριθμός άρθρου νόμου, ούτε η ημερομηνία. Ο αριθμός μετράει μόνο όταν συνοδεύει τη λέξη «συνεδρίαση». Αν δεν υπάρχει τέτοιος αριθμός, null. Μην τον υπολογίζεις και μην τον μαντεύεις.

format: ο τρόπος διεξαγωγής.
- "inPerson": δια ζώσης, σε αίθουσα.
- "remote": μόνο με τηλεδιάσκεψη (e:Presence, Zoom, Teams, Webex κ.λπ.).
- "hybrid": μικτή/μεικτή, ή δια ζώσης και με τηλεδιάσκεψη μαζί.
- "byCirculation": δια περιφοράς (ψηφοφορία με email/τηλέφωνο, χωρίς συνάντηση).
- Όταν η πρόσκληση λέει ότι η συνεδρίαση γίνεται σε έναν χώρο (αίθουσα, δημαρχείο, κατάστημα) και δεν αναφέρει τηλεδιάσκεψη για τα μέλη, είναι "inPerson". Η μετάδοση της συνεδρίασης στο κοινό (live, YouTube, ιστοσελίδα) δεν είναι τηλεδιάσκεψη.
- null: όταν η πρόσκληση δεν λέει ούτε τρόπο ούτε χώρο.

kindEvidence, urgentEvidence, sessionNumberEvidence, formatEvidence: η φράση του εγγράφου (έως 20 λέξεις, αυτούσια) από την οποία διάβασες την τιμή. Κενό "" όταν η τιμή είναι null ή το urgent false, και για το kind "ordinary" όταν η πρόσκληση δεν γράφει καθόλου είδος.`;

// The API rejects an enum next to `type: ["string", "null"]`.
const nullableEnum = (values: readonly string[]) => ({ anyOf: [{ type: "string", enum: [...values] }, { type: "null" }] });

/**
 * One meeting in a structured-output schema. The texts are plain strings,
 * empty when absent: a schema holds at most 16 nullable parameters, and the
 * subject schema beside this one already carries most of them.
 */
export const MEETING_SCHEMA = {
    type: "object",
    properties: {
        municipality: { type: "string" },
        bodyName: { type: "string" },
        date: { type: "string" },
        time: { type: "string" },
        kind: nullableEnum(MEETING_KINDS),
        kindEvidence: { type: "string" },
        urgent: { type: "boolean" },
        urgentEvidence: { type: "string" },
        sessionNumber: { type: ["integer", "null"] },
        sessionNumberEvidence: { type: "string" },
        format: nullableEnum(MEETING_FORMATS),
        formatEvidence: { type: "string" },
    },
    required: ["municipality", "bodyName", "date", "time", "kind", "kindEvidence", "urgent", "urgentEvidence", "sessionNumber", "sessionNumberEvidence", "format", "formatEvidence"],
    additionalProperties: false,
};

/** One meeting as the model returns it, before `normalizeMeeting`. */
export type RawAgendaMeeting = {
    municipality: string;
    bodyName: string;
    date: string;
    time: string;
    kind: MeetingKind | null;
    kindEvidence: string;
    urgent: boolean;
    urgentEvidence: string;
    sessionNumber: number | null;
    sessionNumberEvidence: string;
    format: MeetingFormat | null;
    formatEvidence: string;
};

/** The meeting the request is about: its body, and its start in the city's time. */
export type MeetingOfRequest = { body?: { name?: string; type: AdministrativeBodyType }; time?: string };

/**
 * The invitations of an agenda come before its attachments (fifty pages in
 * Βριλήσσια), which the meetings-only reading does not need. Most agendas
 * have two pages, but Σπάρτη bundles one invitation per bequest committee
 * after the committee's own: six invitations end on page 13 of jun23_2026,
 * and a cut at 3 pages lost the later ones.
 */
const HEADER_PAGES = 15;
/** The same cut for a converted .docx: the heading and the opening paragraph. */
const HEADER_HTML_CHARS = 20_000;

const MEETINGS_ONLY_SCHEMA = {
    type: "object",
    properties: { meetings: { type: "array", items: MEETING_SCHEMA } },
    required: ["meetings"],
    additionalProperties: false,
};

const MEETINGS_ONLY_SYSTEM_PROMPT = `Διαβάζεις την πρόσκληση σε συνεδρίαση ενός οργάνου ελληνικού δήμου (Δημοτικό Συμβούλιο, Δημοτική Επιτροπή, Δημοτική Κοινότητα) και επιστρέφεις τις συνεδριάσεις που καλεί, όπως τις γράφει η πρόσκληση. Δεν εξάγεις θέματα.

${MEETING_RULES}`;

/** The first pages of a PDF, as base64. A PDF that pdf-lib cannot read goes whole. */
async function headerPages(base64: string, pages = HEADER_PAGES): Promise<string> {
    try {
        const source = await PDFDocument.load(Buffer.from(base64, 'base64'), { ignoreEncryption: true });
        if (source.getPageCount() <= pages) return base64;
        return await extractPdfPageSet(source, Array.from({ length: pages }, (_, i) => i));
    } catch (error) {
        console.warn(`   ⚠️  Could not cut the PDF to its first pages, sending it whole: ${error instanceof Error ? error.message : error}`);
        return base64;
    }
}

export type AgendaMeetingsReading = {
    meetings: AgendaMeeting[];
    /** The position in `meetings` of the request's meeting; null when it cannot be told. */
    thisMeeting: number | null;
    record: AgendaMeetingRecord | null;
    warnings: TaskWarning<MeetingRecordWarningCode>[];
    extraction: UsageStats;
};

/**
 * The meetings of an agenda without its subjects: the reading of the archive
 * backfill, which must not re-run processAgenda. processAgenda reads the
 * meetings in its own call, with the same rules.
 */
export async function extractAgendaMeetings(
    document: AgendaDocument,
    { date, ...meeting }: MeetingOfRequest & { date: string },
): Promise<AgendaMeetingsReading> {
    const html = document.kind === 'html'
        ? `\n\nΗ αρχή του εγγράφου (μετατροπή από αρχείο Word σε HTML):\n\n${document.html.slice(0, HEADER_HTML_CHARS)}\n`
        : '';
    const result = await aiChat<{ meetings: RawAgendaMeeting[] }>({
        model: "claude-sonnet-5-5",
        label: "agenda-meetings",
        systemPrompt: MEETINGS_ONLY_SYSTEM_PROMPT,
        userPrompt: `Το έγγραφο αφορά συνεδρίαση στις ${date.slice(0, 10)}.${html}\n\nΕπίστρεψε κάθε συνεδρίαση που καλεί το έγγραφο.`,
        documentBase64: document.kind === 'pdf' ? await headerPages(document.base64) : undefined,
        maxTokens: 4000,
        outputFormat: { type: "json_schema", schema: MEETINGS_ONLY_SCHEMA },
    });
    const meetings = markBody(result.result.meetings.map(normalizeMeeting), meeting.body);
    return {
        meetings,
        ...pickMeeting(meetings, meeting),
        extraction: { usage: result.usage, resolvedModel: result.resolvedModel, batchMode: result.batchMode },
    };
}

/** One meeting of the export that opencouncil's scripts/meeting-record-export.ts writes. */
export interface MeetingRecordExportRow {
    cityId: string;
    meetingId: string;
    /** The meeting's calendar date in the city's time (YYYY-MM-DD). */
    date: string;
    /** The meeting's start in the city's time (HH:MM). */
    time?: string;
    agendaUrl: string;
    administrativeBody: { name: string; type: AdministrativeBodyType } | null;
}

/**
 * The backfill's reading of one exported meeting (`read-meeting-records`, and
 * the `agenda.meetingRecord` eval suite). A meeting with no body is the council's.
 */
export async function readExportedMeeting(row: MeetingRecordExportRow): Promise<AgendaMeetingsReading> {
    const document = await fetchAgendaDocument(row.agendaUrl);
    return extractAgendaMeetings(document, { body: row.administrativeBody ?? { type: 'council' }, time: row.time, date: row.date });
}

/**
 * Empty texts become null, and a session number that cannot be one is
 * dropped. A value without the phrase it was read from is a guess and is
 * dropped too; only "ordinary" stands without one, as the rules allow an
 * invitation that names no kind. Urgency without its phrase is false.
 */
export function normalizeMeeting(meeting: RawAgendaMeeting): AgendaMeeting {
    const text = (value: string | null | undefined) => value?.replace(/\s+/g, ' ').trim() || null;
    const kindEvidence = text(meeting.kindEvidence);
    const sessionNumberEvidence = text(meeting.sessionNumberEvidence);
    const formatEvidence = text(meeting.formatEvidence);
    const urgentEvidence = text(meeting.urgentEvidence);
    const kind = MEETING_KINDS.includes(meeting.kind as MeetingKind) && (kindEvidence || meeting.kind === 'ordinary') ? meeting.kind : null;
    const urgent = meeting.urgent === true && urgentEvidence !== null;
    const sessionNumber = sessionNumberEvidence && Number.isInteger(meeting.sessionNumber) && meeting.sessionNumber! >= 1 && meeting.sessionNumber! <= 999
        ? meeting.sessionNumber
        : null;
    const format = MEETING_FORMATS.includes(meeting.format as MeetingFormat) && formatEvidence ? meeting.format : null;
    const time = text(meeting.time);
    const date = text(meeting.date);
    return {
        municipality: text(meeting.municipality),
        bodyName: text(meeting.bodyName),
        ofThisBody: null,
        date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
        time: time && /^\d{2}:\d{2}$/.test(time) ? time : null,
        kind,
        kindEvidence: kind === null ? null : kindEvidence,
        urgent,
        urgentEvidence: urgent ? urgentEvidence : null,
        sessionNumber,
        sessionNumberEvidence: sessionNumber === null ? null : sessionNumberEvidence,
        format,
        formatEvidence: format === null ? null : formatEvidence,
    };
}

/**
 * Marks the agenda's meetings of the request's body: those whose printed body
 * is the body itself (`sameBody`: inflection, community numbers), or, when
 * none is, those whose printed body is of the body's kind. «Δημοτική
 * Επιτροπή» is not «Δημοτική–Διαχειριστική Επιτροπή Κληροδοτήματος …», the
 * same people sitting as the manager of a bequest, which Σπάρτη calls in the
 * committee's invitation. Without a body in the request nothing is marked.
 */
export function markBody(meetings: AgendaMeeting[], body: MeetingOfRequest['body']): AgendaMeeting[] {
    if (!body) return meetings;
    const named = body.name ? meetings.map((m) => (m.bodyName ? sameBody(m.bodyName, body.name!) : null)) : meetings.map(() => null);
    const byName = named.some((v) => v === true);
    return meetings.map((m, i) => ({
        ...m,
        ofThisBody: !m.bodyName ? null : byName ? named[i] === true : bodyTypeOfLabel(m.bodyName) === body.type,
    }));
}

/**
 * Which of the agenda's meetings the request is about: the only one; else the
 * only one of the request's body (`markBody`); else the only one of that body
 * at the request's time. When none of these tells them apart, a field is kept only
 * where the candidates agree, as the record of a combined meeting keeps no kind.
 *
 * An agenda with more than one meeting always warns: the platform keeps one
 * meeting per record, so the subjects of every meeting land on this one.
 */
export function pickMeeting(
    meetings: AgendaMeeting[],
    { time }: Pick<MeetingOfRequest, 'time'>,
): { thisMeeting: number | null; record: AgendaMeetingRecord | null; warnings: TaskWarning<MeetingRecordWarningCode>[] } {
    if (meetings.length === 0) {
        return {
            thisMeeting: null,
            record: null,
            warnings: [{ code: 'MEETING_RECORD_UNREAD', severity: 'warning', message: 'The document names no meeting: the kind, the session number and the format were not read' }],
        };
    }
    if (meetings.length === 1) return { thisMeeting: 0, record: recordOf(meetings[0]), warnings: [] };

    const indexed = meetings.map((m, i) => ({ m, i }));
    const ofThisBody = indexed.filter(({ m }) => m.ofThisBody === true);
    let candidates = ofThisBody.length > 0 ? ofThisBody : indexed;
    if (candidates.length > 1 && time) {
        const atTime = candidates.filter(({ m }) => m.time === time);
        if (atTime.length > 0) candidates = atTime;
    }

    const listed = meetings.map(m => `${m.bodyName ?? '?'}${m.time ? ` ${m.time}` : ''}: ${m.kind ?? '?'}${m.urgent ? ' urgent' : ''}${m.sessionNumber ? ` #${m.sessionNumber}` : ''}`).join(' | ');
    if (candidates.length === 1) {
        return {
            thisMeeting: candidates[0].i,
            record: recordOf(candidates[0].m),
            warnings: [{
                code: 'MULTIPLE_MEETINGS',
                severity: 'warning',
                message: `The agenda holds ${meetings.length} meetings; this meeting is #${candidates[0].i + 1}, and the subjects of all of them were read: ${listed}`,
            }],
        };
    }

    const agreed = <K extends 'kind' | 'sessionNumber' | 'format'>(field: K) =>
        candidates.every(({ m }) => m[field] === candidates[0].m[field]) ? candidates[0].m[field] : null;
    const kind = agreed('kind'), sessionNumber = agreed('sessionNumber'), format = agreed('format');
    const urgent = candidates.every(({ m }) => m.urgent);
    return {
        thisMeeting: null,
        record: {
            kind,
            kindEvidence: kind === null ? null : candidates[0].m.kindEvidence,
            urgent,
            urgentEvidence: urgent ? candidates[0].m.urgentEvidence : null,
            sessionNumber,
            sessionNumberEvidence: sessionNumber === null ? null : candidates[0].m.sessionNumberEvidence,
            format,
            formatEvidence: format === null ? null : candidates[0].m.formatEvidence,
        },
        warnings: [{
            code: 'MULTIPLE_MEETINGS',
            severity: 'warning',
            message: `The agenda holds ${meetings.length} meetings and this meeting could not be told apart; only the fields they share were kept, and the subjects of all of them were read: ${listed}`,
        }],
    };
}

function recordOf({ municipality: _municipality, bodyName: _bodyName, ofThisBody: _ofThisBody, date: _date, time: _time, ...record }: AgendaMeeting): AgendaMeetingRecord {
    return record;
}
