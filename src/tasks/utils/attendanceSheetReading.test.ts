import { PDFDocument } from 'pdf-lib';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { MeetingAgendaItem, RosterPerson } from '../../types.js';

const { mockAiChat, NO_USAGE_MOCK } = vi.hoisted(() => ({
    mockAiChat: vi.fn(),
    NO_USAGE_MOCK: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
}));

// Only the model call is replaced; the usage helpers stay the real ones.
vi.mock('../../lib/ai.js', async (importOriginal) => ({
    ...await importOriginal<typeof import('../../lib/ai.js')>(),
    aiChat: mockAiChat,
    NO_USAGE: NO_USAGE_MOCK,
}));

import {
    buildSheetUserPrompt,
    collectSheetNames,
    isSheetMediaType,
    matchSheetNames,
    mediaTypeFromExtension,
    readSheetWithModel,
    sheetCacheKey,
    sheetModelInput,
    toMeetingFactsReading,
    type LlmNameMatcher,
    type NameMatching,
    type RawSheetReading,
} from './attendanceSheetReading.js';

const roster: RosterPerson[] = [
    { id: 'p-mayor', name: 'Γεώργιος Παπαδόπουλος', role: 'Δήμαρχος', party: null, memberOfMeetingBody: true },
    { id: 'p-manolis', name: 'Μανώλης Αλεξίου', role: 'Δημοτικός Σύμβουλος', party: 'Νέα Πόλη', memberOfMeetingBody: true },
    { id: 'p-maria', name: 'Μαρία Κωνσταντίνου', role: 'Δημοτική Σύμβουλος', party: 'Νέα Πόλη', memberOfMeetingBody: true },
    { id: 'p-clerk', name: 'Ελένη Γραμματέως', role: null, party: null, memberOfMeetingBody: false },
];

const agendaItems: MeetingAgendaItem[] = [
    { name: 'Έγκριση προϋπολογισμού', agendaItemIndex: 1, outOfAgendaOrdinal: null },
    { name: 'Ονοματοδοσία οδού', agendaItemIndex: 2, outOfAgendaOrdinal: null },
    { name: 'Κατεπείγον θέμα ύδρευσης', agendaItemIndex: null, outOfAgendaOrdinal: 1 },
];

function makeRaw(overrides: Partial<RawSheetReading> = {}): RawSheetReading {
    return {
        rollCall: {
            found: true,
            rawText: 'ΠΑΡΟΥΣΙΟΛΟΓΙΟ ΔΗΜΟΤΙΚΟΥ ΣΥΜΒΟΥΛΙΟΥ',
            entries: [
                { name: 'Κωνσταντίνου Μαρία', status: 'PRESENT', absenceJustified: 'not_stated', rawText: '① Κωνσταντίνου Μαρία [υπογραφή]', line: 1 },
                { name: 'Αλεξίου Εμμανουήλ', status: 'ABSENT', absenceJustified: 'justified', rawText: '2 Αλεξίου Εμμανουήλ δικ.', line: 2 },
                { name: 'Άγνωστος Κάποιος', status: 'ABSENT', absenceJustified: 'not_stated', rawText: '3 Άγνωστος Κάποιος', line: 3 },
            ],
        },
        attendanceChanges: [],
        votes: [],
        presidedBy: { name: '', rawText: '' },
        unreadable: false,
        ...overrides,
    };
}

const fullUsage = (input_tokens = 0): Anthropic.Messages.Usage => ({
    input_tokens, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null,
    cache_creation: null, server_tool_use: null, service_tier: null, inference_geo: null, output_tokens_details: null,
});

function matching(entries: Record<string, { personId: string; method: 'token' | 'llm' }>): NameMatching {
    return { matches: new Map(Object.entries(entries)), usage: fullUsage() };
}

const defaultMatching = () => matching({
    'Κωνσταντίνου Μαρία': { personId: 'p-maria', method: 'token' },
    'Αλεξίου Εμμανουήλ': { personId: 'p-manolis', method: 'llm' },
});

describe('buildSheetUserPrompt', () => {
    const prompt = buildSheetUserPrompt({
        cityName: 'Δήμος Παπάγου-Χολαργού',
        administrativeBodyName: 'Δημοτικό Συμβούλιο',
        date: '2026-03-12',
        agendaItems,
        roster,
        mayorId: 'p-mayor',
        layoutNotes: 'Ένας κύκλος γύρω από τον αριθμό σημαίνει παρών.',
    });

    it('names the meeting and the mayor', () => {
        expect(prompt).toContain('Δημοτικό Συμβούλιο, Δήμος Παπάγου-Χολαργού, meeting of 2026-03-12');
        expect(prompt).toContain('The mayor is Γεώργιος Παπαδόπουλος.');
    });

    it('lists the agenda items with their numbers', () => {
        expect(prompt).toContain('- Item 1: Έγκριση προϋπολογισμού');
        expect(prompt).toContain('- Item 2: Ονοματοδοσία οδού');
        expect(prompt).toContain('- Out-of-agenda item 1: Κατεπείγον θέμα ύδρευσης');
    });

    it('appends the layout notes', () => {
        expect(prompt).toContain('Ένας κύκλος γύρω από τον αριθμό σημαίνει παρών.');
    });

    it('lists members of the body apart from the rest of the roster', () => {
        expect(prompt).toContain('Members of the body, for reference only');
        expect(prompt).toContain('- Μανώλης Αλεξίου — Δημοτικός Σύμβουλος — Νέα Πόλη');
        expect(prompt).toContain('Other people of the city who may appear:\n- Ελένη Γραμματέως');
    });

    it('omits the notes and the mayor when the request has none', () => {
        const bare = buildSheetUserPrompt({ cityName: 'Δήμος', administrativeBodyName: null, date: '2026-01-01', agendaItems: [], roster: [] });
        expect(bare).toContain('the municipal body, Δήμος');
        expect(bare).toContain('The agenda items of this meeting are not known.');
        expect(bare).not.toContain('The mayor is');
        expect(bare).not.toContain('laid out');
    });
});

describe('sheetCacheKey', () => {
    it('drops the presign query so a re-presign of the same object hits', () => {
        expect(sheetCacheKey('https://s.example/sheet.jpg?X-Amz-Signature=abc')).toBe('https://s.example/sheet.jpg');
        expect(sheetCacheKey('https://s.example/sheet.jpg?X-Amz-Signature=abc')).toBe(sheetCacheKey('https://s.example/sheet.jpg?X-Amz-Signature=def'));
    });

    it('changes with the prompt: the roster, the agenda and the layout notes are in it', () => {
        const plain = sheetCacheKey('https://s.example/sheet.jpg');
        const one = sheetCacheKey('https://s.example/sheet.jpg', 'roster: a, b · circle means present');
        const other = sheetCacheKey('https://s.example/sheet.jpg', 'roster: a, b, c · circle means present');
        expect(one).not.toBe(plain);
        expect(one).not.toBe(other);
        expect(sheetCacheKey('https://s.example/sheet.jpg', '  ')).toBe(plain);
    });
});

describe('mediaTypeFromExtension', () => {
    it.each([
        ['/tmp/sheet.pdf', 'application/pdf'],
        ['/tmp/sheet.JPG', 'image/jpeg'],
        ['/tmp/sheet.jpeg', 'image/jpeg'],
        ['/tmp/sheet.png', 'image/png'],
        ['/tmp/sheet.webp', 'image/webp'],
        ['/tmp/sheet.gif', 'image/gif'],
        ['/tmp/sheet.txt', null],
    ])('%s → %s', (file, expected) => {
        expect(mediaTypeFromExtension(file)).toBe(expected);
    });

    it('isSheetMediaType accepts only the wire media types', () => {
        expect(isSheetMediaType('image/webp')).toBe(true);
        expect(isSheetMediaType('image/tiff')).toBe(false);
    });
});

describe('readSheetWithModel', () => {
    beforeEach(() => {
        mockAiChat.mockReset();
        mockAiChat.mockResolvedValue({ result: makeRaw(), usage: NO_USAGE_MOCK });
    });

    it('sends an image as an image block with its media type', async () => {
        await readSheetWithModel({ bytes: Buffer.from('img'), mediaType: 'image/webp', userPrompt: 'read' });
        const call = mockAiChat.mock.calls[0][0];
        expect(call.image).toEqual({ base64: Buffer.from('img').toString('base64'), mediaType: 'image/webp' });
        expect(call.documentBase64).toBeUndefined();
        expect(call.outputFormat.type).toBe('json_schema');
        expect(call.userPrompt).toBe('read');
    });

    it('sends a PDF as a document', async () => {
        await readSheetWithModel({ bytes: Buffer.from('%PDF'), mediaType: 'application/pdf', userPrompt: 'read' });
        const call = mockAiChat.mock.calls[0][0];
        expect(call.documentBase64).toBe(Buffer.from('%PDF').toString('base64'));
        expect(call.image).toBeUndefined();
    });
});

describe('collectSheetNames', () => {
    it('gathers every name once, in page order, and skips blanks', () => {
        const raw = makeRaw({
            attendanceChanges: [{ name: 'Κωνσταντίνου Μαρία', type: 'departure', anchor: { kind: 'session_end', agendaItemIndex: 0, outOfAgenda: false, phase: 'none', timing: 'none' }, rawText: 'αποχώρησε', line: 1 }],
            votes: [{ items: [], outcome: 'not_stated', phrase: '', namedVotes: [{ name: 'Νέος Ψηφοφόρος', vote: 'AGAINST', rawText: 'ΚΑΤΑ' }], rawText: '', line: 0, confidence: 50 }],
            presidedBy: { name: '  ', rawText: '' },
        });
        expect(collectSheetNames(raw)).toEqual(['Κωνσταντίνου Μαρία', 'Αλεξίου Εμμανουήλ', 'Άγνωστος Κάποιος', 'Νέος Ψηφοφόρος']);
    });
});

describe('matchSheetNames', () => {
    it('matches by token-sort first and asks the model only for the rest', async () => {
        const llm: LlmNameMatcher = vi.fn(async (names) => ({
            matched: names.filter(n => n === 'Αλεξίου Εμμανουήλ').map(name => ({ name, personId: 'p-manolis' })),
            stillUnmatched: names.filter(n => n !== 'Αλεξίου Εμμανουήλ'),
            usage: fullUsage(7),
        }));
        const result = await matchSheetNames(['Κωνσταντίνου Μαρία', 'Αλεξίου Εμμανουήλ', 'Άγνωστος Κάποιος'], roster, llm);

        expect(llm).toHaveBeenCalledWith(['Αλεξίου Εμμανουήλ', 'Άγνωστος Κάποιος'], roster.map(p => ({ id: p.id, name: p.name })));
        expect(result.matches.get('Κωνσταντίνου Μαρία')).toEqual({ personId: 'p-maria', method: 'token' });
        expect(result.matches.get('Αλεξίου Εμμανουήλ')).toEqual({ personId: 'p-manolis', method: 'llm' });
        expect(result.matches.has('Άγνωστος Κάποιος')).toBe(false);
        expect(result.usage.input_tokens).toBe(7);
    });

    it('does not call the model when token-sort matched everything', async () => {
        const llm: LlmNameMatcher = vi.fn();
        const result = await matchSheetNames(['Μαρία Κωνσταντίνου'], roster, llm);
        expect(llm).not.toHaveBeenCalled();
        expect(result.matches.get('Μαρία Κωνσταντίνου')?.personId).toBe('p-maria');
    });
});

describe('toMeetingFactsReading', () => {
    it('carries the roll call with matched ids, lines and justified absences', () => {
        const reading = toMeetingFactsReading(makeRaw(), defaultMatching(), agendaItems);

        expect(reading.rollCall).toEqual({
            rawText: 'ΠΑΡΟΥΣΙΟΛΟΓΙΟ ΔΗΜΟΤΙΚΟΥ ΣΥΜΒΟΥΛΙΟΥ',
            utteranceIds: [],
            entries: [
                { name: 'Κωνσταντίνου Μαρία', personId: 'p-maria', status: 'PRESENT', absenceJustified: null, rawText: '① Κωνσταντίνου Μαρία [υπογραφή]', utteranceId: null, line: 1 },
                { name: 'Αλεξίου Εμμανουήλ', personId: 'p-manolis', status: 'ABSENT', absenceJustified: true, rawText: '2 Αλεξίου Εμμανουήλ δικ.', utteranceId: null, line: 2 },
                { name: 'Άγνωστος Κάποιος', personId: null, status: 'ABSENT', absenceJustified: null, rawText: '3 Άγνωστος Κάποιος', utteranceId: null, line: 3 },
            ],
        });
        expect(reading.warnings).toEqual([]);
    });

    it('reports how each name was matched and lists the unmatched', () => {
        const reading = toMeetingFactsReading(makeRaw(), defaultMatching(), agendaItems);
        expect(reading.nameMatches).toEqual([
            { name: 'Κωνσταντίνου Μαρία', personId: 'p-maria', method: 'token' },
            { name: 'Αλεξίου Εμμανουήλ', personId: 'p-manolis', method: 'llm' },
            { name: 'Άγνωστος Κάποιος', personId: null, method: null },
        ]);
        expect(reading.unmatchedNames).toEqual(['Άγνωστος Κάποιος']);
    });

    it('turns an absent-for-item note into absent_for_vote on an agenda_item anchor', () => {
        const raw = makeRaw({
            attendanceChanges: [{
                name: 'Κωνσταντίνου Μαρία', type: 'absent_for_vote',
                anchor: { kind: 'agenda_item', agendaItemIndex: 2, outOfAgenda: false, phase: 'none', timing: 'during' },
                rawText: 'απούσα στο 2ο θέμα', line: 1,
            }],
        });
        const reading = toMeetingFactsReading(raw, defaultMatching(), agendaItems);
        expect(reading.attendanceChanges).toEqual([{
            personId: 'p-maria', name: 'Κωνσταντίνου Μαρία', type: 'absent_for_vote',
            anchor: { kind: 'agenda_item', agendaItemIndex: 2, nonAgendaReason: null, decisionNumber: null, decisionNumberTo: null, subjectId: null, phase: null, timing: 'during' },
            rawText: 'απούσα στο 2ο θέμα', reportingPdfCount: 1, totalPdfCount: 1, utteranceId: null, line: 1,
        }]);
        expect(reading.warnings).toEqual([]);
    });

    it('maps the other anchors: out-of-agenda item, phase, clock time, unanchored', () => {
        const raw = makeRaw({
            attendanceChanges: [
                { name: 'Αλεξίου Εμμανουήλ', type: 'arrival', anchor: { kind: 'agenda_item', agendaItemIndex: 1, outOfAgenda: true, phase: 'none', timing: 'before' }, rawText: 'προσήλθε πριν το 1ο ΕΗΔ', line: 2 },
                { name: 'Αλεξίου Εμμανουήλ', type: 'departure', anchor: { kind: 'phase', agendaItemIndex: 0, outOfAgenda: false, phase: 'out_of_agenda', timing: 'none' }, rawText: 'αποχώρησε στα εκτός ημερησίας', line: 2 },
                { name: 'Κωνσταντίνου Μαρία', type: 'arrival', anchor: { kind: 'session_start', agendaItemIndex: 0, outOfAgenda: false, phase: 'none', timing: 'none' }, rawText: 'προσήλθε 20:45', line: 0 },
                { name: 'Κωνσταντίνου Μαρία', type: 'departure', anchor: { kind: 'session_end', agendaItemIndex: 0, outOfAgenda: false, phase: 'none', timing: 'none' }, rawText: 'αποχώρησε', line: 1 },
            ],
        });
        const anchors = toMeetingFactsReading(raw, defaultMatching(), agendaItems).attendanceChanges.map(c => [c.anchor.kind, c.anchor.agendaItemIndex, c.anchor.nonAgendaReason, c.anchor.phase, c.anchor.timing, c.line]);
        expect(anchors).toEqual([
            ['agenda_item', 1, 'outOfAgenda', null, 'before', 2],
            ['phase', null, null, 'out_of_agenda', null, 2],
            ['session_start', null, null, null, null, null],
            ['session_end', null, null, null, null, 1],
        ]);
    });

    it('warns when a note names an item the meeting does not have', () => {
        const raw = makeRaw({
            attendanceChanges: [{ name: 'Κωνσταντίνου Μαρία', type: 'arrival', anchor: { kind: 'agenda_item', agendaItemIndex: 9, outOfAgenda: false, phase: 'none', timing: 'during' }, rawText: 'προσήλθε στο 9ο', line: 1 }],
        });
        const reading = toMeetingFactsReading(raw, defaultMatching(), agendaItems);
        expect(reading.warnings).toEqual([expect.objectContaining({ code: 'unknown_agenda_item', severity: 'warning' })]);
        expect(reading.attendanceChanges[0].anchor.agendaItemIndex).toBe(9);
    });

    it('carries per-item votes with matched voters and a null outcome for not_stated', () => {
        const raw = makeRaw({
            votes: [
                { items: [{ kind: 'agenda_item', from: 2, to: 8 }], outcome: 'majority', phrase: 'πλειοψ.', namedVotes: [{ name: 'Αλεξίου Εμμανουήλ', vote: 'AGAINST', rawText: 'ΚΑΤΑ Αλεξίου' }], rawText: 'θέματα 2-8 πλειοψ. ΚΑΤΑ Αλεξίου', line: 12, confidence: 140 },
                { items: [{ kind: 'out_of_agenda', from: 1, to: 0 }], outcome: 'not_stated', phrase: '', namedVotes: [], rawText: '1ο ΕΗΔ', line: 0, confidence: 30 },
            ],
        });
        const { votes } = toMeetingFactsReading(raw, defaultMatching(), agendaItems);
        expect(votes).toEqual([
            {
                items: [{ kind: 'agenda_item', from: 2, to: 8 }], outcome: 'majority', phrase: 'πλειοψ.',
                namedVotes: [{ name: 'Αλεξίου Εμμανουήλ', personId: 'p-manolis', vote: 'AGAINST', rawText: 'ΚΑΤΑ Αλεξίου', utteranceId: null }],
                partyVotes: [], rawText: 'θέματα 2-8 πλειοψ. ΚΑΤΑ Αλεξίου', utteranceIds: [], line: 12, confidence: 100,
            },
            {
                items: [{ kind: 'out_of_agenda', from: 1, to: 1 }], outcome: null, phrase: '',
                namedVotes: [], partyVotes: [], rawText: '1ο ΕΗΔ', utteranceIds: [], line: null, confidence: 30,
            },
        ]);
    });

    it('resolves who presided, or null when the page names nobody', () => {
        const named = toMeetingFactsReading(makeRaw({ presidedBy: { name: 'Κωνσταντίνου Μαρία', rawText: 'Προεδρεύουσα: Κωνσταντίνου Μαρία' } }), defaultMatching(), agendaItems);
        expect(named.presidedBy).toEqual({ name: 'Κωνσταντίνου Μαρία', personId: 'p-maria', rawText: 'Προεδρεύουσα: Κωνσταντίνου Μαρία' });
        expect(toMeetingFactsReading(makeRaw(), defaultMatching(), agendaItems).presidedBy).toBeNull();
    });

    it('returns a null roll call with a warning when the page lists nobody', () => {
        const reading = toMeetingFactsReading(makeRaw({ rollCall: { found: false, rawText: '', entries: [] } }), matching({}), agendaItems);
        expect(reading.rollCall).toBeNull();
        expect(reading.warnings).toEqual([expect.objectContaining({ code: 'no_roll_call', severity: 'warning' })]);
    });

    it('reports an unreadable page as an error and nothing else', () => {
        const reading = toMeetingFactsReading(makeRaw({ unreadable: true, rollCall: { found: false, rawText: '', entries: [] } }), matching({}), agendaItems);
        expect(reading.rollCall).toBeNull();
        expect(reading.warnings).toEqual([expect.objectContaining({ code: 'unreadable', severity: 'error' })]);
    });
});

describe('sheetModelInput', () => {
    // A 1×1 PNG.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

    it('sends a small photo inline and a PDF as a document', async () => {
        expect(await sheetModelInput(png, 'image/png')).toEqual({ image: { base64: png.toString('base64'), mediaType: 'image/png' } });
        expect(await sheetModelInput(Buffer.from('%PDF-1.4'), 'application/pdf')).toEqual({ documentBase64: Buffer.from('%PDF-1.4').toString('base64') });
    });

    it('wraps a photo over the inline limit in a one-page PDF', async () => {
        const input = await sheetModelInput(png, 'image/png', 10);
        expect('documentBase64' in input).toBe(true);
        const pdf = await PDFDocument.load(Buffer.from((input as { documentBase64: string }).documentBase64, 'base64'));
        expect(pdf.getPageCount()).toBe(1);
    });

    it('refuses a WebP or GIF over the limit, saying what to upload instead', async () => {
        await expect(sheetModelInput(png, 'image/webp', 10)).rejects.toThrow(/Upload it as JPEG, PNG or PDF/);
    });
});
