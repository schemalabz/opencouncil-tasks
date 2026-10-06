import Anthropic from '@anthropic-ai/sdk';
import crypto from 'crypto';
import { PDFDocument } from 'pdf-lib';
import path from 'path';
import { aiChat, addUsage, NO_USAGE, type ImageMediaType, type ResultWithUsage } from '../../lib/ai.js';
import { llmMatchMembers, matchPersonByName, type PersonForMatching } from './decisionPdfExtraction.js';
import type {
    AttendancePhase,
    ItemRange,
    MeetingAgendaItem,
    MeetingFactsChange,
    MeetingFactsReading,
    ReadAttendanceSheetRequest,
    RosterPerson,
    StatedRollCallEntry,
    StatedVote,
    TaskWarning,
    VoteValue,
} from '../../types.js';

/*
 * The pure parts of the attendance-sheet reader: the prompt the model gets,
 * the schema its answer must fit, the two-step name matching, and the mapping
 * from the raw answer to the wire's MeetingFactsReading. readAttendanceSheet.ts
 * holds the download, the cache and the progress reporting.
 */

export const SHEET_READING_MODEL = 'claude-sonnet-4-6';

/**
 * Structured outputs cannot continue a truncated answer, so the cap has to
 * hold the largest sheet in one go: a council of 45 with per-item votes.
 */
export const SHEET_READING_MAX_TOKENS = 32000;

/**
 * Cache key prefix. Bump the version when a prompt or schema change could
 * alter the values of the fields the raw reading keeps.
 */
export const SHEET_CACHE_PREFIX = 'sheet-v2-';

export type SheetMediaType = ReadAttendanceSheetRequest['mediaType'];

/** The anchor vocabulary of a sheet: no decision numbers, no subject of its own. */
export type SheetAnchorKind = 'agenda_item' | 'phase' | 'session_start' | 'session_end';

/**
 * The reading as the model returns it. Structured outputs cap the number of
 * nullable parameters per schema, so "not stated" is an empty string, a zero
 * or a sentinel enum value here and becomes null in toMeetingFactsReading.
 */
export interface RawSheetReading {
    rollCall: {
        /** False when the page lists no members at all. */
        found: boolean;
        /** The heading of the list and its first line, as printed. */
        rawText: string;
        entries: RawRollCallEntry[];
    };
    attendanceChanges: RawSheetChange[];
    votes: RawSheetVote[];
    /** name "" when the page names nobody as presiding. */
    presidedBy: { name: string; rawText: string };
    /** True when the picture cannot be read: blur, darkness, or a page that is not a sheet. */
    unreadable: boolean;
}

export interface RawRollCallEntry {
    name: string;
    status: 'PRESENT' | 'ABSENT';
    absenceJustified: 'justified' | 'unjustified' | 'not_stated';
    rawText: string;
    /** The row on the page, counted from 1; 0 when the reader cannot number it. */
    line: number;
}

export interface RawSheetChange {
    name: string;
    type: 'arrival' | 'departure' | 'absent_for_vote';
    anchor: {
        kind: SheetAnchorKind;
        /** 0 when kind is not agenda_item. */
        agendaItemIndex: number;
        outOfAgenda: boolean;
        phase: AttendancePhase | 'none';
        timing: 'before' | 'during' | 'after' | 'none';
    };
    rawText: string;
    line: number;
}

export interface RawSheetVote {
    items: ItemRange[];
    outcome: 'unanimous' | 'majority' | 'rejected' | 'not_stated';
    phrase: string;
    namedVotes: Array<{ name: string; vote: VoteValue; rawText: string }>;
    rawText: string;
    line: number;
    confidence: number;
}

const ITEM_RANGE_SCHEMA = {
    type: 'object' as const,
    properties: {
        kind: { type: 'string', enum: ['agenda_item', 'out_of_agenda'] },
        from: { type: 'integer' },
        to: { type: 'integer' },
    },
    required: ['kind', 'from', 'to'],
    additionalProperties: false,
};

export const SHEET_READING_SCHEMA = {
    type: 'object' as const,
    properties: {
        rollCall: {
            type: 'object',
            properties: {
                found: { type: 'boolean' },
                rawText: { type: 'string' },
                entries: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            name: { type: 'string' },
                            status: { type: 'string', enum: ['PRESENT', 'ABSENT'] },
                            absenceJustified: { type: 'string', enum: ['justified', 'unjustified', 'not_stated'] },
                            rawText: { type: 'string' },
                            line: { type: 'integer' },
                        },
                        required: ['name', 'status', 'absenceJustified', 'rawText', 'line'],
                        additionalProperties: false,
                    },
                },
            },
            required: ['found', 'rawText', 'entries'],
            additionalProperties: false,
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
                            kind: { type: 'string', enum: ['agenda_item', 'phase', 'session_start', 'session_end'] },
                            agendaItemIndex: { type: 'integer' },
                            outOfAgenda: { type: 'boolean' },
                            phase: { type: 'string', enum: ['pre_agenda', 'out_of_agenda', 'none'] },
                            timing: { type: 'string', enum: ['before', 'during', 'after', 'none'] },
                        },
                        required: ['kind', 'agendaItemIndex', 'outOfAgenda', 'phase', 'timing'],
                        additionalProperties: false,
                    },
                    rawText: { type: 'string' },
                    line: { type: 'integer' },
                },
                required: ['name', 'type', 'anchor', 'rawText', 'line'],
                additionalProperties: false,
            },
        },
        votes: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    items: { type: 'array', items: ITEM_RANGE_SCHEMA },
                    outcome: { type: 'string', enum: ['unanimous', 'majority', 'rejected', 'not_stated'] },
                    phrase: { type: 'string' },
                    namedVotes: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                name: { type: 'string' },
                                vote: { type: 'string', enum: ['FOR', 'AGAINST', 'ABSTAIN', 'PRESENT', 'DID_NOT_VOTE'] },
                                rawText: { type: 'string' },
                            },
                            required: ['name', 'vote', 'rawText'],
                            additionalProperties: false,
                        },
                    },
                    rawText: { type: 'string' },
                    line: { type: 'integer' },
                    confidence: { type: 'integer' },
                },
                required: ['items', 'outcome', 'phrase', 'namedVotes', 'rawText', 'line', 'confidence'],
                additionalProperties: false,
            },
        },
        presidedBy: {
            type: 'object',
            properties: { name: { type: 'string' }, rawText: { type: 'string' } },
            required: ['name', 'rawText'],
            additionalProperties: false,
        },
        unreadable: { type: 'boolean' },
    },
    required: ['rollCall', 'attendanceChanges', 'votes', 'presidedBy', 'unreadable'],
    additionalProperties: false,
};

export const SHEET_SYSTEM_PROMPT = `You read the attendance sheet that the back office keeps during a meeting of a Greek municipal body (δημοτικό συμβούλιο, δημοτική επιτροπή, συμβούλιο δημοτικής κοινότητας). The page is usually a photograph, often at an angle, and is filled in by hand in part. Report only what the page states. Never add what follows from two statements, and never guess a mark you cannot see.

1. **rollCall** — every member the page lists, in page order, one entry per row. "name" is the name exactly as printed or written, with the same spelling, order and abbreviations. Do not replace a name with a spelling from the reference list. "line" is the row's position on the page, counted from 1; 0 when you cannot number it. "rawText" is the whole row as printed: number, name, marks.
   Presence marks differ per body. Common layouts:
   - A circled row number together with a signature next to the name marks the member present; an uncircled number with no signature marks the member absent.
   - A tick (✓), an «X», a «Π» or «παρών/παρούσα» marks present; an «Α» or «απών/απούσα» marks absent.
   - Separate ΠΑΡΟΝΤΕΣ and ΑΠΟΝΤΕΣ lists.
   When the request describes this body's layout, follow that description over these defaults. When you cannot tell a member's status from any mark, report ABSENT only if the page marks absence explicitly; otherwise pick what the layout implies and keep "rawText" complete so a person can check.
   "absenceJustified": "justified" when the page marks the absence as justified («δικαιολογημένη», «δικ.», «δ/μένη»), "unjustified" when it marks it as unjustified («αδικαιολόγητη»), "not_stated" otherwise, and always "not_stated" for a present member.
   Set "found" to false and "entries" to [] when the page lists no members.

2. **attendanceChanges** — every handwritten note that a member arrived, left, or was out for one item: «προσήλθε στο 10ο θέμα», «αποχώρησε μετά το 3ο θέμα», «προσήλθε 20:45», «αποχώρησε πριν το 5ο», «απών στο 7ο θέμα». Each note is one entry with "name" as written, "rawText" as written, and "line" the row it sits on (0 when it is a loose note).
   "type": "arrival" for προσήλθε/ήρθε, "departure" for αποχώρησε/έφυγε, "absent_for_vote" for a note that the member was absent or did not vote for one item or a range of items.
   "anchor":
   - kind "agenda_item" with "agendaItemIndex" the item number as written («10ο θέμα» → 10) and "timing" "before" («πριν το»), "during" («στο», «κατά τη συζήτηση του») or "after" («μετά το»). Set "outOfAgenda" to true when the note names an out-of-agenda item («1ο εκτός ημερησίας», «1ο ΕΗΔ», «1ο έκτακτο»); "agendaItemIndex" is then its position among the out-of-agenda items.
   - kind "phase" with "phase" "out_of_agenda" for a note anchored to the out-of-agenda block as a whole («στα εκτός ημερησίας», «στα προ ημερησίας» → "pre_agenda"); "agendaItemIndex" 0 and "timing" "none".
   - kind "session_start" for an arrival with a clock time or with no anchor at all; kind "session_end" for a departure with a clock time or with no anchor. "agendaItemIndex" 0, "phase" "none", "timing" "none".
   An "absent_for_vote" note always uses kind "agenda_item" with "timing" "during".
   Read the item number digit by digit: «10ο» is item 10, not item 1, and «12ο» is item 12. The request lists the agenda items that exist. A number outside that list is still reported as written.

3. **votes** — only when the sheet records the outcome per item. Many sheets do not; then return []. One entry per item or per range of items («θέματα 2-8» → one range from 2 to 8). "items" carries the ranges with "kind" "agenda_item" or "out_of_agenda"; [] when the note does not say which item.
   "outcome": "unanimous" for «ομόφωνα»/«ΟΜΟΦ.», "majority" for «κατά πλειοψηφία»/«πλειοψ.», "rejected" for «απορρίπτεται»/«απορρίφθηκε», "not_stated" otherwise. "phrase" is the outcome as written.
   "namedVotes": members the sheet marks with a vote on that item: «ΚΑΤΑ» → "AGAINST", «ΥΠΕΡ» → "FOR", «ΛΕΥΚΟ» → "ABSTAIN", «ΠΑΡΩΝ»/«ΠΑΡΟΥΣΑ» → "PRESENT", «ΑΠΟΧΗ»/«απέχει»/«δεν ψήφισε» → "DID_NOT_VOTE" (the decisions record an abstention as not voting, and a blank vote as λευκό). Never infer a FOR vote from silence.
   "confidence": 0–100, how sure you are that this is a vote of this meeting on these items.

4. **presidedBy** — only a member the page marks with a presiding word («Πρόεδρος», «προεδρεύων», «προήδρευσε») next to the name. A row with no such word names nobody, whatever the member's office: name "" then.

5. **unreadable** — true when the picture is too blurred or too dark to read, or the page is not an attendance sheet at all. Then return rollCall {"found": false, "rawText": "", "entries": []}, [] for the lists and "" for the names.

Names: copy what the page shows. A handwritten name may be hard to read; the request gives the members of the body for reference, so that you read a scrawl as the plausible member and not as a random word — but output the name in the spelling the page uses, never in the reference spelling. Never invent a name that the page does not show.`;

export interface SheetPromptInput {
    cityName: string;
    administrativeBodyName: string | null;
    date: string;
    agendaItems: MeetingAgendaItem[];
    roster: RosterPerson[];
    mayorId?: string;
    layoutNotes?: string | null;
}

function describeAgendaItem(item: MeetingAgendaItem): string {
    if (item.agendaItemIndex !== null) return `- Item ${item.agendaItemIndex}: ${item.name}`;
    if (item.outOfAgendaOrdinal !== null) return `- Out-of-agenda item ${item.outOfAgendaOrdinal}: ${item.name}`;
    return `- Non-agenda item: ${item.name}`;
}

function describeRosterPerson(p: RosterPerson): string {
    const parts = [p.name];
    if (p.role) parts.push(p.role);
    if (p.party) parts.push(p.party);
    return `- ${parts.join(' — ')}`;
}

export function buildSheetUserPrompt(input: SheetPromptInput): string {
    const parts: string[] = [];
    const body = input.administrativeBodyName ?? 'the municipal body';
    parts.push(`Read this attendance sheet of ${body}, ${input.cityName}, meeting of ${input.date}.`);

    const mayor = input.mayorId ? input.roster.find(p => p.id === input.mayorId) : undefined;
    if (mayor) parts.push(`The mayor is ${mayor.name}.`);

    if (input.agendaItems.length > 0) {
        parts.push(`The agenda items of this meeting:\n${input.agendaItems.map(describeAgendaItem).join('\n')}`);
    } else {
        parts.push('The agenda items of this meeting are not known.');
    }

    // Members of the body first: they are who the roll call lists. The rest of
    // the roster still helps read an official's name in a note.
    const members = input.roster.filter(p => p.memberOfMeetingBody);
    const others = input.roster.filter(p => !p.memberOfMeetingBody);
    if (members.length > 0) {
        parts.push(`Members of the body, for reference only (output names as the page spells them):\n${members.map(describeRosterPerson).join('\n')}`);
    }
    if (others.length > 0 && members.length > 0) {
        parts.push(`Other people of the city who may appear:\n${others.map(describeRosterPerson).join('\n')}`);
    } else if (others.length > 0) {
        parts.push(`People of the city, for reference only (output names as the page spells them):\n${others.map(describeRosterPerson).join('\n')}`);
    }

    const notes = input.layoutNotes?.trim();
    if (notes) {
        parts.push(`How this body's sheet is laid out, in the words of a person who knows it. Follow this over the default layouts:\n${notes}`);
    }

    return parts.join('\n\n');
}

/**
 * The cache key of one file's reading. The query string is dropped: the app
 * presigns the same object anew on every request, and only a re-upload moves
 * the object to a new path. Everything else the model was told — the roster,
 * the agenda items, the layout notes, the date — is in the user prompt, and a
 * hash of it is part of the key: a corrected roster or agenda is a new reading.
 */
export function sheetCacheKey(fileUrl: string, userPrompt?: string | null): string {
    const withoutQuery = fileUrl.split('?')[0];
    const prompt = userPrompt?.trim();
    if (!prompt) return withoutQuery;
    return `${withoutQuery}#${crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 12)}`;
}

const EXTENSION_MEDIA_TYPES: Record<string, SheetMediaType> = {
    '.pdf': 'application/pdf',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
};

/** The media type a local file's extension implies; null for an extension the reader does not take. */
export function mediaTypeFromExtension(filePath: string): SheetMediaType | null {
    return EXTENSION_MEDIA_TYPES[path.extname(filePath).toLowerCase()] ?? null;
}

export function isSheetMediaType(value: string): value is SheetMediaType {
    return Object.values(EXTENSION_MEDIA_TYPES).includes(value as SheetMediaType);
}

export function isImageMediaType(mediaType: SheetMediaType): mediaType is ImageMediaType {
    return mediaType.startsWith('image/');
}

/**
 * The largest image the model takes inline: 5 MB once base64-encoded. A phone
 * photo is often larger; the app accepts sheets up to 20 MB.
 */
export const MAX_INLINE_IMAGE_BYTES = Math.floor((5 * 1024 * 1024 * 3) / 4);

/** The longest page edge, in points, of a photo sent as a PDF: enough for the model's own rendering. */
const PHOTO_PAGE_MAX_POINTS = 1600;

/**
 * The sheet as the model takes it. A PDF goes as a document and a photo within
 * the inline limit as an image. A larger JPEG or PNG goes as a one-page PDF,
 * which the model takes up to 32 MB; a larger WebP or GIF cannot be wrapped and
 * is refused with a sentence that says what to upload instead.
 */
export async function sheetModelInput(bytes: Buffer, mediaType: SheetMediaType, maxInlineBytes: number = MAX_INLINE_IMAGE_BYTES): Promise<{ image: { base64: string; mediaType: ImageMediaType } } | { documentBase64: string }> {
    if (!isImageMediaType(mediaType)) return { documentBase64: bytes.toString('base64') };
    if (bytes.length <= maxInlineBytes) return { image: { base64: bytes.toString('base64'), mediaType } };
    if (mediaType !== 'image/jpeg' && mediaType !== 'image/png') {
        throw new Error(`The sheet is a ${(bytes.length / 1024 / 1024).toFixed(1)} MB ${mediaType} image; the reader takes at most ${(maxInlineBytes / 1024 / 1024).toFixed(1)} MB for that format. Upload it as JPEG, PNG or PDF.`);
    }
    const pdf = await PDFDocument.create();
    const picture = mediaType === 'image/jpeg' ? await pdf.embedJpg(bytes) : await pdf.embedPng(bytes);
    const scale = Math.min(1, PHOTO_PAGE_MAX_POINTS / Math.max(picture.width, picture.height));
    const width = picture.width * scale, height = picture.height * scale;
    pdf.addPage([width, height]).drawImage(picture, { x: 0, y: 0, width, height });
    return { documentBase64: Buffer.from(await pdf.save()).toString('base64') };
}

/** One model call over the sheet: see sheetModelInput for how the file is sent. */
export async function readSheetWithModel(input: { bytes: Buffer; mediaType: SheetMediaType; userPrompt: string }): Promise<ResultWithUsage<RawSheetReading>> {
    return aiChat<RawSheetReading>({
        systemPrompt: SHEET_SYSTEM_PROMPT,
        userPrompt: input.userPrompt,
        ...(await sheetModelInput(input.bytes, input.mediaType)),
        outputFormat: { type: 'json_schema', schema: SHEET_READING_SCHEMA },
        model: SHEET_READING_MODEL,
        maxTokens: SHEET_READING_MAX_TOKENS,
        label: 'attendance-sheet-reading',
    });
}

/** Every name the reading states, once each, in page order. */
export function collectSheetNames(raw: RawSheetReading): string[] {
    const names = new Set<string>();
    for (const e of raw.rollCall.entries) names.add(e.name);
    for (const c of raw.attendanceChanges) names.add(c.name);
    for (const v of raw.votes) for (const nv of v.namedVotes) names.add(nv.name);
    if (raw.presidedBy.name) names.add(raw.presidedBy.name);
    return [...names].filter(n => n.trim().length > 0);
}

export type NameMatchMethod = 'token' | 'llm';

export interface NameMatching {
    matches: Map<string, { personId: string; method: NameMatchMethod }>;
    usage: Anthropic.Messages.Usage;
}

export type LlmNameMatcher = (
    unmatchedNames: string[],
    people: PersonForMatching[],
) => Promise<{ matched: { name: string; personId: string }[]; stillUnmatched: string[]; usage: Anthropic.Messages.Usage }>;

/**
 * The two-step matcher the decision pipeline runs: token-sort first, then the
 * model for whatever is left. The model step is what reads a roster's
 * diminutive («Μανώλης») as the sheet's formal name («Εμμανουήλ»).
 */
export async function matchSheetNames(
    names: string[],
    roster: RosterPerson[],
    llmMatch: LlmNameMatcher = llmMatchMembers,
): Promise<NameMatching> {
    const people: PersonForMatching[] = roster.map(p => ({ id: p.id, name: p.name }));
    const matches = new Map<string, { personId: string; method: NameMatchMethod }>();
    for (const name of names) {
        const personId = matchPersonByName(name, people);
        if (personId) matches.set(name, { personId, method: 'token' });
    }
    const unmatched = names.filter(n => !matches.has(n));
    let usage: Anthropic.Messages.Usage = { ...NO_USAGE };
    if (unmatched.length > 0) {
        const llm = await llmMatch(unmatched, people);
        usage = addUsage(usage, llm.usage);
        for (const { name, personId } of llm.matched) matches.set(name, { personId, method: 'llm' });
    }
    return { matches, usage };
}

const nullIfZero = (n: number): number | null => (Number.isInteger(n) && n > 0 ? n : null);

function toWireChange(c: RawSheetChange, resolve: (name: string) => string | null): MeetingFactsChange {
    const a = c.anchor;
    const onItem = a.kind === 'agenda_item';
    return {
        personId: resolve(c.name),
        name: c.name,
        type: c.type,
        anchor: {
            kind: a.kind,
            agendaItemIndex: onItem ? nullIfZero(a.agendaItemIndex) : null,
            nonAgendaReason: onItem && a.outOfAgenda ? 'outOfAgenda' : null,
            decisionNumber: null,
            decisionNumberTo: null,
            subjectId: null,
            phase: a.kind === 'phase' && a.phase !== 'none' ? a.phase : null,
            timing: onItem && a.timing !== 'none' ? a.timing : null,
        },
        rawText: c.rawText,
        reportingPdfCount: 1,
        totalPdfCount: 1,
        utteranceId: null,
        line: nullIfZero(c.line),
    };
}

function toWireVote(v: RawSheetVote, resolve: (name: string) => string | null): StatedVote {
    return {
        items: v.items.filter(r => r.from > 0).map(r => ({ kind: r.kind, from: r.from, to: r.to >= r.from ? r.to : r.from })),
        outcome: v.outcome === 'not_stated' ? null : v.outcome,
        phrase: v.phrase,
        namedVotes: v.namedVotes.map(nv => ({ name: nv.name, personId: resolve(nv.name), vote: nv.vote, rawText: nv.rawText, utteranceId: null })),
        partyVotes: [],
        rawText: v.rawText,
        utteranceIds: [],
        line: nullIfZero(v.line),
        confidence: Math.max(0, Math.min(100, Math.round(v.confidence))),
    };
}

function toWireEntry(e: RawRollCallEntry, resolve: (name: string) => string | null): StatedRollCallEntry {
    return {
        name: e.name,
        personId: resolve(e.name),
        status: e.status,
        absenceJustified: e.status === 'ABSENT' && e.absenceJustified !== 'not_stated' ? e.absenceJustified === 'justified' : null,
        rawText: e.rawText,
        utteranceId: null,
        line: nullIfZero(e.line),
    };
}

/** The agenda-item anchors that name an item the meeting does not have. */
function unknownItemWarnings(changes: MeetingFactsChange[], agendaItems: MeetingAgendaItem[]): TaskWarning[] {
    const known = new Set(agendaItems.filter(i => i.agendaItemIndex !== null).map(i => i.agendaItemIndex));
    const knownOutOfAgenda = new Set(agendaItems.filter(i => i.outOfAgendaOrdinal !== null).map(i => i.outOfAgendaOrdinal));
    return changes.flatMap(c => {
        const index = c.anchor.agendaItemIndex;
        if (c.anchor.kind !== 'agenda_item' || index === null) return [];
        const outOfAgenda = c.anchor.nonAgendaReason === 'outOfAgenda';
        if ((outOfAgenda ? knownOutOfAgenda : known).has(index)) return [];
        return [{
            code: 'unknown_agenda_item',
            severity: 'warning' as const,
            message: `A note for ${c.name} names ${outOfAgenda ? 'out-of-agenda ' : ''}item ${index}, which the meeting does not have: «${c.rawText}»`,
        }];
    });
}

/**
 * The reading on the wire: names matched to ids, sentinels turned to nulls,
 * and a warning for what the page did not give.
 */
export function toMeetingFactsReading(raw: RawSheetReading, matching: NameMatching, agendaItems: MeetingAgendaItem[]): MeetingFactsReading {
    const resolve = (name: string) => matching.matches.get(name)?.personId ?? null;
    const warnings: TaskWarning[] = [];

    if (raw.unreadable) {
        warnings.push({ code: 'unreadable', severity: 'error', message: 'The page could not be read: too blurred, too dark, or not an attendance sheet.' });
    }

    const rollCall = raw.rollCall.found && raw.rollCall.entries.length > 0
        ? { entries: raw.rollCall.entries.map(e => toWireEntry(e, resolve)), rawText: raw.rollCall.rawText, utteranceIds: [] }
        : null;
    if (!rollCall && !raw.unreadable) {
        warnings.push({ code: 'no_roll_call', severity: 'warning', message: 'The page lists no members.' });
    }

    const attendanceChanges = raw.attendanceChanges.map(c => toWireChange(c, resolve));
    warnings.push(...unknownItemWarnings(attendanceChanges, agendaItems));

    const votes = raw.votes.map(v => toWireVote(v, resolve));

    const presidedBy = raw.presidedBy.name
        ? { name: raw.presidedBy.name, personId: resolve(raw.presidedBy.name), rawText: raw.presidedBy.rawText }
        : null;

    const names = collectSheetNames(raw);
    const nameMatches = names.map(name => {
        const match = matching.matches.get(name);
        return { name, personId: match?.personId ?? null, method: match?.method ?? null };
    });
    const unmatchedNames = names.filter(name => !matching.matches.has(name));

    return { rollCall, attendanceChanges, votes, presidedBy, nameMatches, unmatchedNames, warnings };
}
