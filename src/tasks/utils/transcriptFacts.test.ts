import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { FixTranscriptRequest, MeetingAgendaItem, RosterPerson } from '../../types.js';
import { TaskCancelledError } from '../../lib/taskControl.js';

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

import type { LlmNameMatcher, NameMatching } from './attendanceSheetReading.js';
import {
    buildTranscriptFactsUserPrompt,
    buildTranscriptLines,
    chunkTranscriptLines,
    collectTranscriptNames,
    formatTranscriptLine,
    matchTranscriptNames,
    mergeChunkFacts,
    normalizeItemRanges,
    readMeetingFacts,
    readTranscriptFacts,
    sameStatedVote,
    toTranscriptFactsReading,
    type RawTranscriptFacts,
    type RawTranscriptVote,
    type TranscriptLine,
} from './transcriptFacts.js';

const roster: RosterPerson[] = [
    { id: 'p-chair', name: 'Νικόλαος Κρανιώτης', role: 'Πρόεδρος Δ.Σ.', party: 'Νέα Πόλη', memberOfMeetingBody: true },
    { id: 'p-grivas', name: 'Ιωάννης Γρίβας', role: 'Δημοτικός Σύμβουλος', party: 'Νέα Πόλη', memberOfMeetingBody: true },
    { id: 'p-karavidas', name: 'Δημήτριος Καραβίδας', role: 'Δημοτικός Σύμβουλος', party: 'Λαϊκή Συσπείρωση', memberOfMeetingBody: true },
    { id: 'p-dimos', name: 'Πέτρος Δήμος', role: 'Δημοτικός Σύμβουλος', party: 'Νέα Πόλη', memberOfMeetingBody: true },
    { id: 'p-clerk', name: 'Ελένη Γραμματέως', role: null, party: null, memberOfMeetingBody: false },
];

const agendaItems: MeetingAgendaItem[] = [
    { name: 'Έγκριση προϋπολογισμού', agendaItemIndex: 1, outOfAgendaOrdinal: null },
    { name: 'Ονοματοδοσία οδού', agendaItemIndex: 2, outOfAgendaOrdinal: null },
    { name: 'Κατεπείγον θέμα ύδρευσης', agendaItemIndex: null, outOfAgendaOrdinal: 1 },
];

type Segment = FixTranscriptRequest['transcript'][number];

function segment(tag: string | undefined, name: string | null, start: number, texts: string[], idPrefix = tag ?? 'seg'): Segment {
    return {
        speakerName: name,
        speakerParty: null,
        speakerRole: null,
        speakerId: null,
        speakerSegmentId: `seg-${idPrefix}-${start}`,
        speakerTagId: tag,
        text: texts.join(' '),
        utterances: texts.map((text, i) => ({
            text,
            utteranceId: `utt-${idPrefix}-${start}-${i}`,
            startTimestamp: start + i * 5,
            endTimestamp: start + i * 5 + 4,
        })),
    };
}

const transcript: Segment[] = [
    segment('tag-a', 'Κρανιώτης', 0, ['Ξεκινάμε με την ανάγνωση των παρόντων.', 'Ο κύριος Γρίβας παρών.', 'Ο κύριος Δήμος απών.']),
    segment('tag-b', null, 20, ['Πάμε στο 2.', 'Εμείς κατά.']),
    segment('tag-a', 'Κρανιώτης', 40, ['Κατά είπατε, κύριε Καραβίδα;', 'Άρα το 2 εγκρίνεται κατά πλειοψηφία.']),
];

function request(overrides: Partial<FixTranscriptRequest> = {}): FixTranscriptRequest {
    return {
        callbackUrl: '',
        transcript,
        topicLabels: [],
        cityName: 'Χανιά',
        cityLanguage: 'el',
        administrativeBodyName: 'Δημοτικό Συμβούλιο',
        partiesWithPeople: [],
        date: '2026-09-09',
        roster,
        agendaItems,
        ...overrides,
    };
}

const fullUsage = (input_tokens = 0): Anthropic.Messages.Usage => ({
    input_tokens, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null,
    cache_creation: null, server_tool_use: null, service_tier: null, inference_geo: null, output_tokens_details: null,
});

const emptyRaw = (): RawTranscriptFacts => ({
    rollCall: { found: false, rawText: '', utterances: [], entries: [] },
    attendanceChanges: [],
    votes: [],
    presidedBy: { name: '', person: '', rawText: '' },
});

function vote(overrides: Partial<RawTranscriptVote> = {}): RawTranscriptVote {
    return {
        items: [{ kind: 'agenda_item', from: 2, to: 2 }],
        outcome: 'majority',
        phrase: 'κατά πλειοψηφία',
        namedVotes: [],
        partyVotes: [],
        rawText: 'Άρα το 2 εγκρίνεται κατά πλειοψηφία.',
        utterances: ['u7'],
        confidence: 90,
        ...overrides,
    };
}

function makeRaw(overrides: Partial<RawTranscriptFacts> = {}): RawTranscriptFacts {
    return {
        rollCall: {
            found: true,
            rawText: 'Ξεκινάμε με την ανάγνωση των παρόντων. Ο κύριος Γρίβας παρών.',
            utterances: ['u1', 'u2', 'u3'],
            entries: [
                { name: 'Γρίβας', person: 'P2', status: 'PRESENT', absenceJustified: 'not_stated', rawText: 'Ο κύριος Γρίβας παρών.', utterance: 'u2' },
                { name: 'Δήμος', person: '', status: 'ABSENT', absenceJustified: 'not_stated', rawText: 'Ο κύριος Δήμος απών.', utterance: 'u3' },
            ],
        },
        attendanceChanges: [],
        votes: [vote({
            namedVotes: [{ name: 'Καραβίδα', person: 'P3', vote: 'AGAINST', rawText: 'Κατά είπατε, κύριε Καραβίδα;', utterance: 'u6' }],
            partyVotes: [{ party: '', speakerUtterance: 'u5', vote: 'AGAINST', rawText: 'Εμείς κατά.' }],
            utterances: ['u5', 'u6', 'u7'],
        })],
        presidedBy: { name: '', person: '', rawText: '' },
        ...overrides,
    };
}

/** The raw reading with one more roll-call entry whose spoken name is on no roster. */
function withUnknownName(raw: RawTranscriptFacts): RawTranscriptFacts {
    raw.rollCall.entries.push({ name: 'Στρακαντούνα', person: '', status: 'ABSENT', absenceJustified: 'not_stated', rawText: 'Η κυρία Στρακαντούνα απούσα.', utterance: 'u1' });
    return raw;
}

function matching(entries: Record<string, { personId: string; method: 'token' | 'llm' }>): NameMatching {
    return { matches: new Map(Object.entries(entries)), usage: fullUsage() };
}

describe('buildTranscriptLines', () => {
    const lines = buildTranscriptLines(transcript);

    it('numbers every utterance in time order and keeps its id', () => {
        expect(lines.map(l => l.key)).toEqual(['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7']);
        expect(lines[1].utteranceId).toBe('utt-tag-a-0-1');
        expect(lines[4].utteranceId).toBe('utt-tag-b-20-1');
    });

    it('labels speakers by tag in order of first speech', () => {
        expect(lines.map(l => l.speakerLabel)).toEqual(['S1', 'S1', 'S1', 'S2', 'S2', 'S1', 'S1']);
    });

    it('formats a line the model can quote back', () => {
        expect(formatTranscriptLine(lines[1])).toBe('[u2 00:00:05 S1 Κρανιώτης]: Ο κύριος Γρίβας παρών.');
        expect(formatTranscriptLine(lines[3])).toBe('[u4 00:00:20 S2 ?]: Πάμε στο 2.');
    });

    it('skips empty utterances without breaking the numbering', () => {
        const withEmpty = buildTranscriptLines([segment('tag-a', null, 0, ['Ένα.', '   ', 'Δύο.'])]);
        expect(withEmpty.map(l => [l.key, l.text])).toEqual([['u1', 'Ένα.'], ['u2', 'Δύο.']]);
    });
});

describe('buildTranscriptFactsUserPrompt', () => {
    const lines = buildTranscriptLines(transcript);
    const prompt = buildTranscriptFactsUserPrompt({
        cityName: 'Χανιά',
        administrativeBodyName: 'Δημοτικό Συμβούλιο',
        date: '2026-09-09',
        agendaItems,
        roster,
        chunkIndex: 0,
        chunkCount: 1,
        lines,
        overlapLines: 0,
    });

    it('lists the agenda items with their numbers', () => {
        expect(prompt).toContain('- Item 1: Έγκριση προϋπολογισμού');
        expect(prompt).toContain('- Item 2: Ονοματοδοσία οδού');
        expect(prompt).toContain('- Out-of-agenda item 1: Κατεπείγον θέμα ύδρευσης');
    });

    it('lists the roster under keys, members of the body first', () => {
        expect(prompt).toContain('Members of Δημοτικό Συμβούλιο');
        expect(prompt).toContain('P2 — Ιωάννης Γρίβας (Δημοτικός Σύμβουλος, Νέα Πόλη)');
        expect(prompt).toContain('Other people of the municipality:\nP5 — Ελένη Γραμματέως');
    });

    it('carries the transcript lines with utterance keys', () => {
        expect(prompt).toContain('[u2 00:00:05 S1 Κρανιώτης]: Ο κύριος Γρίβας παρών.');
        expect(prompt).toContain('[u5 00:00:25 S2 ?]: Εμείς κατά.');
        expect(prompt).not.toContain('repeat the end of chunk');
    });

    it('says how many lines repeat the previous chunk', () => {
        const second = buildTranscriptFactsUserPrompt({
            cityName: 'Χανιά', administrativeBodyName: null, date: '2026-09-09', agendaItems: [], roster, chunkIndex: 1, chunkCount: 2, lines, overlapLines: 2,
        });
        expect(second).toContain('Transcript chunk 2 of 2:\nThe first 2 lines repeat the end of chunk 1 for context.');
        expect(second).toContain('The agenda items of this meeting are not known.');
    });
});

describe('chunkTranscriptLines', () => {
    const lines: TranscriptLine[] = Array.from({ length: 20 }, (_, i) => ({
        key: `u${i + 1}`,
        utteranceId: `utt-${i + 1}`,
        speakerLabel: 'S1',
        speakerName: 'Κρανιώτης',
        start: i * 10,
        end: i * 10 + 5,
        text: 'x'.repeat(100),
    }));

    it('keeps one chunk when the transcript fits', () => {
        const chunks = chunkTranscriptLines(lines, 100_000, 0);
        expect(chunks).toHaveLength(1);
        expect(chunks[0].overlapLines).toBe(0);
        expect(chunks[0].lines).toHaveLength(20);
    });

    it('opens each later chunk with the tail of the previous one', () => {
        const chunks = chunkTranscriptLines(lines, 1_400, 300);
        expect(chunks.length).toBeGreaterThan(1);
        for (let i = 1; i < chunks.length; i++) {
            const { lines: chunkLines, overlapLines } = chunks[i];
            expect(overlapLines).toBe(2);
            const previous = chunks[i - 1].lines;
            expect(chunkLines.slice(0, overlapLines).map(l => l.key)).toEqual(previous.slice(-overlapLines).map(l => l.key));
        }
        const fresh = chunks.flatMap(c => c.lines.slice(c.overlapLines)).map(l => l.key);
        expect(fresh).toEqual(lines.map(l => l.key));
    });
});

describe('normalizeItemRanges', () => {
    it('keeps «θέματα 1-8» as one range', () => {
        expect(normalizeItemRanges([{ kind: 'agenda_item', from: 1, to: 8 }])).toEqual([{ kind: 'agenda_item', from: 1, to: 8 }]);
    });

    it('folds «τα 10, 11, 12, 13, 14, 15, 16» into one range', () => {
        const singles = [10, 11, 12, 13, 14, 15, 16].map(n => ({ kind: 'agenda_item' as const, from: n, to: n }));
        expect(normalizeItemRanges(singles)).toEqual([{ kind: 'agenda_item', from: 10, to: 16 }]);
    });

    it('keeps kinds apart, drops a zero start, and repairs a reversed range', () => {
        expect(normalizeItemRanges([
            { kind: 'out_of_agenda', from: 1, to: 1 },
            { kind: 'agenda_item', from: 0, to: 3 },
            { kind: 'agenda_item', from: 5, to: 2 },
            { kind: 'agenda_item', from: 6, to: 6 },
        ])).toEqual([{ kind: 'agenda_item', from: 5, to: 6 }, { kind: 'out_of_agenda', from: 1, to: 1 }]);
    });
});

describe('mergeChunkFacts', () => {
    it('keeps the first roll-call entry per utterance and unions the passage', () => {
        const first = makeRaw();
        const second = makeRaw({
            rollCall: {
                found: true,
                rawText: 'later excerpt',
                utterances: ['u3', 'u4'],
                entries: [
                    { name: 'Δίμος', person: 'P4', status: 'PRESENT', absenceJustified: 'not_stated', rawText: 'Ο κύριος Δήμος απών.', utterance: 'u3' },
                    { name: 'Καραβίδας', person: 'P3', status: 'PRESENT', absenceJustified: 'not_stated', rawText: 'Καραβίδας παρών.', utterance: 'u4' },
                ],
            },
            votes: [],
        });
        const merged = mergeChunkFacts([first, second]);
        expect(merged.rollCall.rawText).toBe(first.rollCall.rawText);
        expect(merged.rollCall.utterances).toEqual(['u1', 'u2', 'u3', 'u4']);
        expect(merged.rollCall.entries.map(e => [e.utterance, e.name, e.status])).toEqual([
            ['u2', 'Γρίβας', 'PRESENT'],
            ['u3', 'Δήμος', 'ABSENT'],
            ['u4', 'Καραβίδας', 'PRESENT'],
        ]);
    });

    it('drops a vote stated twice for the same items and outcome across a boundary', () => {
        const first = makeRaw({ votes: [vote({ utterances: ['u7'] })] });
        const second = makeRaw({ rollCall: emptyRaw().rollCall, votes: [vote({ utterances: ['u7', 'u8'], rawText: 'restated' })] });
        const merged = mergeChunkFacts([first, second]);
        expect(merged.votes).toHaveLength(1);
        expect(merged.votes[0].rawText).toBe('Άρα το 2 εγκρίνεται κατά πλειοψηφία.');
    });

    it('keeps a vote restated two chunks later as a second vote', () => {
        const same = () => vote({ utterances: [] });
        const merged = mergeChunkFacts([makeRaw({ votes: [same()] }), makeRaw({ votes: [] }), makeRaw({ votes: [same()] })]);
        expect(merged.votes).toHaveLength(2);
    });

    it('keeps two votes on the same items with different outcomes, and two unplaced votes', () => {
        const a = vote({ items: [{ kind: 'agenda_item', from: 3, to: 3 }], outcome: 'unanimous', utterances: ['u10'] });
        const b = vote({ items: [{ kind: 'agenda_item', from: 3, to: 3 }], outcome: 'rejected', utterances: ['u11'] });
        const c = vote({ items: [], outcome: 'unanimous', utterances: ['u20'] });
        const d = vote({ items: [], outcome: 'unanimous', utterances: ['u30'] });
        expect(sameStatedVote(a, b)).toBe(false);
        expect(sameStatedVote(c, d)).toBe(false);
        expect(mergeChunkFacts([makeRaw({ votes: [a, c] }), makeRaw({ votes: [b, d] })]).votes).toHaveLength(4);
    });

    it('appends changes once each and keeps the first presiding statement', () => {
        const change = { name: 'Γρίβας', person: 'P2', type: 'departure' as const, anchor: { kind: 'agenda_item' as const, agendaItemIndex: 2, outOfAgenda: false, timing: 'during' as const }, rawText: 'Αποχωρεί ο κ. Γρίβας.', utterance: 'u9' };
        const merged = mergeChunkFacts([
            makeRaw({ attendanceChanges: [change], presidedBy: { name: 'Γρίβας', person: 'P2', rawText: 'προεδρεύει ο κ. Γρίβας' } }),
            makeRaw({ attendanceChanges: [change], presidedBy: { name: 'Δήμος', person: 'P4', rawText: 'προεδρεύει ο κ. Δήμος' } }),
        ]);
        expect(merged.attendanceChanges).toHaveLength(1);
        expect(merged.presidedBy.name).toBe('Γρίβας');
    });
});

describe('collectTranscriptNames and matchTranscriptNames', () => {
    it('lists each spoken name once with the key the model gave it', () => {
        expect(collectTranscriptNames(makeRaw())).toEqual([
            { name: 'Γρίβας', person: 'P2' },
            { name: 'Δήμος', person: '' },
            { name: 'Καραβίδα', person: 'P3' },
        ]);
    });

    it('takes the model key as a match and sends the rest to the two-step matcher', async () => {
        const llm: LlmNameMatcher = vi.fn(async (names) => ({ matched: [], stillUnmatched: names, usage: fullUsage(7) }));
        const raw = withUnknownName(makeRaw());
        const result = await matchTranscriptNames(raw, roster, llm);
        expect(result.matches.get('Γρίβας')).toEqual({ personId: 'p-grivas', method: 'llm' });
        expect(result.matches.get('Καραβίδα')).toEqual({ personId: 'p-karavidas', method: 'llm' });
        // A surname alone is what the token step resolves; only what it leaves goes to the model.
        expect(result.matches.get('Δήμος')).toEqual({ personId: 'p-dimos', method: 'token' });
        expect(result.matches.has('Στρακαντούνα')).toBe(false);
        expect(llm).toHaveBeenCalledWith(['Στρακαντούνα'], expect.any(Array));
        expect(result.usage.input_tokens).toBe(7);
    });

    it('does not call the matcher when every name carries a key', async () => {
        const llm: LlmNameMatcher = vi.fn();
        const raw = makeRaw();
        raw.rollCall.entries[1].person = 'P4';
        const result = await matchTranscriptNames(raw, roster, llm);
        expect(llm).not.toHaveBeenCalled();
        expect(result.matches.get('Δήμος')?.personId).toBe('p-dimos');
    });
});

describe('toTranscriptFactsReading', () => {
    const lines = buildTranscriptLines(transcript);

    it('maps the raw reading to the wire with ids matched', () => {
        const reading = toTranscriptFactsReading(makeRaw(), matching({}), lines, roster, agendaItems);

        expect(reading.rollCall).toEqual({
            rawText: 'Ξεκινάμε με την ανάγνωση των παρόντων. Ο κύριος Γρίβας παρών.',
            utteranceIds: ['utt-tag-a-0-0', 'utt-tag-a-0-1', 'utt-tag-a-0-2'],
            entries: [
                { name: 'Γρίβας', personId: 'p-grivas', status: 'PRESENT', absenceJustified: null, rawText: 'Ο κύριος Γρίβας παρών.', utteranceId: 'utt-tag-a-0-1', line: null },
                { name: 'Δήμος', personId: null, status: 'ABSENT', absenceJustified: null, rawText: 'Ο κύριος Δήμος απών.', utteranceId: 'utt-tag-a-0-2', line: null },
            ],
        });

        expect(reading.votes).toHaveLength(1);
        const [v] = reading.votes;
        expect(v.items).toEqual([{ kind: 'agenda_item', from: 2, to: 2 }]);
        expect(v.outcome).toBe('majority');
        expect(v.line).toBeNull();
        expect(v.utteranceIds).toEqual(['utt-tag-b-20-1', 'utt-tag-a-40-0', 'utt-tag-a-40-1']);
        expect(v.namedVotes).toEqual([{ name: 'Καραβίδα', personId: 'p-karavidas', vote: 'AGAINST', rawText: 'Κατά είπατε, κύριε Καραβίδα;', utteranceId: 'utt-tag-a-40-0' }]);
        expect(v.partyVotes).toEqual([{ party: null, speakerUtteranceId: 'utt-tag-b-20-1', vote: 'AGAINST', rawText: 'Εμείς κατά.' }]);

        expect(reading.presidedBy).toBeNull();
        expect(reading.nameMatches).toEqual([
            { name: 'Γρίβας', personId: 'p-grivas', method: 'llm' },
            { name: 'Δήμος', personId: null, method: null },
            { name: 'Καραβίδα', personId: 'p-karavidas', method: 'llm' },
        ]);
        expect(reading.unmatchedNames).toEqual(['Δήμος']);
        expect(reading.warnings).toEqual([]);
    });

    it('uses the matcher for a name without a key and reports its method', () => {
        const reading = toTranscriptFactsReading(makeRaw(), matching({ 'Δήμος': { personId: 'p-dimos', method: 'token' } }), lines, roster, agendaItems);
        expect(reading.rollCall?.entries[1].personId).toBe('p-dimos');
        expect(reading.nameMatches[1]).toEqual({ name: 'Δήμος', personId: 'p-dimos', method: 'token' });
        expect(reading.unmatchedNames).toEqual([]);
    });

    it('keeps a named party on a party vote', () => {
        const raw = makeRaw();
        raw.votes[0].partyVotes = [{ party: 'Λαϊκή Συσπείρωση', speakerUtterance: 'u5', vote: 'AGAINST', rawText: 'η Λαϊκή Συσπείρωση κατά' }];
        const reading = toTranscriptFactsReading(raw, matching({}), lines, roster, agendaItems);
        expect(reading.votes[0].partyVotes).toEqual([{ party: 'Λαϊκή Συσπείρωση', speakerUtteranceId: 'utt-tag-b-20-1', vote: 'AGAINST', rawText: 'η Λαϊκή Συσπείρωση κατά' }]);
    });

    it('maps a change with its anchor and the fixed document counts', () => {
        const raw = makeRaw({
            attendanceChanges: [
                { name: 'Γρίβας', person: 'P2', type: 'departure', anchor: { kind: 'agenda_item', agendaItemIndex: 2, outOfAgenda: false, timing: 'during' }, rawText: 'Αποχωρεί ο κ. Γρίβας.', utterance: 'u6' },
                { name: 'Καραβίδας', person: '', type: 'arrival', anchor: { kind: 'session_start', agendaItemIndex: 0, outOfAgenda: false, timing: 'none' }, rawText: 'Προσήλθε ο κ. Καραβίδας.', utterance: 'u4' },
            ],
        });
        const reading = toTranscriptFactsReading(raw, matching({}), lines, roster, agendaItems);
        expect(reading.attendanceChanges).toEqual([
            {
                personId: 'p-grivas', name: 'Γρίβας', type: 'departure',
                anchor: { kind: 'agenda_item', agendaItemIndex: 2, nonAgendaReason: null, decisionNumber: null, decisionNumberTo: null, subjectId: null, phase: null, timing: 'during' },
                rawText: 'Αποχωρεί ο κ. Γρίβας.', reportingPdfCount: 1, totalPdfCount: 1, utteranceId: 'utt-tag-a-40-0', line: null,
            },
            {
                personId: null, name: 'Καραβίδας', type: 'arrival',
                anchor: { kind: 'session_start', agendaItemIndex: null, nonAgendaReason: null, decisionNumber: null, decisionNumberTo: null, subjectId: null, phase: null, timing: null },
                rawText: 'Προσήλθε ο κ. Καραβίδας.', reportingPdfCount: 1, totalPdfCount: 1, utteranceId: 'utt-tag-b-20-0', line: null,
            },
        ]);
    });

    it('turns sentinels to nulls and «Ομόφωνα» on a rejection stays rejected', () => {
        const raw = makeRaw({
            rollCall: emptyRaw().rollCall,
            votes: [vote({ items: [], outcome: 'rejected', phrase: 'Ομόφωνα', utterances: ['u7'] }), vote({ outcome: 'not_stated', phrase: '', utterances: ['u6'] })],
            presidedBy: { name: 'Γρίβας', person: '', rawText: 'προεδρεύει ο κ. Γρίβας' },
        });
        const reading = toTranscriptFactsReading(raw, matching({ 'Γρίβας': { personId: 'p-grivas', method: 'llm' } }), lines, roster, agendaItems);
        expect(reading.rollCall).toBeNull();
        expect(reading.votes[0]).toMatchObject({ items: [], outcome: 'rejected', phrase: 'Ομόφωνα' });
        expect(reading.votes[1].outcome).toBeNull();
        expect(reading.presidedBy).toEqual({ name: 'Γρίβας', personId: 'p-grivas', rawText: 'προεδρεύει ο κ. Γρίβας' });
        expect(reading.warnings.map(w => w.code)).toEqual(['no_roll_call']);
    });

    it('warns about an unknown item and an unknown utterance key', () => {
        const raw = makeRaw({
            attendanceChanges: [
                { name: 'Γρίβας', person: 'P2', type: 'arrival', anchor: { kind: 'agenda_item', agendaItemIndex: 9, outOfAgenda: false, timing: 'before' }, rawText: 'Προσήλθε.', utterance: 'u99' },
            ],
            votes: [vote({ items: [{ kind: 'out_of_agenda', from: 2, to: 2 }] })],
        });
        const reading = toTranscriptFactsReading(raw, matching({}), lines, roster, agendaItems);
        expect(reading.attendanceChanges[0].utteranceId).toBeNull();
        expect(reading.warnings.map(w => w.code)).toEqual(['unknown_agenda_item', 'unknown_agenda_item', 'unknown_utterance']);
        expect(reading.warnings[0].message).toContain('item 9');
        expect(reading.warnings[1].message).toContain('out-of-agenda item 2');
    });
});

describe('readTranscriptFacts', () => {
    beforeEach(() => mockAiChat.mockReset());

    it('reads every chunk, merges, matches and maps', async () => {
        mockAiChat.mockResolvedValue({ result: withUnknownName(makeRaw()), usage: fullUsage(100) });
        const llm: LlmNameMatcher = vi.fn(async (names) => ({ matched: [], stillUnmatched: names, usage: fullUsage(3) }));
        const progress = vi.fn();

        const { result, usage } = await readTranscriptFacts({ ...request(), roster }, progress, { llmMatch: llm });

        expect(mockAiChat).toHaveBeenCalledTimes(1);
        const call = mockAiChat.mock.calls[0][0];
        expect(call.label).toBe('transcript-facts:1/1');
        expect(call.outputFormat.type).toBe('json_schema');
        expect(call.userPrompt).toContain('[u2 00:00:05 S1 Κρανιώτης]: Ο κύριος Γρίβας παρών.');
        expect(call.userPrompt).toContain('- Item 2: Ονοματοδοσία οδού');
        expect(result.rollCall?.entries.map(e => e.personId)).toEqual(['p-grivas', 'p-dimos', null]);
        expect(result.unmatchedNames).toEqual(['Στρακαντούνα']);
        expect(llm).toHaveBeenCalledWith(['Στρακαντούνα'], expect.any(Array));
        expect(usage.input_tokens).toBe(103);
        expect(progress).toHaveBeenLastCalledWith('done', 100);
    });

    it('splits a long transcript into chunks and de-duplicates across them', async () => {
        mockAiChat.mockResolvedValue({ result: makeRaw(), usage: fullUsage(1) });
        const llm: LlmNameMatcher = vi.fn(async (names) => ({ matched: [], stillUnmatched: names, usage: fullUsage() }));
        const long = [...transcript, ...Array.from({ length: 12 }, (_, i) => segment('tag-a', 'Κρανιώτης', 100 + i * 10, ['Το θέμα αυτό αφορά την ονοματοδοσία της οδού και τη σχετική εισήγηση της υπηρεσίας. '.repeat(3)]))];

        const { result } = await readTranscriptFacts({ ...request({ transcript: long }), roster }, () => undefined, { llmMatch: llm, chunkChars: 1_100 });

        expect(mockAiChat.mock.calls.length).toBeGreaterThan(1);
        expect(mockAiChat.mock.calls[1][0].userPrompt).toContain('repeat the end of chunk 1');
        expect(result.rollCall?.entries).toHaveLength(2);
        expect(result.votes).toHaveLength(1);
    });
});

describe('readMeetingFacts', () => {
    beforeEach(() => mockAiChat.mockReset());

    it('does not run without a roster', async () => {
        expect((await readMeetingFacts(request({ roster: undefined }))).result).toBeUndefined();
        expect((await readMeetingFacts(request({ roster: [] }))).result).toBeUndefined();
        expect(mockAiChat).not.toHaveBeenCalled();
    });

    it('swallows a failure but lets a cancellation through', async () => {
        mockAiChat.mockRejectedValueOnce(new Error('model unavailable'));
        expect((await readMeetingFacts(request())).result).toBeUndefined();

        mockAiChat.mockRejectedValueOnce(new TaskCancelledError());
        await expect(readMeetingFacts(request())).rejects.toBeInstanceOf(TaskCancelledError);
    });
});

describe('mergeChunkFacts, two names in one breath and one item voted twice', () => {
    it('keeps two roll-call entries that cite the same utterance', () => {
        const chunk = makeRaw({
            rollCall: {
                found: true, rawText: 'x', utterances: ['u5'],
                entries: [
                    { name: 'Δήμος', person: 'P4', status: 'PRESENT', absenceJustified: 'not_stated', rawText: 'Δήμος, Καραβίδας παρόντες.', utterance: 'u5' },
                    { name: 'Καραβίδας', person: 'P3', status: 'PRESENT', absenceJustified: 'not_stated', rawText: 'Δήμος, Καραβίδας παρόντες.', utterance: 'u5' },
                ],
            },
        });
        expect(mergeChunkFacts([chunk]).rollCall.entries.map(e => e.name)).toEqual(['Δήμος', 'Καραβίδας']);
    });

    it('keeps a vote on the same items with the same outcome when the two reports cite different utterances', () => {
        const first = vote({ items: [{ kind: 'agenda_item', from: 4, to: 4 }], outcome: 'unanimous', utterances: ['u12'] });
        const again = vote({ items: [{ kind: 'agenda_item', from: 4, to: 4 }], outcome: 'unanimous', utterances: ['u40'] });
        expect(sameStatedVote(first, again)).toBe(false);
        expect(mergeChunkFacts([makeRaw({ votes: [first] }), makeRaw({ votes: [again] })]).votes).toHaveLength(2);
        // With the overlap known: u40 is new text of the second chunk, so it is a second vote.
        expect(mergeChunkFacts([makeRaw({ votes: [first] }), makeRaw({ votes: [again] })], [[], ['u12', 'u13']]).votes).toHaveLength(2);
    });

    it('takes two reports that cite different utterances of the overlap as one vote: the call and the answer of one passage', () => {
        const call = vote({ items: [{ kind: 'agenda_item', from: 4, to: 4 }], outcome: 'unanimous', utterances: ['u12'] });
        const answer = vote({ items: [{ kind: 'agenda_item', from: 4, to: 4 }], outcome: 'unanimous', utterances: ['u13'] });
        expect(sameStatedVote(call, answer, new Set(['u12', 'u13']))).toBe(true);
        expect(mergeChunkFacts([makeRaw({ votes: [call] }), makeRaw({ votes: [answer] })], [[], ['u12', 'u13']]).votes).toHaveLength(1);
    });
});
