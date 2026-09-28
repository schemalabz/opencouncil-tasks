import { aiChat, addUsage, NO_USAGE, type ResultWithUsage } from '../../lib/ai.js';
import { getLanguageConfig } from '../../lib/language.js';
import { chunkSegments, rosterKey, DEFAULT_CHUNK_CHARS, type SpeakerSegmentInput } from '../../lib/speakerIdentification.js';
import { isCancellation } from '../../lib/taskControl.js';
import { formatTime } from '../../utils.js';
import { matchSheetNames, type LlmNameMatcher, type NameMatching } from './attendanceSheetReading.js';
import type {
    CityLanguage,
    FixTranscriptRequest,
    ItemRange,
    MeetingAgendaItem,
    MeetingFactsChange,
    MeetingFactsReading,
    RequestOnTranscript,
    RosterPerson,
    StatedRollCallEntry,
    StatedVote,
    TaskWarning,
    VoteValue,
} from '../../types.js';

/*
 * The transcript meeting-facts pass (schemalabz/opencouncil#807): what the
 * meeting states about itself in speech — the roll call, the arrivals and
 * departures that someone announces, the votes as the chair or the deputy
 * mayor states them, and who presides. Only what the transcript states is a
 * fact; the app combines this reading with the sheet and the decision documents.
 *
 * The model reads the transcript as timestamped lines that carry a short
 * utterance key (u1, u2, ...) and quotes the keys back, the way the speaker
 * pass has it quote roster keys (P1, P2, ...) instead of database ids. Long
 * meetings are read in contiguous chunks that overlap a little, so a
 * statement at a boundary is read whole in one of them; the merge drops what
 * both chunks reported.
 */

export const TRANSCRIPT_FACTS_MODEL = 'claude-sonnet-4-6';

/**
 * Structured outputs cannot continue a truncated answer, so the cap has to
 * hold a full roll call of a council of 45 beside a chunk's votes.
 */
export const TRANSCRIPT_FACTS_MAX_TOKENS = 32000;

/** The tail of the previous chunk that the next chunk repeats, in characters. */
export const CHUNK_OVERLAP_CHARS = 4_000;
const DEFAULT_CONCURRENCY = 3;

export type TranscriptFactsInput = RequestOnTranscript & { people: RosterPerson[]; agendaItems?: MeetingAgendaItem[] };

export interface TranscriptFactsOptions {
    model?: string;
    /** Max characters of transcript per model call, overlap included. */
    chunkChars?: number;
    concurrency?: number;
    /** The model step of the name matcher; tests replace it. */
    llmMatch?: LlmNameMatcher;
}

/** One utterance as the model sees it: a line with a key it can quote back. */
export interface TranscriptLine extends SpeakerSegmentInput {
    key: string;
    utteranceId: string;
    speakerName: string | null;
}

export const utteranceKey = (index: number) => `u${index + 1}`;

/**
 * The reading as the model returns it. Structured outputs cap the number of
 * nullable parameters per schema, so "not stated" is an empty string, a zero
 * or a sentinel enum value here and becomes null in toTranscriptFactsReading.
 * `person` is the roster key the model believes a spoken name is, or "".
 */
export interface RawTranscriptFacts {
    rollCall: {
        /** False when the chunk has no roll call. */
        found: boolean;
        /** A short excerpt of the passage. */
        rawText: string;
        /** The keys of every utterance of the passage. */
        utterances: string[];
        entries: RawTranscriptRollCallEntry[];
    };
    attendanceChanges: RawTranscriptChange[];
    votes: RawTranscriptVote[];
    /** name "" when nobody but the chair is said to preside. */
    presidedBy: { name: string; person: string; rawText: string };
}

export interface RawTranscriptRollCallEntry {
    name: string;
    person: string;
    status: 'PRESENT' | 'ABSENT';
    absenceJustified: 'justified' | 'unjustified' | 'not_stated';
    rawText: string;
    utterance: string;
}

export interface RawTranscriptChange {
    name: string;
    person: string;
    type: 'arrival' | 'departure' | 'absent_for_vote';
    anchor: {
        kind: 'agenda_item' | 'session_start' | 'session_end';
        /** 0 when kind is not agenda_item. */
        agendaItemIndex: number;
        outOfAgenda: boolean;
        timing: 'before' | 'during' | 'after' | 'none';
    };
    rawText: string;
    utterance: string;
}

export interface RawTranscriptVote {
    items: ItemRange[];
    outcome: 'unanimous' | 'majority' | 'rejected' | 'not_stated';
    phrase: string;
    namedVotes: Array<{ name: string; person: string; vote: VoteValue; rawText: string; utterance: string }>;
    /** party "" when the answer is the speaker's own party. */
    partyVotes: Array<{ party: string; speakerUtterance: string; vote: VoteValue; rawText: string }>;
    rawText: string;
    utterances: string[];
    confidence: number;
}

const VOTE_VALUE_SCHEMA = { type: 'string', enum: ['FOR', 'AGAINST', 'ABSTAIN', 'PRESENT', 'DID_NOT_VOTE'] };

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

export const TRANSCRIPT_FACTS_SCHEMA = {
    type: 'object' as const,
    properties: {
        rollCall: {
            type: 'object',
            properties: {
                found: { type: 'boolean' },
                rawText: { type: 'string' },
                utterances: { type: 'array', items: { type: 'string' } },
                entries: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            name: { type: 'string' },
                            person: { type: 'string' },
                            status: { type: 'string', enum: ['PRESENT', 'ABSENT'] },
                            absenceJustified: { type: 'string', enum: ['justified', 'unjustified', 'not_stated'] },
                            rawText: { type: 'string' },
                            utterance: { type: 'string' },
                        },
                        required: ['name', 'person', 'status', 'absenceJustified', 'rawText', 'utterance'],
                        additionalProperties: false,
                    },
                },
            },
            required: ['found', 'rawText', 'utterances', 'entries'],
            additionalProperties: false,
        },
        attendanceChanges: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    person: { type: 'string' },
                    type: { type: 'string', enum: ['arrival', 'departure', 'absent_for_vote'] },
                    anchor: {
                        type: 'object',
                        properties: {
                            kind: { type: 'string', enum: ['agenda_item', 'session_start', 'session_end'] },
                            agendaItemIndex: { type: 'integer' },
                            outOfAgenda: { type: 'boolean' },
                            timing: { type: 'string', enum: ['before', 'during', 'after', 'none'] },
                        },
                        required: ['kind', 'agendaItemIndex', 'outOfAgenda', 'timing'],
                        additionalProperties: false,
                    },
                    rawText: { type: 'string' },
                    utterance: { type: 'string' },
                },
                required: ['name', 'person', 'type', 'anchor', 'rawText', 'utterance'],
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
                                person: { type: 'string' },
                                vote: VOTE_VALUE_SCHEMA,
                                rawText: { type: 'string' },
                                utterance: { type: 'string' },
                            },
                            required: ['name', 'person', 'vote', 'rawText', 'utterance'],
                            additionalProperties: false,
                        },
                    },
                    partyVotes: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                party: { type: 'string' },
                                speakerUtterance: { type: 'string' },
                                vote: VOTE_VALUE_SCHEMA,
                                rawText: { type: 'string' },
                            },
                            required: ['party', 'speakerUtterance', 'vote', 'rawText'],
                            additionalProperties: false,
                        },
                    },
                    rawText: { type: 'string' },
                    utterances: { type: 'array', items: { type: 'string' } },
                    confidence: { type: 'integer' },
                },
                required: ['items', 'outcome', 'phrase', 'namedVotes', 'partyVotes', 'rawText', 'utterances', 'confidence'],
                additionalProperties: false,
            },
        },
        presidedBy: {
            type: 'object',
            properties: { name: { type: 'string' }, person: { type: 'string' }, rawText: { type: 'string' } },
            required: ['name', 'person', 'rawText'],
            additionalProperties: false,
        },
    },
    required: ['rollCall', 'attendanceChanges', 'votes', 'presidedBy'],
    additionalProperties: false,
};

export function buildTranscriptFactsSystemPrompt(language: CityLanguage): string {
    const { promptName } = getLanguageConfig(language);
    return `You read the automatic transcript of a ${promptName} municipal meeting (council, committee, community council) and report what the meeting states about itself: the roll call, the arrivals and departures that someone announces, the votes as they are stated, and who presides. Report only what the transcript states. Never add what follows from two statements, and never guess.

The transcript comes as lines "[u<n> hh:mm:ss S<k> Name]: text". u<n> is the utterance key, which you quote back in every "utterance" field; S<k> is the diarization speaker label, and Name is the speaker when known ("?" otherwise). You also receive the agenda items with their numbers and the roster of the municipality under keys P1, P2, ...

The speech-to-text misspells names phonetically. Names in speech are usually surnames only, and a surname can be a common word («Δήμος», «Παπάς»). "name" is always the spoken form, copied from the transcript, never the roster's spelling. "person" is the roster key of the person you believe that name is, or "" when you cannot tell; check the whole roster, since several names sound alike.

1. **rollCall** — the passage where the secretary or the chair reads the names and marks presence, one name per utterance in the common case («Ο κύριος Γρίβας παρών.», «Η κυρία Στρακαντούνα απούσα.», «Δήμος.» «Παρών.»). Sometimes a member answers «παρών»/«παρούσα» to their own name: the entry then reads from the utterance that names them. One entry per name read, in order. "status" is PRESENT or ABSENT as stated. ABSENT only when the passage says so: «απών», «απούσα», «δεν είναι εδώ», «δεν φάνηκε», «δεν έχει συνδεθεί», «θα τον περιμένουμε», an excuse given for the member. A name read with no answer and no remark, the chair moving on, is PRESENT. "absenceJustified": "justified" only when the chair says the absence is justified («δικαιολογημένα απών», «ενημέρωσε ότι δεν θα έρθει»), "unjustified" when said so, "not_stated" otherwise and always for a present member. "utterance" is the key of the utterance the entry was read from; "rawText" that utterance's text. "utterances" lists the keys of every utterance of the passage, and "rawText" of the roll call is a short excerpt (its first lines). Set "found" to false and the lists to [] when this chunk has no roll call. A second count later in the meeting is a roll call too.

2. **attendanceChanges** — only arrivals and departures that someone states («προσήλθε ο κ. Χ», «αποχώρησε η κ. Υ», «ήρθε και η κυρία Ζ», «ο κύριος Χ αποχωρεί»), and a member said to be absent for one vote («ο κ. Χ δεν ψηφίζει στο 5ο», type "absent_for_vote"). In an online or hybrid meeting a stated connection is an arrival and a stated disconnection a departure: «συνδέθηκε ο κ. Χ», «μπήκε η κυρία Υ», a member saying they could not connect earlier («είχα τεχνικό πρόβλημα, δεν μπορούσα να συνδεθώ»), the chair noting that a member called absent at the roll call is now in. A member the roll call leaves waiting («δεν φάνηκε ακόμα», «θα τον περιμένουμε») is ABSENT on the roll call, and their stated connection later is the arrival. Most arrivals and departures are never spoken: report none for them. Never turn a first or a last utterance of a speaker into an arrival or a departure.
   "anchor": kind "agenda_item" with "agendaItemIndex" the number of the item under discussion when you can tell it — the chair announces items («Πάμε στο 14», «Θέμα 3ο», «το επόμενο θέμα») — and "timing" "before", "during" or "after"; "outOfAgenda" true when the item is an out-of-agenda one («1ο εκτός ημερησίας», «έκτακτο»), "agendaItemIndex" then being its position among the out-of-agenda items. Kind "session_start" for an arrival you cannot anchor to an item, "session_end" for a departure you cannot anchor; "agendaItemIndex" 0 and "timing" "none". An "absent_for_vote" always uses kind "agenda_item" with "timing" "during".

3. **votes** — every vote of this meeting as it is stated, one entry per vote. Forms to handle:
   - one vote covering several items: «Άρα τα οκτώ πρώτα θέματα εγκρίνονται ομόφωνα» → items [{"kind": "agenda_item", "from": 1, "to": 8}]; «τα 10, 11, 12, 13, 14, 15, 16 εγκρίνονται» → one range from 10 to 16; «θέματα 1-8» → one range. A single item is a range with from = to.
   - the chair polling the party leaders and each answering («Εμείς κατά», «Υπέρ.», «Λευκό»): one "partyVotes" entry per answer with "party" "" (the party is the speaker's own; the app resolves it) and "speakerUtterance" the key of the answering utterance; "party" is the name as spoken when the party is named («η Λαϊκή Συσπείρωση κατά»).
   - a named member's vote («κατά είπατε, κύριε Καραβίδα;» «Κατά.», «ο κ. Χ ψηφίζει λευκό»): one "namedVotes" entry with the spoken name, the vote and the utterance it was read from.
   - a member declaring their own vote on the item under discussion, usually as they close their statement just before the chair states the outcome: «καταψηφίζουμε», «ψηφίζουμε υπέρ», «είμαστε κατά», «εμείς θα απέχουμε», «εγώ απέχω». This is their vote on that item, not an intention: a "partyVotes" entry for a first person plural («εμείς», «καταψηφίζουμε»; party "", "speakerUtterance" the declaring utterance), a "namedVotes" entry for a first person singular (the speaker's name from the line, and the same utterance). Attach it to the vote the chair then states for that item.
   - a one-word answer when the chair asks for the members' votes: «Αρνητικά», «Όχι, αρνητικά», «Θετικά», «Ναι». When the line names the speaker, it is a "namedVotes" entry for them (AGAINST for αρνητικά/όχι, FOR for θετικά/ναι); when the speaker is "?", keep the answer in "rawText" only.
   - the outcome stated by the deputy mayor or the secretary rather than the chair, sometimes after the next item is announced («Πάμε στο 14.» … «Ομόφωνα;» «Ομόφωνα.» still belongs to item 13).
   - «Ομόφωνα» on a rejection («Απορρίπτεται… Ομόφωνα αποφασίζει το Δημοτικό Συμβούλιο να μην κοπεί») → outcome "rejected" with the phrase «Ομόφωνα».
   NOT a vote of this meeting: a statement about another body's vote, or in the past tense about an earlier meeting («Για τα δέντρα ψηφίσαμε λευκό» about the committee, «το έχουμε καταψηφίσει και από την αρχή» about an earlier decision, though the «είμαστε κατά» said with it is this vote); a procedural decision with no audible vote («Πιστεύω ότι τα βάζουμε έκτακτα»). Leave those out.
   "items": the ranges the vote covers, "kind" "agenda_item" or "out_of_agenda"; [] when you cannot tell which item is voted. "outcome": "unanimous" for «ομόφωνα»/«ομοφώνως», and for an approval in other words when nobody stated a vote against, a blank vote or an abstention on that item («γίνεται δεκτό», «εγκρίνεται ως η εισήγηση», «είμαστε όλοι σύμφωνοι», «καμία αντίρρηση»); "majority" for «κατά πλειοψηφία», and for such an approval when a member did state a vote against, a blank vote or an abstention on that item; "rejected" for «απορρίπτεται»/«δεν εγκρίνεται»; "not_stated" when neither an outcome nor an approval is spoken. "phrase" is the outcome as spoken. Vote values: «υπέρ»/«ναι»/«θετικά» → FOR, «κατά»/«όχι»/«αρνητικά» → AGAINST, «λευκό» → ABSTAIN, «παρών»/«παρούσα» as a vote → PRESENT, «απέχω»/«αποχή»/«δεν ψηφίζει» → DID_NOT_VOTE (the decisions record an abstention as not voting, and a blank vote as λευκό). Never infer a FOR vote from silence. "utterances" lists the keys of the utterances the vote was read from, "rawText" quotes them briefly. "confidence": 0–100, how sure you are that this is a vote of this meeting on these items.

4. **presidedBy** — the person said to preside when it is not the chair («προεδρεύει ο αντιπρόεδρος κ. Χ», the chair handing the session over); name "" otherwise.

When a chunk begins with lines marked as repeated from the previous chunk, read them like any other line: the reader removes what two chunks both report. Answer with JSON only.`;
}

export interface TranscriptFactsPromptInput {
    cityName: string;
    administrativeBodyName: string | null;
    date: string;
    agendaItems: MeetingAgendaItem[];
    roster: RosterPerson[];
    chunkIndex: number;
    chunkCount: number;
    lines: TranscriptLine[];
    /** How many lines at the start of this chunk repeat the end of the previous one. */
    overlapLines: number;
}

function describeAgendaItem(item: MeetingAgendaItem): string {
    if (item.agendaItemIndex !== null) return `- Item ${item.agendaItemIndex}: ${item.name}`;
    if (item.outOfAgendaOrdinal !== null) return `- Out-of-agenda item ${item.outOfAgendaOrdinal}: ${item.name}`;
    return `- Non-agenda item: ${item.name}`;
}

function describeRosterPerson(p: RosterPerson, key: string): string {
    const details = [p.role, p.party].filter(Boolean).join(', ');
    return `${key} — ${p.name}${details ? ` (${details})` : ''}`;
}

export function formatTranscriptLine(line: TranscriptLine): string {
    return `[${line.key} ${formatTime(line.start)} ${line.speakerLabel} ${line.speakerName ?? '?'}]: ${line.text}`;
}

export function buildTranscriptFactsUserPrompt(input: TranscriptFactsPromptInput): string {
    const parts: string[] = [];
    parts.push(`City: ${input.cityName}\nBody meeting: ${input.administrativeBodyName || '(unknown)'}\nMeeting date: ${input.date}`);

    parts.push(input.agendaItems.length > 0
        ? `Agenda items of this meeting:\n${input.agendaItems.map(describeAgendaItem).join('\n')}`
        : 'The agenda items of this meeting are not known.');

    const members = input.roster.filter(p => p.memberOfMeetingBody);
    const others = input.roster.filter(p => !p.memberOfMeetingBody);
    const rosterLine = (p: RosterPerson) => describeRosterPerson(p, rosterKey(input.roster.indexOf(p)));
    if (members.length > 0) {
        parts.push(`Members of ${input.administrativeBodyName || 'the meeting body'} (key — name (roles, party)):\n${members.map(rosterLine).join('\n')}`);
        parts.push(`Other people of the municipality:\n${others.length > 0 ? others.map(rosterLine).join('\n') : '(none)'}`);
    } else {
        parts.push(`Roster (key — name (roles, party)):\n${input.roster.map(rosterLine).join('\n')}`);
    }

    const overlapNote = input.overlapLines > 0
        ? `The first ${input.overlapLines} lines repeat the end of chunk ${input.chunkIndex} for context.\n`
        : '';
    parts.push(`Transcript chunk ${input.chunkIndex + 1} of ${input.chunkCount}:\n${overlapNote}${input.lines.map(formatTranscriptLine).join('\n')}`);

    return parts.join('\n\n');
}

/**
 * Every utterance of the transcript as a line, in time order, with a key
 * the model quotes back. Speaker labels S1, S2, ... follow the diarization
 * tag when the segment carries one, and the segment otherwise.
 */
export function buildTranscriptLines(transcript: RequestOnTranscript['transcript']): TranscriptLine[] {
    const labelBySpeaker = new Map<string, string>();
    const timed = transcript
        .filter(segment => segment.utterances.length > 0)
        .map(segment => ({ segment, start: segment.utterances[0].startTimestamp }))
        .sort((a, b) => a.start - b.start)
        .map(({ segment }) => segment);

    const lines: TranscriptLine[] = [];
    for (const segment of timed) {
        const speaker = segment.speakerTagId ?? segment.speakerId ?? segment.speakerSegmentId;
        if (!labelBySpeaker.has(speaker)) labelBySpeaker.set(speaker, `S${labelBySpeaker.size + 1}`);
        const speakerLabel = labelBySpeaker.get(speaker)!;
        for (const utterance of segment.utterances) {
            const text = utterance.text.trim();
            if (!text) continue;
            lines.push({
                key: utteranceKey(lines.length),
                utteranceId: utterance.utteranceId,
                speakerLabel,
                speakerName: segment.speakerName,
                start: utterance.startTimestamp,
                end: utterance.endTimestamp,
                text,
            });
        }
    }
    return lines;
}

export interface TranscriptChunk {
    lines: TranscriptLine[];
    overlapLines: number;
}

/**
 * Contiguous chunks of at most chunkChars, each after the first opening with
 * the tail of the previous one. A roll call or a vote that straddles a
 * boundary is then whole in at least one chunk.
 */
export function chunkTranscriptLines(lines: TranscriptLine[], chunkChars: number, overlapChars: number = CHUNK_OVERLAP_CHARS): TranscriptChunk[] {
    const lineSize = (line: TranscriptLine) => formatTranscriptLine(line).length + 1;
    // chunkSegments measures the text it is given, so it gets the line as the model will see it.
    const measured = lines.map(line => ({ line, speakerLabel: '', start: line.start, end: line.end, text: formatTranscriptLine(line) }));
    const base = chunkSegments(measured, Math.max(1000, chunkChars - overlapChars)).map(chunk => chunk.map(m => m.line));

    return base.map((chunk, index): TranscriptChunk => {
        if (index === 0) return { lines: chunk, overlapLines: 0 };
        const previous = base[index - 1];
        const tail: TranscriptLine[] = [];
        let chars = 0;
        for (let i = previous.length - 1; i >= 0; i--) {
            const size = lineSize(previous[i]);
            if (chars + size > overlapChars) break;
            tail.unshift(previous[i]);
            chars += size;
        }
        return { lines: [...tail, ...chunk], overlapLines: tail.length };
    });
}

const EMPTY_RAW: RawTranscriptFacts = {
    rollCall: { found: false, rawText: '', utterances: [], entries: [] },
    attendanceChanges: [],
    votes: [],
    presidedBy: { name: '', person: '', rawText: '' },
};

const itemsKey = (items: ItemRange[]) => normalizeItemRanges(items).map(r => `${r.kind}:${r.from}-${r.to}`).join(',');

/**
 * Two reports of one vote: an utterance both cite, or the same items and
 * outcome when every utterance either cites lies in the overlap the two chunks
 * share (one cites the call, the other the answer, of one passage read twice).
 * Two reports that cite utterances outside the overlap and share none are two
 * votes, even on the same items with the same outcome: an item put to the vote
 * again in the next chunk. Without the overlap, a report that cites nothing
 * is taken as the same vote, and two that both cite are taken as two.
 */
export function sameStatedVote(a: RawTranscriptVote, b: RawTranscriptVote, overlap?: ReadonlySet<string>): boolean {
    if (a.outcome !== b.outcome) return false;
    const sharedUtterance = a.utterances.some(u => b.utterances.includes(u));
    if (sharedUtterance) return true;
    const withinOverlap = (v: RawTranscriptVote) => (overlap ? v.utterances.every(u => overlap.has(u)) : v.utterances.length === 0);
    if (!withinOverlap(a) && !withinOverlap(b)) return false;
    if (overlap && !(withinOverlap(a) && withinOverlap(b))) return false;
    const key = itemsKey(a.items);
    return key.length > 0 && key === itemsKey(b.items);
}

/**
 * One reading from the per-chunk readings, in chunk order. The overlap makes
 * a chunk repeat what the previous one ended with: roll-call entries keep
 * the first chunk's report per utterance, changes the first per utterance and name,
 * and votes the first of two reports of the same vote. A vote is compared
 * with the previous chunk's only: the same items voted again much later is
 * a second vote, not a repeat.
 */
export function mergeChunkFacts(chunks: RawTranscriptFacts[], overlapKeys: string[][] = []): RawTranscriptFacts {
    const merged: RawTranscriptFacts = {
        rollCall: { found: false, rawText: '', utterances: [], entries: [] },
        attendanceChanges: [],
        votes: [],
        presidedBy: { name: '', person: '', rawText: '' },
    };
    // The utterances whose roll-call entries an earlier chunk already gave: the
    // overlap repeats them. Within one chunk every entry stands, because the
    // chair can read two names in one breath and both cite the same utterance.
    const entryUtterancesOfEarlierChunks = new Set<string>();
    const seenRollCallUtterances = new Set<string>();
    const seenChanges = new Set<string>();
    let previousVotes: RawTranscriptVote[] = [];

    for (const [index, chunk] of chunks.entries()) {
        // The utterances this chunk repeats from the previous one; none known when the caller gave none.
        const overlap = overlapKeys[index] ? new Set(overlapKeys[index]) : undefined;
        if (chunk.rollCall.found) {
            if (!merged.rollCall.found) {
                merged.rollCall.found = true;
                merged.rollCall.rawText = chunk.rollCall.rawText;
            }
            for (const key of chunk.rollCall.utterances) {
                if (seenRollCallUtterances.has(key)) continue;
                seenRollCallUtterances.add(key);
                merged.rollCall.utterances.push(key);
            }
            const entryUtterancesOfThisChunk = new Set<string>();
            for (const entry of chunk.rollCall.entries) {
                if (entry.utterance && entryUtterancesOfEarlierChunks.has(entry.utterance)) continue;
                if (entry.utterance) entryUtterancesOfThisChunk.add(entry.utterance);
                merged.rollCall.entries.push(entry);
            }
            for (const key of entryUtterancesOfThisChunk) entryUtterancesOfEarlierChunks.add(key);
        }
        for (const change of chunk.attendanceChanges) {
            const id = `${change.utterance}|${change.name}|${change.type}`;
            if (seenChanges.has(id)) continue;
            seenChanges.add(id);
            merged.attendanceChanges.push(change);
        }
        for (const vote of chunk.votes) {
            if (previousVotes.some(v => sameStatedVote(v, vote, overlap))) continue;
            merged.votes.push(vote);
        }
        // What the previous chunk stated, kept or not: a repeat of a repeat is still a repeat.
        previousVotes = chunk.votes;
        if (!merged.presidedBy.name && chunk.presidedBy.name) merged.presidedBy = chunk.presidedBy;
    }
    return merged;
}

/**
 * Sorted, overlapping and adjacent ranges of one kind folded into one:
 * «τα 10, 11, 12, 13, 14, 15, 16» reported as seven singletons is the range
 * 10 to 16. Ranges with a zero or negative start are dropped.
 */
export function normalizeItemRanges(items: ItemRange[]): ItemRange[] {
    const valid = items
        .filter(r => Number.isInteger(r.from) && r.from > 0)
        .map(r => ({ kind: r.kind, from: r.from, to: Number.isInteger(r.to) && r.to >= r.from ? r.to : r.from }))
        .sort((a, b) => a.kind.localeCompare(b.kind) || a.from - b.from);
    const folded: ItemRange[] = [];
    for (const range of valid) {
        const last = folded[folded.length - 1];
        if (last && last.kind === range.kind && range.from <= last.to + 1) {
            last.to = Math.max(last.to, range.to);
        } else {
            folded.push({ ...range });
        }
    }
    return folded;
}

/** The roster person behind a key the model wrote (P12), or null for anything else. */
export function resolveRosterKey(key: string, roster: RosterPerson[]): string | null {
    const match = key.trim().match(/^P(\d+)$/i);
    if (!match) return null;
    return roster[parseInt(match[1], 10) - 1]?.id ?? null;
}

/** Every spoken name the reading states, once each, in reading order, with the key the model gave it. */
export function collectTranscriptNames(raw: RawTranscriptFacts): Array<{ name: string; person: string }> {
    const seen = new Map<string, string>();
    const add = (name: string, person: string) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        const existing = seen.get(trimmed);
        if (existing === undefined || (!existing && person)) seen.set(trimmed, person);
    };
    for (const e of raw.rollCall.entries) add(e.name, e.person);
    for (const c of raw.attendanceChanges) add(c.name, c.person);
    for (const v of raw.votes) for (const nv of v.namedVotes) add(nv.name, nv.person);
    if (raw.presidedBy.name) add(raw.presidedBy.name, raw.presidedBy.person);
    return [...seen].map(([name, person]) => ({ name, person }));
}

/**
 * Names matched to ids. The model's own roster key counts as its match; the
 * two-step matcher of the sheet reader takes whatever the model left blank.
 */
export async function matchTranscriptNames(raw: RawTranscriptFacts, roster: RosterPerson[], llmMatch?: LlmNameMatcher): Promise<NameMatching> {
    const names = collectTranscriptNames(raw);
    const matches: NameMatching['matches'] = new Map();
    const unmatched: string[] = [];
    for (const { name, person } of names) {
        const personId = resolveRosterKey(person, roster);
        if (personId) matches.set(name, { personId, method: 'llm' });
        else unmatched.push(name);
    }
    const rest: NameMatching = unmatched.length > 0 ? await matchSheetNames(unmatched, roster, llmMatch) : { matches: new Map(), usage: { ...NO_USAGE } };
    for (const [name, match] of rest.matches) matches.set(name, match);
    return { matches, usage: rest.usage };
}

const nullIfZero = (n: number): number | null => (Number.isInteger(n) && n > 0 ? n : null);

interface Mapping {
    roster: RosterPerson[];
    matching: NameMatching;
    utteranceIdByKey: Map<string, string>;
    utteranceIdSet: Set<string>;
    unknownKeys: Set<string>;
}

function utteranceId(key: string, mapping: Mapping): string | null {
    const trimmed = key.trim();
    if (!trimmed) return null;
    const id = mapping.utteranceIdByKey.get(trimmed);
    if (id) return id;
    // The model may copy the real id when the request carried one it recognised.
    if (mapping.utteranceIdSet.has(trimmed)) return trimmed;
    mapping.unknownKeys.add(trimmed);
    return null;
}

function utteranceIds(keys: string[], mapping: Mapping): string[] {
    const ids: string[] = [];
    for (const key of keys) {
        const id = utteranceId(key, mapping);
        if (id && !ids.includes(id)) ids.push(id);
    }
    return ids;
}

/** The key the model gave this occurrence first, then whatever the name matched to. */
function resolvePerson(name: string, person: string, mapping: Mapping): string | null {
    return resolveRosterKey(person, mapping.roster) ?? mapping.matching.matches.get(name.trim())?.personId ?? null;
}

function toWireEntry(e: RawTranscriptRollCallEntry, mapping: Mapping): StatedRollCallEntry {
    return {
        name: e.name,
        personId: resolvePerson(e.name, e.person, mapping),
        status: e.status,
        absenceJustified: e.status === 'ABSENT' && e.absenceJustified !== 'not_stated' ? e.absenceJustified === 'justified' : null,
        rawText: e.rawText,
        utteranceId: utteranceId(e.utterance, mapping),
        line: null,
    };
}

function toWireChange(c: RawTranscriptChange, mapping: Mapping): MeetingFactsChange {
    const a = c.anchor;
    const onItem = a.kind === 'agenda_item';
    return {
        personId: resolvePerson(c.name, c.person, mapping),
        name: c.name,
        type: c.type,
        anchor: {
            kind: a.kind,
            agendaItemIndex: onItem ? nullIfZero(a.agendaItemIndex) : null,
            nonAgendaReason: onItem && a.outOfAgenda ? 'outOfAgenda' : null,
            decisionNumber: null,
            decisionNumberTo: null,
            subjectId: null,
            phase: null,
            timing: onItem && a.timing !== 'none' ? a.timing : null,
        },
        rawText: c.rawText,
        reportingPdfCount: 1,
        totalPdfCount: 1,
        utteranceId: utteranceId(c.utterance, mapping),
        line: null,
    };
}

function toWireVote(v: RawTranscriptVote, mapping: Mapping): StatedVote {
    return {
        items: normalizeItemRanges(v.items),
        outcome: v.outcome === 'not_stated' ? null : v.outcome,
        phrase: v.phrase,
        namedVotes: v.namedVotes.map(nv => ({
            name: nv.name,
            personId: resolvePerson(nv.name, nv.person, mapping),
            vote: nv.vote,
            rawText: nv.rawText,
            utteranceId: utteranceId(nv.utterance, mapping),
        })),
        partyVotes: v.partyVotes.map(pv => ({
            party: pv.party.trim() || null,
            speakerUtteranceId: utteranceId(pv.speakerUtterance, mapping),
            vote: pv.vote,
            rawText: pv.rawText,
        })),
        rawText: v.rawText,
        utteranceIds: utteranceIds(v.utterances, mapping),
        line: null,
        confidence: Math.max(0, Math.min(100, Math.round(v.confidence))),
    };
}

/** The agenda-item anchors and vote ranges that name an item the meeting does not have. */
function unknownItemWarnings(changes: MeetingFactsChange[], votes: StatedVote[], agendaItems: MeetingAgendaItem[]): TaskWarning[] {
    if (agendaItems.length === 0) return [];
    const known = new Set(agendaItems.filter(i => i.agendaItemIndex !== null).map(i => i.agendaItemIndex));
    const knownOutOfAgenda = new Set(agendaItems.filter(i => i.outOfAgendaOrdinal !== null).map(i => i.outOfAgendaOrdinal));
    const warnings: TaskWarning[] = [];
    for (const c of changes) {
        const index = c.anchor.agendaItemIndex;
        if (c.anchor.kind !== 'agenda_item' || index === null) continue;
        const outOfAgenda = c.anchor.nonAgendaReason === 'outOfAgenda';
        if ((outOfAgenda ? knownOutOfAgenda : known).has(index)) continue;
        warnings.push({
            code: 'unknown_agenda_item',
            severity: 'warning',
            message: `A statement about ${c.name} names ${outOfAgenda ? 'out-of-agenda ' : ''}item ${index}, which the meeting does not have: «${c.rawText}»`,
        });
    }
    for (const v of votes) {
        for (const r of v.items) {
            const set = r.kind === 'out_of_agenda' ? knownOutOfAgenda : known;
            const missing: number[] = [];
            for (let i = r.from; i <= r.to; i++) if (!set.has(i)) missing.push(i);
            if (missing.length === 0) continue;
            warnings.push({
                code: 'unknown_agenda_item',
                severity: 'warning',
                message: `A vote names ${r.kind === 'out_of_agenda' ? 'out-of-agenda ' : ''}item${missing.length > 1 ? 's' : ''} ${missing.join(', ')}, which the meeting does not have: «${v.rawText}»`,
            });
        }
    }
    return warnings;
}

/**
 * The reading on the wire: utterance keys turned back into ids, names
 * matched to ids, sentinels turned to nulls, and a warning for what the
 * transcript did not give.
 */
export function toTranscriptFactsReading(
    raw: RawTranscriptFacts,
    matching: NameMatching,
    lines: TranscriptLine[],
    roster: RosterPerson[],
    agendaItems: MeetingAgendaItem[],
): MeetingFactsReading {
    const mapping: Mapping = {
        roster,
        matching,
        utteranceIdByKey: new Map(lines.map(l => [l.key, l.utteranceId])),
        utteranceIdSet: new Set(lines.map(l => l.utteranceId)),
        unknownKeys: new Set(),
    };
    const warnings: TaskWarning[] = [];

    const rollCall = raw.rollCall.found && raw.rollCall.entries.length > 0
        ? {
            entries: raw.rollCall.entries.map(e => toWireEntry(e, mapping)),
            rawText: raw.rollCall.rawText,
            utteranceIds: utteranceIds(raw.rollCall.utterances, mapping),
        }
        : null;
    if (!rollCall) {
        warnings.push({ code: 'no_roll_call', severity: 'warning', message: 'The transcript states no roll call.' });
    }

    const attendanceChanges = raw.attendanceChanges.map(c => toWireChange(c, mapping));
    const votes = raw.votes.map(v => toWireVote(v, mapping));
    warnings.push(...unknownItemWarnings(attendanceChanges, votes, agendaItems));

    const presidedBy = raw.presidedBy.name.trim()
        ? { name: raw.presidedBy.name, personId: resolvePerson(raw.presidedBy.name, raw.presidedBy.person, mapping), rawText: raw.presidedBy.rawText }
        : null;

    if (mapping.unknownKeys.size > 0) {
        warnings.push({
            code: 'unknown_utterance',
            severity: 'warning',
            message: `The reader cited ${mapping.unknownKeys.size} utterance key(s) the transcript does not have: ${[...mapping.unknownKeys].slice(0, 5).join(', ')}`,
        });
    }

    const names = collectTranscriptNames(raw);
    const nameMatches = names.map(({ name, person }) => {
        const byKey = resolveRosterKey(person, roster);
        if (byKey) return { name, personId: byKey, method: 'llm' as const };
        const match = matching.matches.get(name);
        return { name, personId: match?.personId ?? null, method: match?.method ?? null };
    });
    const unmatchedNames = nameMatches.filter(m => m.personId === null).map(m => m.name);

    return { rollCall, attendanceChanges, votes, presidedBy, nameMatches, unmatchedNames, warnings };
}

/**
 * The pass over one request: the chunks read in parallel, merged, matched to
 * ids and mapped to the wire. Throws when a model call fails; the caller
 * decides whether that fails the task.
 */
export async function readTranscriptFacts(
    request: TranscriptFactsInput,
    onProgress: (stage: string, progressPercent: number) => void,
    options: TranscriptFactsOptions = {},
): Promise<ResultWithUsage<MeetingFactsReading>> {
    const { model = TRANSCRIPT_FACTS_MODEL, chunkChars = DEFAULT_CHUNK_CHARS, concurrency = DEFAULT_CONCURRENCY, llmMatch } = options;
    const agendaItems = request.agendaItems ?? [];
    const lines = buildTranscriptLines(request.transcript);
    const chunks = chunkTranscriptLines(lines, chunkChars);
    const systemPrompt = buildTranscriptFactsSystemPrompt(request.cityLanguage);
    console.log(`Reading meeting facts from ${lines.length} utterances across ${chunks.length} chunk(s) with ${model}`);

    let usage = { ...NO_USAGE };
    let done = 0;
    const chunkResults: RawTranscriptFacts[] = chunks.map(() => EMPTY_RAW);
    onProgress('reading transcript', 0);

    const runChunk = async (chunk: TranscriptChunk, index: number) => {
        const userPrompt = buildTranscriptFactsUserPrompt({
            cityName: request.cityName,
            administrativeBodyName: request.administrativeBodyName,
            date: request.date,
            agendaItems,
            roster: request.people,
            chunkIndex: index,
            chunkCount: chunks.length,
            lines: chunk.lines,
            overlapLines: chunk.overlapLines,
        });
        const result = await aiChat<RawTranscriptFacts>({
            model,
            label: `transcript-facts:${index + 1}/${chunks.length}`,
            systemPrompt,
            userPrompt,
            cacheSystemPrompt: true,
            maxTokens: TRANSCRIPT_FACTS_MAX_TOKENS,
            outputFormat: { type: 'json_schema', schema: TRANSCRIPT_FACTS_SCHEMA },
        });
        usage = addUsage(usage, result.usage);
        chunkResults[index] = result.result;
        done++;
        onProgress('reading transcript', Math.round((done / chunks.length) * 80));
    };

    for (let i = 0; i < chunks.length; i += concurrency) {
        await Promise.all(chunks.slice(i, i + concurrency).map((chunk, j) => runChunk(chunk, i + j)));
    }

    const raw = mergeChunkFacts(chunkResults, chunks.map(chunk => chunk.lines.slice(0, chunk.overlapLines).map(line => line.key)));
    onProgress('matching names', 85);
    const matching = await matchTranscriptNames(raw, request.people, llmMatch);
    usage = addUsage(usage, matching.usage);

    const reading = toTranscriptFactsReading(raw, matching, lines, request.people, agendaItems);
    onProgress('done', 100);
    return { result: reading, usage };
}

/**
 * The pass as fixTranscript runs it. Returns no reading when the pass did not
 * run — the request carries no people — or when it failed. A failure never
 * fails the task: the transcript corrections are the task's main result.
 */
export async function readMeetingFacts(request: FixTranscriptRequest): Promise<ResultWithUsage<MeetingFactsReading | undefined>> {
    if (!request.people || request.people.length === 0) return { result: undefined, usage: NO_USAGE };
    if (request.transcript.every(s => s.utterances.length === 0)) return { result: undefined, usage: NO_USAGE };

    try {
        const read = await readTranscriptFacts({ ...request, people: request.people }, () => undefined);
        return { result: read.result, usage: read.usage };
    } catch (error) {
        if (isCancellation(error)) throw error;
        console.error('Meeting-facts reading failed; returning no meeting facts:', error);
        return { result: undefined, usage: NO_USAGE };
    }
}
