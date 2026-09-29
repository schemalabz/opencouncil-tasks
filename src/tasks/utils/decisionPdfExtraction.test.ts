import crypto from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAiChat, NO_USAGE_MOCK, mockGetPageCount, cacheFiles } = vi.hoisted(() => ({
    mockAiChat: vi.fn(),
    cacheFiles: new Map<string, string>(),
    NO_USAGE_MOCK: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    mockGetPageCount: vi.fn().mockReturnValue(3), // Default: small PDF (≤10 pages)
}));
vi.mock("../../lib/ai.js", () => ({
    aiChat: mockAiChat,
    addUsage: (a: any, b: any) => ({
        input_tokens: a.input_tokens + b.input_tokens,
        output_tokens: a.output_tokens + b.output_tokens,
        cache_creation_input_tokens: (a.cache_creation_input_tokens || 0) + (b.cache_creation_input_tokens || 0),
        cache_read_input_tokens: (a.cache_read_input_tokens || 0) + (b.cache_read_input_tokens || 0),
    }),
    NO_USAGE: NO_USAGE_MOCK,
    HAIKU_MODEL: 'claude-haiku-4-5-20251001',
}));

// Mock pdf-lib to avoid needing real PDF bytes in tests
vi.mock("pdf-lib", () => {
    const mockSrcDoc = {
        getPageCount: mockGetPageCount,
    };
    return {
        PDFDocument: {
            load: vi.fn().mockResolvedValue(mockSrcDoc),
            create: vi.fn().mockResolvedValue({
                copyPages: vi.fn().mockResolvedValue([]),
                addPage: vi.fn(),
                save: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
            }),
        },
    };
});

// Keep the extraction cache in memory, so no test reads or writes the on-disk one
vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    const isCache = (p: unknown) => typeof p === 'string' && p.includes('opencouncil-decisions-cache');
    return {
        ...actual,
        default: {
            ...actual,
            readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
                if (isCache(args[0])) {
                    const data = cacheFiles.get(args[0] as string);
                    if (data === undefined) throw new Error('cache miss (mocked)');
                    return data;
                }
                return actual.readFileSync(...args);
            },
            writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
                if (isCache(args[0])) {
                    cacheFiles.set(args[0] as string, String(args[1]));
                    return;
                }
                return actual.writeFileSync(...args);
            },
            mkdirSync: (...args: Parameters<typeof actual.mkdirSync>) => {
                if (isCache(args[0])) return undefined;
                return actual.mkdirSync(...args);
            },
        },
    };
});

import {
    extractDecisionFromPdf,
    normalizeGreekName,
    tokenSortKey,
    tokenSortKeys,
    matchMembersToPersonIds,
    matchPersonByName,
    llmMatchMembers,
    sameGreekPerson,
    greekNameInList,
    withDefaults,
    extractionCacheKey,
    EXTRACTION_SCHEMA_VERSION, adoptLaterVoteNames, withClosingFacts, withContinuationFacts, normalizeExtraction } from './decisionPdfExtraction.js';
import { PDFDocument } from 'pdf-lib';
import type { RawExtractedDecision, AttendanceAnchor } from './decisionPdfExtraction.js';
import type { AttendanceAnchorKind, AttendancePhase } from '../../types.js';

const noUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

/** «Τα Μέλη» of Argos 359/2025 (62ΟΒΩΨΔ-Ε7Π) as read: names 1-13 on page 5, names 14-20 on page 6. */
const ARGOS_LIST = ['Α. Αργυροπούλου', 'Χ. Φλεβάρης', 'Κ. Αδρακτάς', 'Χ. Σελλής', 'Κ. Αναγνωστόπουλος', 'Γ. Αλεξανδρόπουλος', 'Α. Λιόλιος',
    'Φ. Κολεβέντης', 'Φ. Ξηνταροπούλου', 'Χ. Πούλος', 'Γ. Δημάκης', 'Α. Αθανασόπουλος', 'Δ. Γάτσιου',
    'Β. Καραβίδας', 'Χ. Πετσέλης', 'Π. Σκούφης', 'Ν. Δελής', 'Ι. Αθανασόπουλος', 'Γ. Γρίβας', 'Π. Δούρος'];
const ARGOS_DISSENTERS: RawExtractedDecision['voteDetails'] = [
    { name: 'Χ. Πετσέλης', vote: 'AGAINST' }, { name: 'Π. Σκούφης', vote: 'AGAINST' }, { name: 'Ν. Δελής', vote: 'AGAINST' },
    { name: 'Ι. Αθανασόπουλος', vote: 'AGAINST' }, { name: 'Γ. Γρίβας', vote: 'PRESENT' },
];

// --- normalizeGreekName tests ---

describe('normalizeGreekName', () => {
    it('strips Greek diacritics (tonos)', () => {
        expect(normalizeGreekName('Κρανιώτης Χαράλαμπος')).toBe('κρανιωτης χαραλαμπος');
    });

    it('handles ALL CAPS without accents', () => {
        expect(normalizeGreekName('ΚΡΑΝΙΩΤΗΣ ΧΑΡΑΛΑΜΠΟΣ')).toBe('κρανιωτης χαραλαμπος');
    });

    it('strips parenthetical nicknames', () => {
        expect(normalizeGreekName('ΚΡΑΝΙΩΤΗΣ ΧΑΡΑΛΑΜΠΟΣ (ΜΠΑΜΠΗΣ)')).toBe('κρανιωτης χαραλαμπος');
    });

    it('handles names with multiple diacritics', () => {
        expect(normalizeGreekName('Αλεξάνδρη-Ζουμπουλάκη Ευσταθία')).toBe('αλεξανδρη-ζουμπουλακη ευσταθια');
    });

    it('normalizes whitespace', () => {
        expect(normalizeGreekName('  ΓΡΙΒΑΣ   ΓΕΩΡΓΙΟΣ  ')).toBe('γριβας γεωργιος');
    });

    it('handles dialytika (ϊ/ΐ)', () => {
        expect(normalizeGreekName('ΠΑΠΑΪΩΑΝΝΟΥ')).toBe('παπαιωαννου');
        expect(normalizeGreekName('Παπαΐωάννου')).toBe('παπαιωαννου');
    });
});

// --- tokenSortKey / tokenSortKeys tests ---

describe('sameGreekPerson', () => {
    it('matches surname plus initial against the spelled-out name', () => {
        expect(sameGreekPerson('Αθανασάκης Σ.', 'Σπύρος (Σάκης) Αθανασάκης')).toBe(true);
        expect(sameGreekPerson('Καρύδας Δ.-Ε.', 'ΚΑΡΥΔΑΣ ΔΗΜΗΤΡΙΟΣ-ΕΥΑΓΓΕΛΟΣ')).toBe(true);
        expect(sameGreekPerson('Χαμντί Ντ.', 'Χαμντί Ντάφερ')).toBe(true);
    });
    it('does not match a different surname or a wrong initial', () => {
        expect(sameGreekPerson('Αθανασάκης Γ.', 'Σπύρος Αθανασάκης')).toBe(false);
        expect(sameGreekPerson('Βέρα Λ.', 'Λυδία Πάλλα')).toBe(false);
        expect(sameGreekPerson('Σ.', 'Σπύρος Αθανασάκης')).toBe(false);
    });
    it('subtracts abbreviated absentees from a composition', () => {
        const composition = ['Σπύρος (Σάκης) Αθανασάκης', 'Λυδία Βέρα', 'Παναγιώτης Κουφάκης'];
        const absent = ['Αθανασάκης Σ.', 'Βέρα Λ.'];
        expect(composition.filter(n => !greekNameInList(n, absent))).toEqual(['Παναγιώτης Κουφάκης']);
    });
});

describe('tokenSortKey', () => {
    it('sorts tokens alphabetically for order-insensitive matching', () => {
        // DB: FirstName LastName → same sorted key as PDF: LastName FirstName
        expect(tokenSortKey('Ευθύμιος Μπαρμπέρης')).toBe(tokenSortKey('ΜΠΑΡΜΠΕΡΗΣ ΕΥΘΥΜΙΟΣ'));
    });

    it('treats hyphens as word separators', () => {
        expect(tokenSortKey('Χριστοφορίδου-Τσιλιγκίρη Θέκλα'))
            .toBe(tokenSortKey('ΧΡΙΣΤΟΦΟΡΙΔΟΥ - ΤΣΙΛΙΓΚΙΡΗ ΘΕΚΛΑ'));
    });

    it('strips nicknames before tokenizing', () => {
        expect(tokenSortKey('ΜΠΑΡΜΠΕΡΗΣ ΕΥΘΥΜΙΟΣ (ΜΑΚΗΣ)'))
            .toBe(tokenSortKey('Ευθύμιος Μπαρμπέρης'));
    });

    it('strips diacritics', () => {
        expect(tokenSortKey('Κρανιώτης Χαράλαμπος'))
            .toBe(tokenSortKey('ΚΡΑΝΙΩΤΗΣ ΧΑΡΑΛΑΜΠΟΣ'));
    });
});

describe('tokenSortKeys', () => {
    it('returns single key for names without nicknames', () => {
        expect(tokenSortKeys('Ευθύμιος Μπαρμπέρης')).toHaveLength(1);
    });

    it('returns two keys when nickname differs from formal name', () => {
        const keys = tokenSortKeys('ΠΑΠΑΝΑΣΤΑΣΟΠΟΥΛΟΣ ΚΩΝΣΤΑΝΤΙΝΟΣ (ΚΩΣΤΗΣ)');
        expect(keys).toHaveLength(2);
        // Key 1: formal name (nickname stripped)
        expect(keys[0]).toBe(tokenSortKey('ΠΑΠΑΝΑΣΤΑΣΟΠΟΥΛΟΣ ΚΩΝΣΤΑΝΤΙΝΟΣ'));
        // Key 2: nickname replaces formal first name
        expect(keys[1]).toBe(tokenSortKey('ΠΑΠΑΝΑΣΤΑΣΟΠΟΥΛΟΣ ΚΩΣΤΗΣ'));
    });

    it('nickname key matches DB name stored as informal', () => {
        const pdfKeys = tokenSortKeys('ΠΑΠΑΝΑΣΤΑΣΟΠΟΥΛΟΣ ΚΩΝΣΤΑΝΤΙΝΟΣ (ΚΩΣΤΗΣ)');
        const dbKey = tokenSortKey('Κωστής Παπαναστασόπουλος');
        expect(pdfKeys).toContain(dbKey);
    });
});

// --- matchMembersToPersonIds tests (step 1: token-sort) ---

describe('matchMembersToPersonIds', () => {
    const people = [
        { id: 'p1', name: 'Ευθύμιος Μπαρμπέρης' },
        { id: 'p2', name: 'Ευανθία Καμινάρη' },
        { id: 'p3', name: 'Παπαϊωάννου Αριάδνη' },
    ];

    it('matches names with reversed order (PDF: LastName FirstName, DB: FirstName LastName)', () => {
        const result = matchMembersToPersonIds(
            ['ΜΠΑΡΜΠΕΡΗΣ ΕΥΘΥΜΙΟΣ', 'ΚΑΜΙΝΑΡΗ ΕΥΑΝΘΙΑ'],
            people,
        );
        expect(result.matchedIds).toEqual(['p1', 'p2']);
        expect(result.unmatched).toEqual([]);
    });

    it('matches names with nicknames stripped', () => {
        const result = matchMembersToPersonIds(
            ['ΜΠΑΡΜΠΕΡΗΣ ΕΥΘΥΜΙΟΣ (ΜΑΚΗΣ)'],
            people,
        );
        expect(result.matchedIds).toEqual(['p1']);
        expect(result.unmatched).toEqual([]);
    });

    it('matches names with dialytika differences', () => {
        const result = matchMembersToPersonIds(
            ['ΠΑΠΑΪΩΑΝΝΟΥ ΑΡΙΑΔΝΗ'],
            people,
        );
        expect(result.matchedIds).toEqual(['p3']);
        expect(result.unmatched).toEqual([]);
    });

    it('reports unmatched names', () => {
        const result = matchMembersToPersonIds(
            ['ΜΠΑΡΜΠΕΡΗΣ ΕΥΘΥΜΙΟΣ', 'ΑΓΝΩΣΤΟΣ ΑΝΘΡΩΠΟΣ'],
            people,
        );
        expect(result.matchedIds).toEqual(['p1']);
        expect(result.unmatched).toEqual(['ΑΓΝΩΣΤΟΣ ΑΝΘΡΩΠΟΣ']);
    });

    it('returns empty arrays for empty input', () => {
        const result = matchMembersToPersonIds([], people);
        expect(result.matchedIds).toEqual([]);
        expect(result.unmatched).toEqual([]);
    });
});

// --- matchPersonByName tests ---

describe('matchMembersToPersonIds abbreviated fallback', () => {
    const people = [
        { id: 'gazi', name: 'Ευαγγελία Γαζή' },
        { id: 'ath', name: 'Σπύρος Αθανασάκης' },
        { id: 'pap1', name: 'Γεώργιος Παπαδόπουλος' },
        { id: 'pap2', name: 'Γιάννης Παπαδόπουλος' },
    ];
    it('matches a middle name and a surname-plus-initial when unique', () => {
        const r = matchMembersToPersonIds(['Ευαγγελία Λίλιαν Γαζή', 'Αθανασάκης Σ.'], people);
        expect(r.matchedIds).toEqual(['gazi', 'ath']);
        expect(r.unmatched).toEqual([]);
    });
    it('leaves an ambiguous initial unmatched', () => {
        const r = matchMembersToPersonIds(['Παπαδόπουλος Γ.'], people);
        expect(r.matchedIds).toEqual([]);
        expect(r.unmatched).toEqual(['Παπαδόπουλος Γ.']);
    });
});

describe('matchPersonByName', () => {
    const people = [
        { id: 'p1', name: 'Ευσταθία Βαμβάκα' },
        { id: 'p2', name: 'Κωστής Παπαναστασόπουλος' },
    ];

    it('returns personId for matching name (reversed order + nickname)', () => {
        expect(matchPersonByName('ΒΑΜΒΑΚΑ ΕΥΣΤΑΘΙΑ (ΕΦΗ)', people)).toBe('p1');
    });

    it('matches when DB stores informal name and PDF has formal + nickname', () => {
        expect(matchPersonByName('ΠΑΠΑΝΑΣΤΑΣΟΠΟΥΛΟΣ ΚΩΝΣΤΑΝΤΙΝΟΣ (ΚΩΣΤΗΣ)', people)).toBe('p2');
    });

    it('returns null for non-matching name', () => {
        expect(matchPersonByName('ΑΓΝΩΣΤΟΣ', people)).toBeNull();
    });
});

// --- llmMatchMembers tests ---

describe('matchPersonByName abbreviated fallback', () => {
    it('resolves a middle name the roster does not carry', () => {
        expect(matchPersonByName('Ευαγγελία Λιλιάν Γαζή', [{ id: 'gazi', name: 'Ευαγγελία Γαζή' }, { id: 'x', name: 'Λυδία Βέρα' }])).toBe('gazi');
    });
});

describe('llmMatchMembers', () => {
    beforeEach(() => {
        mockAiChat.mockReset();
    });

    it('returns LLM-matched names with personIds and usage', async () => {
        mockAiChat.mockResolvedValueOnce({
            result: {
                matches: [
                    { name: 'ΣΤΡΑΚΑΝΤΟΥΝΑ ΣΦΑΚΑΚΗ ΒΑΣΙΛΙΚΗ', personId: 'p1' },
                    { name: 'ΑΓΝΩΣΤΟΣ', personId: null },
                ],
            },
            usage: { input_tokens: 50, output_tokens: 25 },
        });

        const result = await llmMatchMembers(
            ['ΣΤΡΑΚΑΝΤΟΥΝΑ ΣΦΑΚΑΚΗ ΒΑΣΙΛΙΚΗ', 'ΑΓΝΩΣΤΟΣ'],
            [{ id: 'p1', name: 'Βασιλική Στρακαντούνα-Σφακάκη' }],
        );

        expect(result.matched).toEqual([{ name: 'ΣΤΡΑΚΑΝΤΟΥΝΑ ΣΦΑΚΑΚΗ ΒΑΣΙΛΙΚΗ', personId: 'p1' }]);
        expect(result.stillUnmatched).toEqual(['ΑΓΝΩΣΤΟΣ']);
        expect(result.usage).toEqual({ input_tokens: 50, output_tokens: 25 });
    });

    it('returns all names as unmatched when people list is empty', async () => {
        const result = await llmMatchMembers(['NAME1', 'NAME2'], []);
        expect(result.matched).toEqual([]);
        expect(result.stillUnmatched).toEqual(['NAME1', 'NAME2']);
        expect(result.usage).toEqual(noUsage);
        expect(mockAiChat).not.toHaveBeenCalled();
    });

    it('skips LLM when no unmatched names', async () => {
        const result = await llmMatchMembers([], [{ id: 'p1', name: 'Test' }]);
        expect(result.matched).toEqual([]);
        expect(result.stillUnmatched).toEqual([]);
        expect(mockAiChat).not.toHaveBeenCalled();
    });

    // The caller collects unmatched names across every document of one meeting,
    // so both spellings of one member arrive in a single call. Keeping only the
    // first spelling would leave the second identified by its raw text, and the
    // member would be split across two attendance groups.
    it('gives both spellings of one member the same personId', async () => {
        mockAiChat.mockResolvedValueOnce({
            result: {
                matches: [
                    { name: 'ΠΑΠΑΔΟΠΟΥΛΟΣ Κ.', personId: 'p1' },
                    { name: 'Κωστής Παπαδόπουλος', personId: 'p1' },
                ],
            },
            usage: noUsage,
        });

        const result = await llmMatchMembers(
            ['ΠΑΠΑΔΟΠΟΥΛΟΣ Κ.', 'Κωστής Παπαδόπουλος'],
            [{ id: 'p1', name: 'Κωνσταντίνος Παπαδόπουλος' }],
        );

        expect(result.matched).toEqual([
            { name: 'ΠΑΠΑΔΟΠΟΥΛΟΣ Κ.', personId: 'p1' },
            { name: 'Κωστής Παπαδόπουλος', personId: 'p1' },
        ]);
        expect(result.stillUnmatched).toEqual([]);
    });

    it('requests structured output instead of a prefill (rejected on Claude 4.6+)', async () => {
        mockAiChat.mockResolvedValueOnce({
            result: { matches: [{ name: 'TEST', personId: 'p1' }] },
            usage: noUsage,
        });

        await llmMatchMembers(['TEST'], [{ id: 'p1', name: 'Test Person' }]);

        const callArgs = mockAiChat.mock.calls[0][0];
        expect(callArgs.outputFormat).toBeDefined();
        expect(callArgs.prefillSystemResponse).toBeUndefined();
    });
});

describe('llmMatchMembers', () => {
    it('rejects an id the model invented instead of copying', async () => {
        mockAiChat.mockResolvedValueOnce({
            result: { matches: [
                { name: 'Ευαγγελία Λίλιαν Γαζή', personId: 'p1' },
                { name: 'Σ. Αθανασάκης', personId: 'p1-spliced-p2' },
            ] },
            usage: { input_tokens: 1, output_tokens: 1 },
        });
        const { matched, stillUnmatched } = await llmMatchMembers(
            ['Ευαγγελία Λίλιαν Γαζή', 'Σ. Αθανασάκης'],
            [{ id: 'p1', name: 'Ευαγγελία Γαζή' }, { id: 'p2', name: 'Σπύρος Αθανασάκης' }],
        );
        expect(matched).toEqual([{ name: 'Ευαγγελία Λίλιαν Γαζή', personId: 'p1' }]);
        expect(stillUnmatched).toEqual(['Σ. Αθανασάκης']);
    });
});

// --- cached-reading migration ---

describe('normalizeExtraction', () => {
    const llm = (over: Partial<Parameters<typeof normalizeExtraction>[0]>) => normalizeExtraction({
        attendanceFormat: 'explicit_present_absent', compositionMembers: [], presentMembers: [], absentMembers: [], mayorPresent: false,
        decisionExcerpt: '', decisionNumber: '', references: '', voteResult: '', voteDetails: [], attendanceChanges: [], discussionOrder: null,
        subjectInfo: { agendaItemIndex: 1, nonAgendaReason: null }, incomplete: false, presidedBy: { name: '', rawText: '' },
        actingSecretary: { name: '', rawText: '' }, subjectHeading: '', decisionAttendance: { present: [], rawText: '' },
        voteTally: { FOR: -1, AGAINST: -1, ABSTAIN: -1, PRESENT: -1, DID_NOT_VOTE: -1 }, ...over,
    } as Parameters<typeof normalizeExtraction>[0]);
    it('keeps the heading beside the number without gating the number on it', () => {
        // The reader takes the number from places it does not call a heading; an empty heading is not evidence of no number.
        expect(llm({ subjectHeading: '' }).subjectInfo).toEqual({ agendaItemIndex: 1, nonAgendaReason: null });
        expect(llm({ subjectHeading: 'ΘΕΜΑ 3ο', subjectInfo: { agendaItemIndex: 3, nonAgendaReason: null } })).toMatchObject({ subjectHeading: 'ΘΕΜΑ 3ο', subjectInfo: { agendaItemIndex: 3 } });
    });
    it('keeps the acting secretary only when the page names one', () => {
        expect(llm({}).actingSecretary).toBeNull();
        expect(llm({ actingSecretary: { name: 'Αικατερίνη Γκούμα', rawText: 'Η εκτελούσα χρέη Γραμματέα Αικατερίνη Γκούμα' } }).actingSecretary?.name).toBe('Αικατερίνη Γκούμα');
    });
});

describe('extractionCacheKey', () => {
    it('versions the key, so a reading written by an older prompt is never found', () => {
        expect(extractionCacheKey('https://example.com/a.pdf')).toBe(`https://example.com/a.pdf#v${EXTRACTION_SCHEMA_VERSION}`);
        expect(extractionCacheKey('https://example.com/a.pdf')).not.toBe('https://example.com/a.pdf');
    });

    it('keeps a hinted reading apart from a plain one, both under the version', () => {
        const plain = extractionCacheKey('https://example.com/a.pdf');
        const hinted = extractionCacheKey('https://example.com/a.pdf', { hints: 'the body prints ΣΥΝΘΕΣΗ' });
        expect(hinted).not.toBe(plain);
        expect(hinted.startsWith(`${plain}#`)).toBe(true);
    });

    // pollDecisions names the mayor and the scorer does not. Sharing a key meant
    // whichever ran first owned the entry both read, and the name steers
    // mayorPresent and presidedBy.
    it('keeps a reading steered by a mayor name apart from every other', () => {
        const url = 'https://example.com/a.pdf';
        const plain = extractionCacheKey(url);
        const withMayor = extractionCacheKey(url, { mayorName: 'Μαρία Μ' });
        const otherMayor = extractionCacheKey(url, { mayorName: 'Γιώργος Γ' });
        const mayorAndHints = extractionCacheKey(url, { mayorName: 'Μαρία Μ', hints: 'ΣΥΝΘΕΣΗ' });

        expect(new Set([plain, withMayor, otherMayor, mayorAndHints]).size).toBe(4);
    });
});

describe('withDefaults', () => {
    const WIRE_KINDS: AttendanceAnchorKind[] = ['agenda_item', 'decision_number', 'subject', 'phase', 'session_start', 'session_end'];
    const WIRE_PHASES: (AttendancePhase | null)[] = ['pre_agenda', 'out_of_agenda', null];

    const cachedWithAnchor = (anchor: Record<string, unknown>) => ({
        attendanceChanges: [{ name: 'Α Β', type: 'departure', agendaItem: null, timing: null, anchor, rawText: 'x' }],
    }) as unknown as RawExtractedDecision;

    const migratedAnchor = (anchor: Record<string, unknown>): AttendanceAnchor =>
        withDefaults(cachedWithAnchor(anchor)).attendanceChanges[0].anchor!;

    const retired = (over: Record<string, unknown>) => ({ agendaItem: null, decisionNumber: null, timing: null, ...over });

    it('turns the retired session_phase anchor into a phase the wire declares', () => {
        expect(migratedAnchor(retired({ kind: 'session_phase', phase: 'μετά την ψήφιση του κατεπείγοντος' })))
            .toMatchObject({ kind: 'phase', phase: 'pre_agenda' });
        expect(migratedAnchor(retired({ kind: 'session_phase', phase: 'εκτός ημερησίας διατάξεως' })))
            .toMatchObject({ kind: 'phase', phase: 'out_of_agenda' });
        expect(migratedAnchor(retired({ kind: 'session_phase', phase: 'συζήτηση Ε.Η.Δ. θέματος' })))
            .toMatchObject({ kind: 'phase', phase: 'out_of_agenda' });
    });

    it('turns the retired clock_time anchor into the start of the session', () => {
        expect(migratedAnchor(retired({ kind: 'clock_time', phase: null })))
            .toMatchObject({ kind: 'session_start', phase: null });
    });

    it('drops a free-text phase riding a kind that is not phase', () => {
        expect(migratedAnchor(retired({ kind: 'this_document', phase: 'πριν την ψηφοφορία' })))
            .toMatchObject({ kind: 'this_document', phase: null });
    });

    it('leaves an anchor already in the v4 vocabulary alone', () => {
        const anchor = retired({ kind: 'phase', phase: 'out_of_agenda' });
        expect(migratedAnchor(anchor)).toMatchObject({ kind: 'phase', phase: 'out_of_agenda' });
        expect(migratedAnchor(retired({ kind: 'agenda_item', agendaItem: { agendaItemIndex: 3, nonAgendaReason: null }, timing: 'during' })))
            .toMatchObject({ kind: 'agenda_item', phase: null });
    });

    it('never emits a kind or a phase outside what the wire declares', () => {
        for (const kind of ['session_phase', 'clock_time', 'this_document', 'agenda_item']) {
            for (const phase of ['μετά την ψήφιση', 'εκτός ημερησίας', 'pre_agenda', null]) {
                const a = migratedAnchor(retired({ kind, phase }));
                // `this_document` is the extractor's own name for the wire's `subject`.
                expect([...WIRE_KINDS, 'this_document']).toContain(a.kind);
                expect(WIRE_PHASES).toContain(a.phase);
            }
        }
    });

    it('still fills the fields a reading written before they existed has no answer for', () => {
        const bare = { attendanceChanges: [] } as unknown as RawExtractedDecision;
        expect(withDefaults(bare)).toMatchObject({
            attendanceFormat: 'explicit_present_absent',
            compositionMembers: null,
            presidedBy: null, actingSecretary: null, subjectHeading: '',
            voteTally: { FOR: null, AGAINST: null, ABSTAIN: null, PRESENT: null, DID_NOT_VOTE: null },
            decisionAttendance: null,
        });
    });
});

// --- extractDecisionFromPdf tests ---

describe('extractDecisionFromPdf', () => {
    beforeEach(() => {
        mockAiChat.mockReset();
        cacheFiles.clear();
    });

    it('returns extracted data from AI response', async () => {
        const mockResult = {
            presentMembers: ['Μέλος 1', 'Μέλος 2'],
            absentMembers: ['Μέλος 3'],
            decisionExcerpt: 'Αποφασίζεται ομόφωνα...',
            decisionNumber: '42/2025',
            references: '1. Ν.3852/2010\n2. Ν.4555/2018',
            voteResult: 'Ομόφωνα',
            voteDetails: [],
            incomplete: false,
        };

        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
            ok: true,
            arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
        } as Response);

        mockAiChat.mockResolvedValueOnce({
            result: mockResult,
            usage: { input_tokens: 100, output_tokens: 50 },
        });

        const { result, usage } = await extractDecisionFromPdf('https://example.com/test-unique-extraction-url.pdf');

        expect(result).toMatchObject({ ...mockResult, attendanceChanges: [], presidedBy: null, actingSecretary: null, subjectHeading: '' });
        expect(usage).toEqual({ input_tokens: 100, output_tokens: 50 });
        expect(mockAiChat).toHaveBeenCalledOnce();
        expect(fetchSpy).toHaveBeenCalledWith('https://example.com/test-unique-extraction-url.pdf');

        fetchSpy.mockRestore();
    });

    it('turns the model\'s anchor into the change and its agenda-item projection', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)) } as Response);
        mockAiChat.mockResolvedValueOnce({
            result: {
                attendanceFormat: 'explicit_present_absent', compositionMembers: null, presentMembers: ['Λυδία Βέρα'], absentMembers: [],
                mayorPresent: null, decisionExcerpt: 'x', decisionNumber: '304', references: '', voteResult: 'Ομόφωνα', voteDetails: [],
                attendanceChanges: [
                    { name: 'Λυδία Βέρα', type: 'departure', rawText: 'απεχώρησαν στην 286 ΑΚΣ',
                      anchor: { kind: 'decision_number', agendaItemIndex: 0, outOfAgenda: false, decisionNumber: '286', phase: 'none', timing: 'during' } },
                    { name: 'Π. Ζορμπά', type: 'departure', rawText: 'Πριν τη συζήτηση του 5ου θέματος',
                      anchor: { kind: 'agenda_item', agendaItemIndex: 5, outOfAgenda: false, decisionNumber: '', phase: 'none', timing: 'before' } },
                    { name: 'Γ. Βελεγράκης', type: 'absent_for_vote', rawText: 'Εκτός αιθούσης στις με αρ. 31 – 40 ΑΔΣ',
                      anchor: { kind: 'decision_number', agendaItemIndex: 0, outOfAgenda: false, decisionNumber: '31', decisionNumberTo: '40', phase: 'none', timing: 'during' } },
                ],
                discussionOrder: null, subjectInfo: null, incomplete: false,
            },
            usage: { input_tokens: 1, output_tokens: 1 },
        });
        const { result } = await extractDecisionFromPdf('https://example.com/anchors.pdf');
        expect(result.attendanceChanges[0]).toMatchObject({ agendaItem: null, timing: null, anchor: { kind: 'decision_number', decisionNumber: '286', timing: 'during' } });
        expect(result.attendanceChanges[1]).toMatchObject({ agendaItem: { agendaItemIndex: 5, nonAgendaReason: null }, timing: 'during', anchor: { kind: 'agenda_item', timing: 'before' } });
        // A per-vote absence keeps the anchor the page states, range and all.
        expect(result.attendanceChanges[2]).toMatchObject({ type: 'absent_for_vote', anchor: { kind: 'decision_number', decisionNumber: '31', decisionNumberTo: '40' } });
        expect(result.attendanceChanges[0].anchor).toMatchObject({ decisionNumberTo: null });
        fetchSpy.mockRestore();
    });

    it('calls aiChat with the current model and structured output (no prefill)', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
            ok: true,
            arrayBuffer: () => Promise.resolve(new ArrayBuffer(50)),
        } as Response);

        mockAiChat.mockResolvedValueOnce({
            result: {
                presentMembers: [],
                absentMembers: [],
                decisionExcerpt: '',
                decisionNumber: null,
                references: '',
                voteResult: null,
                voteDetails: [],
                incomplete: false,
            },
            usage: { input_tokens: 100, output_tokens: 50 },
        });

        await extractDecisionFromPdf('https://example.com/test-ai-params-url.pdf');

        expect(mockAiChat).toHaveBeenCalledWith(expect.objectContaining({
            model: 'claude-sonnet-4-6',
            outputFormat: expect.objectContaining({ type: 'json_schema' }),
        }));
        // Assistant prefill is rejected by Claude 4.6+ models
        expect(mockAiChat.mock.calls[0][0].prefillSystemResponse).toBeUndefined();
        expect(mockAiChat.mock.calls[0][0].documentBase64).toBeDefined();
        expect(mockAiChat.mock.calls[0][0].systemPrompt).toContain('ΠΑΡΟΝΤΕΣ');

        fetchSpy.mockRestore();
    });

    const partial = (over: Record<string, unknown>) => ({
        result: { presentMembers: ['Μέλος 1'], absentMembers: [], decisionExcerpt: '', decisionNumber: null,
                  references: '', voteResult: null, voteDetails: [], attendanceChanges: [], incomplete: true, ...over },
        usage: { input_tokens: 10, output_tokens: 5 },
    });
    const mockFetch = () => vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
    } as Response);

    it('reads the pages between the front slice and the end of a 17-page document', async () => {
        mockGetPageCount.mockReturnValue(17);
        const fetchSpy = mockFetch();
        mockAiChat
            .mockResolvedValueOnce(partial({}))   // pages 1-5
            .mockResolvedValueOnce(partial({}))   // pages 1-10
            .mockResolvedValueOnce(partial({}))   // pages 1-15
            .mockResolvedValueOnce(partial({ decisionExcerpt: 'Αποφασίζει με 16 θετικές ψήφους', voteResult: 'Με δεκαέξι (16) θετικές ψήφους', incomplete: false }));

        const { result } = await extractDecisionFromPdf('https://example.com/seventeen-pages.pdf');

        expect(mockAiChat).toHaveBeenCalledTimes(4);
        expect(mockAiChat.mock.calls[3][0].userPrompt).toContain('pages 16-17 of a 17-page document');
        expect(result.voteResult).toBe('Με δεκαέξι (16) θετικές ψήφους');
        expect(result.presentMembers).toEqual(['Μέλος 1']); // attendance kept from the front pages
        expect(result.incomplete).toBe(false);
        fetchSpy.mockRestore();
    });

    it('keeps the preamble facts from the front read when the decision comes from the tail', async () => {
        mockGetPageCount.mockReturnValue(17);
        const fetchSpy = mockFetch();
        const frontPass = {
            result: {
                attendanceFormat: 'composition_and_absent', compositionMembers: ['Μέλος 1', 'Μέλος 2'],
                presentMembers: null, absentMembers: [], mayorPresent: null,
                presidedBy: { name: 'Αντιπρόεδρος Α', rawText: 'Προήδρευσε ο Αντιπρόεδρος Α' },
                decisionAttendance: { present: [], rawText: '' },
                voteTally: { FOR: -1, AGAINST: -1, ABSTAIN: -1, PRESENT: -1, DID_NOT_VOTE: -1 },
                decisionExcerpt: '', decisionNumber: null, references: '', voteResult: null,
                voteDetails: [], attendanceChanges: [], discussionOrder: null, subjectInfo: null, incomplete: true,
            },
            usage: { input_tokens: 10, output_tokens: 5 },
        };
        const tailPass = {
            result: {
                // The tail window prints no roll call and no presiding sentence.
                attendanceFormat: 'explicit_present_absent', compositionMembers: null,
                presentMembers: [], absentMembers: [], mayorPresent: null,
                presidedBy: { name: '', rawText: '' },
                decisionAttendance: { present: ['Μέλος 1'], rawText: 'ΤΑ ΜΕΛΗ: Μέλος 1' },
                voteTally: { FOR: 16, AGAINST: 2, ABSTAIN: -1, PRESENT: -1, DID_NOT_VOTE: -1 },
                decisionExcerpt: 'ΑΠΟΦΑΣΙΖΕΙ κατά πλειοψηφία', decisionNumber: '42/2025', references: '',
                voteResult: 'Κατά πλειοψηφία', voteDetails: [], attendanceChanges: [],
                discussionOrder: null, subjectInfo: null, incomplete: false,
            },
            usage: { input_tokens: 10, output_tokens: 5 },
        };
        mockAiChat
            .mockResolvedValueOnce(frontPass)   // pages 1-5
            .mockResolvedValueOnce(frontPass)   // pages 1-10
            .mockResolvedValueOnce(frontPass)   // pages 1-15
            .mockResolvedValueOnce(tailPass);   // pages 16-17

        const { result } = await extractDecisionFromPdf('https://example.com/tail-merge-preamble.pdf');

        // Preamble facts: whatever the front read saw.
        expect(result.attendanceFormat).toBe('composition_and_absent');
        expect(result.compositionMembers).toEqual(['Μέλος 1', 'Μέλος 2']);
        expect(result.presidedBy).toEqual({ name: 'Αντιπρόεδρος Α', rawText: 'Προήδρευσε ο Αντιπρόεδρος Α' });
        expect(result.presentMembers).toEqual(['Μέλος 1', 'Μέλος 2']);
        // Decision facts: whatever the tail read saw.
        expect(result.voteTally).toMatchObject({ FOR: 16, AGAINST: 2, ABSTAIN: null });
        expect(result.decisionAttendance).toEqual({ present: ['Μέλος 1'], rawText: 'ΤΑ ΜΕΛΗ: Μέλος 1' });
        expect(result.decisionNumber).toBe('42/2025');
        fetchSpy.mockRestore();
        mockGetPageCount.mockReturnValue(3);
    });

    it('does not accept a pass that claims completion with an empty excerpt', async () => {
        mockGetPageCount.mockReturnValue(20);
        const fetchSpy = mockFetch();
        mockAiChat
            .mockResolvedValueOnce(partial({ incomplete: false }))   // pages 1-5: "complete", no text
            .mockResolvedValueOnce(partial({ incomplete: false, decisionExcerpt: 'Αποφασίζει ομόφωνα', voteResult: 'Ομόφωνα' }))
            .mockResolvedValueOnce(partial({ incomplete: false, presentMembers: [] }));   // pages 18-20: the closing

        const { result } = await extractDecisionFromPdf('https://example.com/false-complete.pdf');

        expect(mockAiChat).toHaveBeenCalledTimes(3);
        expect(result.decisionExcerpt).toBe('Αποφασίζει ομόφωνα');
        fetchSpy.mockRestore();
    });

    // Papagos ΔΣ ΡΟ7ΞΩΞ1-85Χ: «ΑΠΟΦΑΣΙΣΕ ΟΜΟΦΩΝΑ» on page 8 of 14; the named
    // votes, the per-vote absence and the number on page 14.
    const papagosClosing = {
        result: {
            attendanceFormat: 'explicit_present_absent', compositionMembers: null, presentMembers: [], absentMembers: [], mayorPresent: null,
            presidedBy: { name: '', rawText: '' }, actingSecretary: { name: '', rawText: '' }, subjectHeading: '',
            decisionAttendance: { present: [], rawText: '' },
            voteTally: { FOR: -1, AGAINST: -1, ABSTAIN: -1, PRESENT: -1, DID_NOT_VOTE: -1 },
            decisionExcerpt: '', decisionNumber: '58/2026', references: '', voteResult: null,
            voteDetails: [
                ...['Αλέξανδρος Νομικός', 'Γεώργιος Μάγκος', 'Μαρία Σιώτου', 'Αναστασία Χαμηλοθώρη - Κουγιουμτζοπούλου', 'Αντώνιος Ρεκλείτης', 'Γεώργιος Ρεμούνδος', 'Νικόλαος Κουκής']
                    .map(name => ({ name, vote: 'AGAINST' })),
                { name: 'Γεώργιος Αυγερινός', vote: 'ABSTAIN' },
            ],
            attendanceChanges: [{
                name: 'Δημήτριος Οικονόμου', type: 'absent_for_vote',
                rawText: 'Κατά τη διαδικασία της ψηφοφορίας απουσίαζε ο Δημοτικός Σύμβουλος κος Δημήτριος Οικονόμου.',
                anchor: { kind: 'this_document', agendaItemIndex: 0, outOfAgenda: false, decisionNumber: '', decisionNumberTo: '', phase: 'none', timing: 'none' },
            }],
            discussionOrder: null, subjectInfo: null, incomplete: false,
        },
        usage: { input_tokens: 10, output_tokens: 5 },
    };

    it('reads the last pages when the front window reaches the decision before the end', async () => {
        mockGetPageCount.mockReturnValue(14);
        const fetchSpy = mockFetch();
        mockAiChat
            .mockResolvedValueOnce(partial({}))   // pages 1-5
            .mockResolvedValueOnce(partial({ incomplete: false, decisionExcerpt: 'ΑΠΟΦΑΣΙΣΕ ΟΜΟΦΩΝΑ', voteResult: 'Ομόφωνα' }))   // pages 1-10
            .mockResolvedValueOnce(papagosClosing);   // pages 12-14

        const { result, usage } = await extractDecisionFromPdf('https://example.com/papagos-closing.pdf');

        expect(mockAiChat).toHaveBeenCalledTimes(3);
        expect(mockAiChat.mock.calls[2][0].userPrompt).toContain('pages 12-14 of a 14-page document');
        expect(mockAiChat.mock.calls[2][0].label).toBe('decision-extraction:closing');
        expect(result.decisionExcerpt).toBe('ΑΠΟΦΑΣΙΣΕ ΟΜΟΦΩΝΑ');
        expect(result.voteResult).toBe('Ομόφωνα');
        expect(result.presentMembers).toEqual(['Μέλος 1']);
        expect(result.decisionNumber).toBe('58/2026');
        expect(result.voteDetails.filter(v => v.vote === 'AGAINST')).toHaveLength(7);
        expect(result.voteDetails).toContainEqual({ name: 'Γεώργιος Αυγερινός', vote: 'ABSTAIN' });
        expect(result.attendanceChanges).toEqual([expect.objectContaining({ name: 'Δημήτριος Οικονόμου', type: 'absent_for_vote' })]);
        expect(usage.input_tokens).toBe(30);
        fetchSpy.mockRestore();
        mockGetPageCount.mockReturnValue(3);
    });

    it('keeps the front read with a warning when the closing call fails', async () => {
        mockGetPageCount.mockReturnValue(14);
        const fetchSpy = mockFetch();
        mockAiChat
            .mockResolvedValueOnce(partial({}))   // pages 1-5
            .mockResolvedValueOnce(partial({ incomplete: false, decisionExcerpt: 'ΑΠΟΦΑΣΙΣΕ ΟΜΟΦΩΝΑ', voteResult: 'Ομόφωνα' }))   // pages 1-10
            .mockRejectedValueOnce(new Error('max_tokens reached'));   // pages 12-14

        const { result, warnings } = await extractDecisionFromPdf('https://example.com/closing-fails.pdf');

        expect(mockAiChat).toHaveBeenCalledTimes(3);
        expect(result.decisionExcerpt).toBe('ΑΠΟΦΑΣΙΣΕ ΟΜΟΦΩΝΑ');
        expect(result.incomplete).toBe(false);
        expect(warnings).toEqual([expect.objectContaining({ code: 'CLOSING_READ_FAILED', severity: 'warning', message: expect.stringContaining('max_tokens reached') })]);
        fetchSpy.mockRestore();
        mockGetPageCount.mockReturnValue(3);
    });

    it('reads only the closing pages the front window did not reach', async () => {
        mockGetPageCount.mockReturnValue(11);
        const fetchSpy = mockFetch();
        mockAiChat
            .mockResolvedValueOnce(partial({}))   // pages 1-5
            .mockResolvedValueOnce(partial({ incomplete: false, decisionExcerpt: 'ΑΠΟΦΑΣΙΖΕΙ', voteResult: 'Ομόφωνα' }))   // pages 1-10
            .mockResolvedValueOnce(partial({ incomplete: false, presentMembers: [] }));   // page 11

        await extractDecisionFromPdf('https://example.com/eleven-pages.pdf');

        expect(mockAiChat).toHaveBeenCalledTimes(3);
        expect(mockAiChat.mock.calls[2][0].userPrompt).toContain('page 11 of a 11-page document');
        fetchSpy.mockRestore();
        mockGetPageCount.mockReturnValue(3);
    });

    it('makes no closing call when the front window already holds the last page', async () => {
        mockGetPageCount.mockReturnValue(12);
        const fetchSpy = mockFetch();
        mockAiChat
            .mockResolvedValueOnce(partial({}))   // pages 1-5
            .mockResolvedValueOnce(partial({}))   // pages 1-10
            .mockResolvedValueOnce(partial({ incomplete: false, decisionExcerpt: 'ΑΠΟΦΑΣΙΖΕΙ', voteResult: 'Ομόφωνα' }));   // pages 1-12

        await extractDecisionFromPdf('https://example.com/twelve-pages.pdf');

        expect(mockAiChat).toHaveBeenCalledTimes(3);
        expect(mockAiChat.mock.calls.map(c => c[0].label)).not.toContain('decision-extraction:closing');
        fetchSpy.mockRestore();
        mockGetPageCount.mockReturnValue(3);
    });

    // Argos 359/2025 (62ΟΒΩΨΔ-Ε7Π, 154 pages): page 5 holds the vote and names
    // 1-13 of «Τα Μέλη»; page 6 holds names 14-20, all five named dissenters
    // among them. The front read stops at page 5 and the closing read takes
    // pages 152-154, an annex.
    const argosFront = (closingBlockContinues: boolean | undefined) => partial({
        incomplete: false, decisionExcerpt: 'ΑΠΟΦΑΣΙΖΕΙ κατά πλειοψηφία', decisionNumber: '359/2025', voteResult: 'Κατά πλειοψηφία',
        voteDetails: ARGOS_DISSENTERS,
        decisionAttendance: { present: ARGOS_LIST.slice(0, 13), rawText: 'Τα Μέλη\n1. Α. Αργυροπούλου(Σύμβουλος)' },
        closingBlockContinues,
    });
    const argosContinuation = (closingBlockContinues: boolean) => partial({
        incomplete: false, presentMembers: [], decisionNumber: null,
        decisionAttendance: { present: ARGOS_LIST.slice(13), rawText: '14. Β. Καραβίδας' },
        closingBlockContinues,
    });
    const annexClosing = partial({ incomplete: false, presentMembers: [] });
    const labels = () => mockAiChat.mock.calls.map(c => c[0].label);

    it('reads no further when the front read says the closing block ends in its pages', async () => {
        mockGetPageCount.mockReturnValue(154);
        const fetchSpy = mockFetch();
        mockAiChat
            .mockResolvedValueOnce(argosFront(false))   // pages 1-5
            .mockResolvedValueOnce(annexClosing);        // pages 152-154

        await extractDecisionFromPdf('https://example.com/argos-flag-false.pdf');

        expect(labels()).toEqual(['decision-extraction:partial', 'decision-extraction:closing']);
        fetchSpy.mockRestore();
        mockGetPageCount.mockReturnValue(3);
    });

    it('reads the last front page and the two pages after it when the closing block runs past the front window', async () => {
        mockGetPageCount.mockReturnValue(154);
        const fetchSpy = mockFetch();
        mockAiChat
            .mockResolvedValueOnce(argosFront(true))           // pages 1-5
            .mockResolvedValueOnce(argosContinuation(false))   // pages 5-7
            .mockResolvedValueOnce(annexClosing);              // pages 152-154

        const { result, warnings } = await extractDecisionFromPdf('https://example.com/argos-flag-true.pdf');

        expect(labels()).toEqual(['decision-extraction:partial', 'decision-extraction:continuation', 'decision-extraction:closing']);
        const continuationPrompt: string = mockAiChat.mock.calls[1][0].userPrompt;
        expect(continuationPrompt).toContain('pages 5-7 of a 154-page document');
        expect(continuationPrompt).toContain('359/2025');
        expect(continuationPrompt).toContain('page 5');
        expect(mockAiChat.mock.calls[2][0].userPrompt).toContain('pages 152-154 of a 154-page document');
        expect(result.decisionAttendance?.present).toEqual(ARGOS_LIST);
        expect(result.voteDetails).toEqual(ARGOS_DISSENTERS);
        expect(warnings).toBeUndefined();
        fetchSpy.mockRestore();
        mockGetPageCount.mockReturnValue(3);
    });

    it('gives the continuation its pages first and the closing read the rest', async () => {
        mockGetPageCount.mockReturnValue(14);
        const fetchSpy = mockFetch();
        mockAiChat
            .mockResolvedValueOnce(partial({}))   // pages 1-5
            .mockResolvedValueOnce(partial({ incomplete: false, decisionExcerpt: 'ΑΠΟΦΑΣΙΖΕΙ', voteResult: 'Ομόφωνα', closingBlockContinues: true }))   // pages 1-10
            .mockResolvedValueOnce(partial({ incomplete: false, presentMembers: [], closingBlockContinues: true }))   // pages 10-12
            .mockResolvedValueOnce(annexClosing);   // pages 13-14

        const { warnings } = await extractDecisionFromPdf('https://example.com/continuation-overlap.pdf');

        expect(labels()).toEqual(['decision-extraction:partial', 'decision-extraction:partial', 'decision-extraction:continuation', 'decision-extraction:closing']);
        expect(mockAiChat.mock.calls[2][0].userPrompt).toContain('pages 10-12 of a 14-page document');
        expect(mockAiChat.mock.calls[3][0].userPrompt).toContain('pages 13-14 of a 14-page document');
        // The block runs on into pages the closing read takes: nothing is cut.
        expect(warnings).toBeUndefined();
        fetchSpy.mockRestore();
        mockGetPageCount.mockReturnValue(3);
    });

    it('makes no closing read when the continuation reaches the last page', async () => {
        mockGetPageCount.mockReturnValue(12);
        const fetchSpy = mockFetch();
        mockAiChat
            .mockResolvedValueOnce(partial({}))   // pages 1-5
            .mockResolvedValueOnce(partial({ incomplete: false, decisionExcerpt: 'ΑΠΟΦΑΣΙΖΕΙ', voteResult: 'Ομόφωνα', closingBlockContinues: true }))   // pages 1-10
            .mockResolvedValueOnce(partial({ incomplete: false, presentMembers: [], closingBlockContinues: true }));   // pages 10-12

        const { warnings } = await extractDecisionFromPdf('https://example.com/continuation-none-left.pdf');

        expect(labels()).toEqual(['decision-extraction:partial', 'decision-extraction:partial', 'decision-extraction:continuation']);
        expect(mockAiChat.mock.calls[2][0].userPrompt).toContain('pages 10-12 of a 12-page document');
        // The continuation read the last page: nothing lies past it to be cut.
        expect(warnings).toBeUndefined();
        fetchSpy.mockRestore();
        mockGetPageCount.mockReturnValue(3);
    });

    it('keeps each name once when the continuation returns the whole list', async () => {
        mockGetPageCount.mockReturnValue(154);
        const fetchSpy = mockFetch();
        mockAiChat
            .mockResolvedValueOnce(argosFront(true))   // pages 1-5: names 1-13
            .mockResolvedValueOnce(partial({           // pages 5-7: names 1-20
                incomplete: false, presentMembers: [], decisionNumber: '359/2025',
                decisionAttendance: { present: ARGOS_LIST, rawText: 'Τα Μέλη\n1. Α. Αργυροπούλου(Σύμβουλος)' },
                closingBlockContinues: false,
            }))
            .mockResolvedValueOnce(annexClosing);      // pages 152-154

        const { result } = await extractDecisionFromPdf('https://example.com/continuation-whole-list.pdf');

        expect(result.decisionAttendance?.present).toEqual(ARGOS_LIST);
        expect(result.voteDetails).toEqual(ARGOS_DISSENTERS);
        fetchSpy.mockRestore();
        mockGetPageCount.mockReturnValue(3);
    });

    it('takes the whole list from the continuation when the front read left out the names of its last page', async () => {
        mockGetPageCount.mockReturnValue(154);
        const fetchSpy = mockFetch();
        mockAiChat
            .mockResolvedValueOnce(partial({   // pages 1-5: the vote, but no names
                incomplete: false, decisionExcerpt: 'ΑΠΟΦΑΣΙΖΕΙ κατά πλειοψηφία', decisionNumber: '359/2025', voteResult: 'Κατά πλειοψηφία',
                voteDetails: ARGOS_DISSENTERS, closingBlockContinues: true,
            }))
            .mockResolvedValueOnce(partial({   // pages 5-7: names 1-20
                incomplete: false, presentMembers: [], decisionNumber: '359/2025',
                decisionAttendance: { present: ARGOS_LIST, rawText: 'Τα Μέλη\n1. Α. Αργυροπούλου(Σύμβουλος)' },
                closingBlockContinues: false,
            }))
            .mockResolvedValueOnce(annexClosing);   // pages 152-154

        const { result } = await extractDecisionFromPdf('https://example.com/continuation-cold-front.pdf');

        expect(result.decisionAttendance?.present).toEqual(ARGOS_LIST);
        fetchSpy.mockRestore();
        mockGetPageCount.mockReturnValue(3);
    });

    it('keeps the front read with a warning when the continuation call fails', async () => {
        mockGetPageCount.mockReturnValue(154);
        const fetchSpy = mockFetch();
        mockAiChat
            .mockResolvedValueOnce(argosFront(true))                         // pages 1-5
            .mockRejectedValueOnce(new Error('overloaded_error'));           // pages 5-7

        const { result, warnings } = await extractDecisionFromPdf('https://example.com/continuation-fails.pdf');

        expect(labels()).toEqual(['decision-extraction:partial', 'decision-extraction:continuation']);
        expect(result.decisionAttendance?.present).toEqual(ARGOS_LIST.slice(0, 13));
        expect(result.incomplete).toBe(false);
        expect(warnings).toEqual([expect.objectContaining({
            code: 'CLOSING_READ_FAILED', severity: 'warning',
            message: expect.stringMatching(/Pages 5-7 of 154.*overloaded_error/),
        })]);
        fetchSpy.mockRestore();
        mockGetPageCount.mockReturnValue(3);
    });

    it('warns that the closing block is cut when it still runs past the continuation', async () => {
        mockGetPageCount.mockReturnValue(154);
        const fetchSpy = mockFetch();
        mockAiChat
            .mockResolvedValueOnce(argosFront(true))          // pages 1-5
            .mockResolvedValueOnce(argosContinuation(true))   // pages 5-7
            .mockResolvedValueOnce(annexClosing);             // pages 152-154

        const { result, warnings } = await extractDecisionFromPdf('https://example.com/continuation-cut.pdf');

        expect(labels()).toHaveLength(3);
        expect(result.decisionAttendance?.present).toEqual(ARGOS_LIST);
        expect(warnings).toEqual([expect.objectContaining({ code: 'CLOSING_BLOCK_CUT', severity: 'warning', message: expect.stringContaining('page 7') })]);
        fetchSpy.mockRestore();
        mockGetPageCount.mockReturnValue(3);
    });

    it('returns the warnings of a cached reading on a cache hit', async () => {
        mockGetPageCount.mockReturnValue(154);
        const fetchSpy = mockFetch();
        mockAiChat
            .mockResolvedValueOnce(argosFront(true))          // pages 1-5
            .mockResolvedValueOnce(argosContinuation(true))   // pages 5-7
            .mockResolvedValueOnce(annexClosing);             // pages 152-154

        const first = await extractDecisionFromPdf('https://example.com/continuation-cut-cached.pdf');
        const second = await extractDecisionFromPdf('https://example.com/continuation-cut-cached.pdf');

        expect(mockAiChat).toHaveBeenCalledTimes(3);
        expect(second.fromCache).toBe(true);
        expect(second.warnings).toEqual(first.warnings);
        expect(second.warnings).toEqual([expect.objectContaining({ code: 'CLOSING_BLOCK_CUT' })]);
        expect(second.result.decisionAttendance).toEqual(first.result.decisionAttendance);
        expect(second.result.voteDetails).toEqual(first.result.voteDetails);
        expect(second.result).not.toHaveProperty('warnings');
        fetchSpy.mockRestore();
        mockGetPageCount.mockReturnValue(3);
    });

    it('returns no warnings on a hit of a reading cached without them', async () => {
        const url = 'https://example.com/cached-before-warnings.pdf';
        const hash = crypto.createHash('sha256').update(extractionCacheKey(url)).digest('hex').slice(0, 16);
        cacheFiles.set(`/tmp/opencouncil-decisions-cache/decision-${hash}.json`, JSON.stringify({
            presentMembers: ['Μέλος 1'], absentMembers: [], decisionExcerpt: 'ΑΠΟΦΑΣΙΖΕΙ', decisionNumber: '1/2025',
            references: '', voteResult: 'Ομόφωνα', voteDetails: [], attendanceChanges: [], incomplete: false,
        }));

        const { result, warnings, fromCache } = await extractDecisionFromPdf(url);

        expect(fromCache).toBe(true);
        expect(mockAiChat).not.toHaveBeenCalled();
        expect(warnings).toBeUndefined();
        expect(result.decisionNumber).toBe('1/2025');
    });

    const WHOLE_READ_FIELDS = [
        'attendanceFormat', 'compositionMembers', 'presentMembers', 'absentMembers',
        'mayorPresent', 'decisionExcerpt', 'decisionNumber', 'references',
        'voteResult', 'voteDetails', 'attendanceChanges', 'discussionOrder',
        'subjectInfo', 'incomplete', 'presidedBy', 'actingSecretary', 'subjectHeading', 'voteTally', 'decisionAttendance',
    ];

    it('sends a whole document with the prompt and the schema it had before', async () => {
        mockGetPageCount.mockReturnValue(10);
        const fetchSpy = mockFetch();
        mockAiChat.mockResolvedValueOnce(partial({ incomplete: false, decisionExcerpt: 'ΑΠΟΦΑΣΙΖΕΙ', closingBlockContinues: true }));

        const { warnings } = await extractDecisionFromPdf('https://example.com/whole-ten.pdf', 'Μαρία Μ', false, 'The body prints ΤΑ ΜΕΛΗ.');

        expect(mockAiChat).toHaveBeenCalledOnce();
        const call = mockAiChat.mock.calls[0][0];
        expect(call.label).toBe('decision-extraction');
        expect(call.userPrompt).toBe('Extract the required information from this Greek municipal council decision PDF.\nThe city mayor is: Μαρία Μ\nThe body prints ΤΑ ΜΕΛΗ.');
        expect(Object.keys(call.outputFormat.schema.properties).sort()).toEqual([...WHOLE_READ_FIELDS].sort());
        expect(call.outputFormat.schema.required).toEqual(WHOLE_READ_FIELDS);
        expect(warnings).toBeUndefined();
        fetchSpy.mockRestore();
        mockGetPageCount.mockReturnValue(3);
    });

    it('asks for the flag only on a front read that holds part of the document', async () => {
        mockGetPageCount.mockReturnValue(12);
        const fetchSpy = mockFetch();
        mockAiChat
            .mockResolvedValueOnce(partial({}))   // pages 1-5
            .mockResolvedValueOnce(partial({}))   // pages 1-10
            .mockResolvedValueOnce(partial({ incomplete: false, decisionExcerpt: 'ΑΠΟΦΑΣΙΖΕΙ', closingBlockContinues: true }));   // pages 1-12

        await extractDecisionFromPdf('https://example.com/flag-scope.pdf');

        const schemas = mockAiChat.mock.calls.map(c => c[0].outputFormat.schema);
        expect(schemas[0].required).toEqual([...WHOLE_READ_FIELDS, 'closingBlockContinues']);
        expect(schemas[1].required).toEqual([...WHOLE_READ_FIELDS, 'closingBlockContinues']);
        // Pages 1-12 of 12 are the whole document: the prompt and the schema of a whole read.
        expect(mockAiChat.mock.calls[2][0].userPrompt).toBe('Extract the required information from this Greek municipal council decision PDF.');
        expect(schemas[2].required).toEqual(WHOLE_READ_FIELDS);
        expect(mockAiChat).toHaveBeenCalledTimes(3);
        fetchSpy.mockRestore();
        mockGetPageCount.mockReturnValue(3);
    });

    /** How many pages each call of the read sent, in call order. */
    const pagesSentPerCall = async () => {
        const { copyPages } = await PDFDocument.create();
        return vi.mocked(copyPages).mock.calls.map(([, indices]) => indices.length);
    };

    it.each([
        { totalPages: 200, tail: ['pages 186-200 of a 200-page document', 'pages 171-185 of a 200-page document'] },
        { totalPages: 317, tail: ['pages 303-317 of a 317-page document', 'pages 288-302 of a 317-page document'] },
    ])('reads at most two tail windows of a $totalPages-page document, then returns the read as incomplete', async ({ totalPages, tail }) => {
        mockGetPageCount.mockReturnValue(totalPages);
        vi.mocked((await PDFDocument.create()).copyPages).mockClear();
        const fetchSpy = mockFetch();
        mockAiChat.mockResolvedValue(partial({}));   // no window reaches the decision

        const { result } = await extractDecisionFromPdf(`https://example.com/${totalPages}-pages.pdf`);

        expect(mockAiChat).toHaveBeenCalledTimes(5);
        expect(await pagesSentPerCall()).toEqual([5, 10, 15, 15, 15]);
        expect(mockAiChat.mock.calls.slice(3).map(c => c[0].userPrompt)).toEqual(tail.map(t => expect.stringContaining(t)));
        expect(result.incomplete).toBe(true);
        expect(result.presentMembers).toEqual(['Μέλος 1']);
        fetchSpy.mockRestore();
        mockGetPageCount.mockReturnValue(3);
    });

    /** The 1-based pages each tail call of a read held, from its prompt. */
    const tailPagesRead = () => mockAiChat.mock.calls
        .filter(c => c[0].label === 'decision-extraction:tail')
        .flatMap(c => {
            const [, from, to] = /pages (\d+)-(\d+) of a/.exec(c[0].userPrompt)!;
            return Array.from({ length: Number(to) - Number(from) + 1 }, (_, i) => Number(from) + i);
        });

    // Two windows of five pages left pages 16 to N-10 unread: the Vrilissia
    // decision ΨΡΖΒΩ9Ρ-Γ1Τ prints «Αποφασίζει» on page 27 of 38, and the capped
    // read returned it incomplete with pages 16-28 unread.
    it.each([26, 32, 38, 45])('puts every page of a %i-page document in front of the model, in at most five calls', async (totalPages) => {
        mockGetPageCount.mockReturnValue(totalPages);
        vi.mocked((await PDFDocument.create()).copyPages).mockClear();
        const fetchSpy = mockFetch();
        mockAiChat.mockResolvedValue(partial({}));

        await extractDecisionFromPdf(`https://example.com/coverage-${totalPages}.pdf`);

        expect(mockAiChat).toHaveBeenCalledTimes(5);
        expect(new Set(tailPagesRead())).toEqual(new Set(Array.from({ length: totalPages - 15 }, (_, i) => 16 + i)));
        expect((await pagesSentPerCall()).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(60);
        fetchSpy.mockRestore();
        mockGetPageCount.mockReturnValue(3);
    });

    it('reads the decision of a 38-page document from the window that holds page 27', async () => {
        mockGetPageCount.mockReturnValue(38);
        const fetchSpy = mockFetch();
        mockAiChat
            .mockResolvedValueOnce(partial({}))   // pages 1-5
            .mockResolvedValueOnce(partial({}))   // pages 1-10
            .mockResolvedValueOnce(partial({}))   // pages 1-15
            .mockResolvedValueOnce(partial({ incomplete: false, decisionExcerpt: 'Αποφασίζει', voteResult: 'Με δεκαεννέα (19) θετικές ψήφους' }));

        const { result } = await extractDecisionFromPdf('https://example.com/vrilissia-38.pdf');

        expect(mockAiChat).toHaveBeenCalledTimes(4);
        expect(mockAiChat.mock.calls[3][0].userPrompt).toContain('pages 27-38 of a 38-page document');
        expect(result.incomplete).toBe(false);
        expect(result.voteResult).toBe('Με δεκαεννέα (19) θετικές ψήφους');
        fetchSpy.mockRestore();
        mockGetPageCount.mockReturnValue(3);
    });

    it('uses progressive extraction for large PDFs', async () => {
        mockGetPageCount.mockReturnValue(20); // Large PDF

        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
            ok: true,
            arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
        } as Response);

        // First call: incomplete
        mockAiChat.mockResolvedValueOnce({
            result: {
                presentMembers: ['Μέλος 1'],
                absentMembers: [],
                decisionExcerpt: '',
                decisionNumber: null,
                references: '',
                voteResult: null,
                voteDetails: [],
                incomplete: true,
            },
            usage: { input_tokens: 50, output_tokens: 25 },
        });

        // Second call: complete
        mockAiChat.mockResolvedValueOnce({
            result: {
                presentMembers: ['Μέλος 1'],
                absentMembers: [],
                decisionExcerpt: 'Αποφασίζεται...',
                decisionNumber: '1/2025',
                references: '',
                voteResult: 'Ομόφωνα',
                voteDetails: [],
                incomplete: false,
            },
            usage: { input_tokens: 80, output_tokens: 40 },
        });

        // Third call: the closing pages, which state nothing more
        mockAiChat.mockResolvedValueOnce(partial({ incomplete: false, presentMembers: [] }));

        const { result, usage } = await extractDecisionFromPdf('https://example.com/test-progressive-url.pdf');

        expect(result.incomplete).toBe(false);
        expect(result.decisionExcerpt).toBe('Αποφασίζεται...');
        expect(mockAiChat).toHaveBeenCalledTimes(3);
        // Usage should be aggregated
        expect(usage.input_tokens).toBe(140);
        expect(usage.output_tokens).toBe(70);

        fetchSpy.mockRestore();
        mockGetPageCount.mockReturnValue(3); // Reset
    });
});

describe('adoptLaterVoteNames', () => {
    const base = { attendanceFormat: 'explicit_present_absent' as const, compositionMembers: null, presentMembers: [], absentMembers: [], mayorPresent: null, decisionExcerpt: 'x',
        decisionNumber: null, references: '', attendanceChanges: [], discussionOrder: null, subjectInfo: null, incomplete: false, presidedBy: null, actingSecretary: null, subjectHeading: '', decisionAttendance: null };
    const tally = (FOR: number | null) => ({ FOR, AGAINST: null, ABSTAIN: null, PRESENT: null, DID_NOT_VOTE: null });
    const names = (n: number, vote: 'FOR' | 'PRESENT') => Array.from({ length: n }, (_, i) => ({ name: `${vote} ${i}`, vote }));
    it('adopts the names of a later window whose ΥΠΕΡ count equals the printed one', () => {
        const winner = { ...base, voteResult: 'Με δεκαεννέα (19) θετικές ψήφους', voteTally: tally(19), voteDetails: [] };
        const later = { ...base, voteResult: null, voteTally: tally(null), voteDetails: [...names(19, 'FOR'), ...names(8, 'PRESENT')] };
        expect(adoptLaterVoteNames(winner, [later]).voteDetails).toHaveLength(27);
    });
    it('leaves an embedded decision of another body alone', () => {
        const winner = { ...base, voteResult: 'Με δεκαεννέα (19) θετικές ψήφους', voteTally: tally(19), voteDetails: [] };
        const committee = { ...base, voteResult: 'Με πέντε (5) θετικές ψήφους', voteTally: tally(5), voteDetails: [...names(5, 'FOR'), ...names(2, 'PRESENT')] };
        expect(adoptLaterVoteNames(winner, [committee])).toBe(winner);
    });
    it('does nothing when the decision window already names voters or printed no count', () => {
        const named = { ...base, voteResult: 'Ομόφωνα', voteTally: tally(null), voteDetails: names(3, 'FOR') };
        expect(adoptLaterVoteNames(named, [{ ...base, voteResult: null, voteTally: tally(null), voteDetails: names(3, 'FOR') }])).toBe(named);
    });
    it('keeps a named dissenter the later window does not reprint', () => {
        const winner = { ...base, voteResult: 'Με δεκαεννέα (19) θετικές ψήφους και μία (1) κατά', voteTally: tally(19),
            voteDetails: [{ name: 'Χρήστος Χ', vote: 'AGAINST' as const }] };
        const later = { ...base, voteResult: null, voteTally: tally(null), voteDetails: names(19, 'FOR') };

        const merged = adoptLaterVoteNames(winner, [later]).voteDetails;
        expect(merged).toContainEqual({ name: 'Χρήστος Χ', vote: 'AGAINST' });
        expect(merged.filter(v => v.vote === 'FOR')).toHaveLength(19);
    });
    it('keeps its own row when the later window names the same person differently', () => {
        const winner = { ...base, voteResult: 'Με δύο (2) θετικές ψήφους', voteTally: tally(2),
            voteDetails: [{ name: 'Χαμντί Ντάφερ', vote: 'AGAINST' as const }] };
        const later = { ...base, voteResult: null, voteTally: tally(null),
            voteDetails: [{ name: 'Χαμντί Ντ.', vote: 'FOR' as const }, { name: 'Λυδία Βέρα', vote: 'FOR' as const }] };

        expect(adoptLaterVoteNames(winner, [later]).voteDetails).toEqual([
            { name: 'Χαμντί Ντάφερ', vote: 'AGAINST' },
            { name: 'Λυδία Βέρα', vote: 'FOR' },
        ]);
    });
    it('does not treat a printed zero as a count any window can match', () => {
        const winner = { ...base, voteResult: 'Απορρίπτεται', voteTally: tally(0), voteDetails: [] };
        const unrelated = { ...base, voteResult: null, voteTally: tally(null), voteDetails: names(4, 'PRESENT') };
        expect(adoptLaterVoteNames(winner, [unrelated])).toBe(winner);
    });
});


describe('withClosingFacts', () => {
    const base: RawExtractedDecision = { attendanceFormat: 'explicit_present_absent', compositionMembers: null, presentMembers: ['Αθανάσιος Αυγουρόπουλος'], absentMembers: [],
        mayorPresent: null, decisionExcerpt: 'ΑΠΟΦΑΣΙΣΕ ΟΜΟΦΩΝΑ', decisionNumber: null, references: '', voteResult: 'Ομόφωνα', voteDetails: [], attendanceChanges: [],
        discussionOrder: null, subjectInfo: null, incomplete: false, presidedBy: null, actingSecretary: null, subjectHeading: '', decisionAttendance: null,
        voteTally: { FOR: null, AGAINST: null, ABSTAIN: null, PRESENT: null, DID_NOT_VOTE: null } };
    const absence = (name: string): RawExtractedDecision['attendanceChanges'][number] => ({
        name, type: 'absent_for_vote', agendaItem: null, timing: null,
        anchor: { kind: 'this_document', agendaItem: null, decisionNumber: null, decisionNumberTo: null, phase: null, timing: null },
        rawText: `Κατά τη διαδικασία της ψηφοφορίας απουσίαζε ο Δημοτικός Σύμβουλος κος ${name}.`,
    });
    const closing: RawExtractedDecision = { ...base, presentMembers: [], decisionExcerpt: '', voteResult: null, decisionNumber: '58/2026',
        voteDetails: [{ name: 'Αλέξανδρος Νομικός', vote: 'AGAINST' }, { name: 'Γεώργιος Αυγερινός', vote: 'ABSTAIN' }],
        attendanceChanges: [absence('Δημήτριος Οικονόμου')],
        decisionAttendance: { present: ['Μ. Αθανασάκου - Μουντάκη', 'Β. Σιαμάνης'], rawText: 'Τα Μέλη' } };

    const counted = { ...base.voteTally, FOR: 12, AGAINST: 7 };

    it('adds what the closing states to the front read', () => {
        const front = { ...base, decisionNumber: '58' };
        const merged = withClosingFacts(front, { ...closing, voteTally: counted });
        expect(merged.decisionExcerpt).toBe('ΑΠΟΦΑΣΙΣΕ ΟΜΟΦΩΝΑ');
        expect(merged.voteResult).toBe('Ομόφωνα');
        expect(merged.presentMembers).toEqual(['Αθανάσιος Αυγουρόπουλος']);
        expect(merged.decisionNumber).toBe('58');
        expect(merged.voteDetails).toEqual(closing.voteDetails);
        expect(merged.attendanceChanges).toEqual([absence('Δημήτριος Οικονόμου')]);
        expect(merged.decisionAttendance).toEqual(closing.decisionAttendance);
        expect(merged.voteTally).toEqual(counted);
    });

    // An attached document whose last pages print no number and no count
    // passes closesTheSameDecision; its member list must not become this
    // decision's attendance.
    it.each([
        { case: 'the front read states no number', front: { ...base }, closingNumber: '58/2026' },
        { case: 'the closing prints no number', front: { ...base, decisionNumber: '58/2026' }, closingNumber: null },
        { case: 'the front number holds no digit', front: { ...base, decisionNumber: 'The Ilisian' }, closingNumber: '58/2026' },
    ])('takes the member list and the counts only from a closing that prints the front number: $case', ({ front, closingNumber }) => {
        const merged = withClosingFacts(front, { ...closing, decisionNumber: closingNumber, voteTally: counted });
        expect(merged.decisionAttendance).toBeNull();
        expect(merged.voteTally).toEqual(base.voteTally);
        // Names and per-vote absences keep the rule they had.
        expect(merged.voteDetails).toEqual(closing.voteDetails);
        expect(merged.attendanceChanges).toEqual([absence('Δημήτριος Οικονόμου')]);
    });

    it('reads an empty front number or vote phrase as not stated', () => {
        const merged = withClosingFacts({ ...base, decisionNumber: '', voteResult: '  ' }, { ...closing, voteResult: 'Ομόφωνα' });
        expect(merged.decisionNumber).toBe('58/2026');
        expect(merged.voteResult).toBe('Ομόφωνα');
    });

    it('keeps a front number with no digit when the closing prints none either', () => {
        expect(withClosingFacts({ ...base, decisionNumber: 'The Ilisian' }, { ...closing, decisionNumber: '' }).decisionNumber).toBe('The Ilisian');
    });

    it('never replaces a fact the front read stated', () => {
        const front: RawExtractedDecision = { ...base, decisionNumber: '58/2026',
            voteDetails: [{ name: 'Νομικός Α.', vote: 'DID_NOT_VOTE' }],
            attendanceChanges: [absence('Οικονόμου Δημήτριος')],
            decisionAttendance: { present: ['Β. Σιαμάνης'], rawText: 'Τα Μέλη' } };
        const merged = withClosingFacts(front, closing);
        expect(merged.voteDetails).toEqual([{ name: 'Νομικός Α.', vote: 'DID_NOT_VOTE' }, { name: 'Γεώργιος Αυγερινός', vote: 'ABSTAIN' }]);
        expect(merged.attendanceChanges).toEqual([absence('Οικονόμου Δημήτριος')]);
        expect(merged.decisionAttendance).toEqual(front.decisionAttendance);
    });

    // Orestiada 97ΤΓΩΞΒ-Ψ0Μ: a member arrives during the items read out, is
    // out for this decision's vote and returns after it. Where the front read
    // states the first arrival and the closing pages the absence, the return is
    // a second arrival of the same member at another point of the meeting.
    it('keeps a second arrival of the same member at another point', () => {
        const change = (type: 'arrival' | 'departure', anchor: AttendanceAnchor): RawExtractedDecision['attendanceChanges'][number] =>
            ({ name: 'Πέτρος Αργυριάδης', type, agendaItem: null, timing: null, anchor, rawText: type });
        const preAgenda: AttendanceAnchor = { kind: 'phase', agendaItem: null, decisionNumber: null, decisionNumberTo: null, phase: 'pre_agenda', timing: 'during' };
        const vote = (timing: 'during' | 'after'): AttendanceAnchor => ({ kind: 'this_document', agendaItem: null, decisionNumber: null, decisionNumberTo: null, phase: null, timing });
        const front = { ...base, decisionNumber: '58/2026', attendanceChanges: [change('arrival', preAgenda)] };
        const merged = withClosingFacts(front, { ...closing, attendanceChanges: [
            change('departure', vote('during')), change('arrival', vote('after')),
            // The closing pages restate the first arrival with another timing: it is the same change.
            change('arrival', { ...preAgenda, timing: 'before' }),
        ] });
        expect(merged.attendanceChanges.map(c => [c.type, c.anchor!.kind])).toEqual([['arrival', 'phase'], ['departure', 'this_document'], ['arrival', 'this_document']]);
    });

    it('leaves an attached decision with another number alone', () => {
        const front = { ...base, decisionNumber: '58/2026' };
        expect(withClosingFacts(front, { ...closing, decisionNumber: '112/2026' })).toBe(front);
    });

    it('leaves a closing whose printed count disagrees alone', () => {
        const front = { ...base, voteTally: { ...base.voteTally, FOR: 14 } };
        expect(withClosingFacts(front, { ...closing, voteTally: { ...base.voteTally, FOR: 5 } })).toBe(front);
    });

    it('takes a closing number with digits over a front number with none', () => {
        const front = { ...base, decisionNumber: 'The Ilisian' };
        const merged = withClosingFacts(front, { ...closing, decisionNumber: '1440/2026' });
        expect(merged.decisionNumber).toBe('1440/2026');
        expect(merged.voteDetails).toHaveLength(2);
    });
});

describe('withContinuationFacts', () => {
    const base: RawExtractedDecision = { attendanceFormat: 'explicit_present_absent', compositionMembers: null, presentMembers: ['Α. Αργυροπούλου'], absentMembers: [],
        mayorPresent: null, decisionExcerpt: 'ΑΠΟΦΑΣΙΖΕΙ κατά πλειοψηφία', decisionNumber: '359/2025', references: '', voteResult: 'Κατά πλειοψηφία',
        voteDetails: ARGOS_DISSENTERS, attendanceChanges: [], discussionOrder: null, subjectInfo: null, incomplete: false, presidedBy: null,
        actingSecretary: null, subjectHeading: '', voteTally: { FOR: null, AGAINST: null, ABSTAIN: null, PRESENT: null, DID_NOT_VOTE: null },
        decisionAttendance: { present: ARGOS_LIST.slice(0, 13), rawText: 'Τα Μέλη\n1. Α. Αργυροπούλου(Σύμβουλος)' } };
    const continuation: RawExtractedDecision = { ...base, presentMembers: [], decisionExcerpt: '', decisionNumber: null, voteResult: null, voteDetails: [],
        decisionAttendance: { present: ARGOS_LIST.slice(13), rawText: '14. Β. Καραβίδας' } };
    const absence = (name: string): RawExtractedDecision['attendanceChanges'][number] => ({
        name, type: 'absent_for_vote', agendaItem: null, timing: null,
        anchor: { kind: 'this_document', agendaItem: null, decisionNumber: null, decisionNumberTo: null, phase: null, timing: null },
        rawText: `Κατά τη διαδικασία της ψηφοφορίας απουσίαζε ο ${name}.`,
    });

    it('adds the rest of the member list and keeps the named votes (Argos 359/2025: 13 + 7 names)', () => {
        const merged = withContinuationFacts(base, continuation);
        expect(merged.decisionAttendance?.present).toEqual(ARGOS_LIST);
        expect(merged.decisionAttendance?.present).toHaveLength(20);
        expect(merged.decisionAttendance?.rawText).toBe(base.decisionAttendance!.rawText);
        expect(merged.voteDetails.filter(v => v.vote === 'AGAINST')).toHaveLength(4);
        expect(merged.voteDetails.filter(v => v.vote === 'PRESENT')).toEqual([{ name: 'Γ. Γρίβας', vote: 'PRESENT' }]);
        expect(merged.decisionNumber).toBe('359/2025');
        expect(merged.decisionExcerpt).toBe(base.decisionExcerpt);
    });

    it('adds a name only once when the continuation repeats the end of the list', () => {
        const repeats = { ...continuation, decisionAttendance: { present: ['Δ. Γάτσιου', ...ARGOS_LIST.slice(13)], rawText: '13. Δ. Γάτσιου' } };
        expect(withContinuationFacts(base, repeats).decisionAttendance?.present).toEqual(ARGOS_LIST);
    });

    it('takes the whole list from the continuation when the front read has none', () => {
        const merged = withContinuationFacts({ ...base, decisionAttendance: null }, continuation);
        expect(merged.decisionAttendance).toEqual(continuation.decisionAttendance);
    });

    it('adds named votes and changes for people the front read does not name', () => {
        const merged = withContinuationFacts({ ...base, attendanceChanges: [absence('Π. Δούρος')] }, {
            ...continuation,
            voteDetails: [{ name: 'Χ. Πετσέλης', vote: 'AGAINST' }, { name: 'Β. Καραβίδας', vote: 'ABSTAIN' }],
            attendanceChanges: [absence('Π. Δούρος'), absence('Χ. Πούλος')],
        });
        expect(merged.voteDetails).toEqual([...ARGOS_DISSENTERS, { name: 'Β. Καραβίδας', vote: 'ABSTAIN' }]);
        expect(merged.attendanceChanges).toEqual([absence('Π. Δούρος'), absence('Χ. Πούλος')]);
    });

    it('fills the number and the counts only when the front read has none', () => {
        const counted = { ...base.voteTally, FOR: 15, AGAINST: 4, PRESENT: 1 };
        const filled = withContinuationFacts({ ...base, decisionNumber: null }, { ...continuation, decisionNumber: '359/2025', voteTally: counted });
        expect(filled.decisionNumber).toBe('359/2025');
        expect(filled.voteTally).toEqual(counted);
        const own = { ...base.voteTally, FOR: 16 };
        const kept = withContinuationFacts({ ...base, voteTally: own }, { ...continuation, decisionNumber: '359', voteTally: counted });
        expect(kept.decisionNumber).toBe('359/2025');
        expect(kept.voteTally).toEqual(own);
    });

    it('rejects a continuation that prints another decision number', () => {
        expect(withContinuationFacts(base, { ...continuation, decisionNumber: '360/2025' })).toBe(base);
    });
});

describe('EXTRACTION_SCHEMA_VERSION', () => {
    it('retires the readings made before the continuation read', () => {
        expect(EXTRACTION_SCHEMA_VERSION).toBe(12);
    });
});

describe('normalizeGreekName, Latin homoglyphs', () => {
    // «Αγρoγιάννη-Μουκριώτου» is printed with a Latin o in the roll call of
    // ΡΟΨΘΩ6Μ-2Υ8 and with a Greek omicron elsewhere on the same page.
    it('folds a Latin o inside a Greek word', () => {
        expect(normalizeGreekName('Αγρoγιάννη-Μουκριώτου')).toBe(normalizeGreekName('Αγρογιάννη-Μουκριώτου'));
    });

    it('matches a person whose name a document spells with a homoglyph', () => {
        const people = [{ id: 'p1', name: 'Ζαχαρία Αγρογιάννη-Μουκριώτου' }];
        expect(matchMembersToPersonIds(['Αγρoγιάννη-Μουκριώτου Ζαχαρία'], people).matchedIds).toEqual(['p1']);
    });

    it('leaves a name with no homoglyphs alone', () => {
        expect(normalizeGreekName('Γεώργιος Βουλγαράκης')).toBe('γεωργιος βουλγαρακης');
    });
});
