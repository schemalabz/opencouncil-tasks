import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAiChat, NO_USAGE_MOCK } = vi.hoisted(() => ({
    mockAiChat: vi.fn(),
    NO_USAGE_MOCK: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
}));
vi.mock("../../lib/ai.js", () => ({
    aiChat: mockAiChat,
    NO_USAGE: NO_USAGE_MOCK,
}));

import {
    extractDecisionFromPdf,
    normalizeGreekName,
    tokenSortKey,
    tokenSortKeys,
    matchMembersToPersonIds,
    matchPersonByName,
    matchAllMembers,
    llmMatchMembers,
    inferForVotes,
} from "./decisionPdfExtraction.js";

const noUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

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

describe('llmMatchMembers', () => {
    beforeEach(() => {
        mockAiChat.mockReset();
    });

    it('returns LLM-matched names with personIds and usage', async () => {
        mockAiChat.mockResolvedValueOnce({
            result: JSON.stringify([
                { name: 'ΣΤΡΑΚΑΝΤΟΥΝΑ ΣΦΑΚΑΚΗ ΒΑΣΙΛΙΚΗ', personId: 'p1' },
                { name: 'ΑΓΝΩΣΤΟΣ', personId: null },
            ]),
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

    it('prevents duplicate personId matches', async () => {
        mockAiChat.mockResolvedValueOnce({
            result: JSON.stringify([
                { name: 'NAME1', personId: 'p1' },
                { name: 'NAME2', personId: 'p1' }, // duplicate
            ]),
            usage: noUsage,
        });

        const result = await llmMatchMembers(
            ['NAME1', 'NAME2'],
            [{ id: 'p1', name: 'Person 1' }],
        );

        expect(result.matched).toEqual([{ name: 'NAME1', personId: 'p1' }]);
        expect(result.stillUnmatched).toEqual(['NAME2']);
    });

    it('handles trailing text after JSON array', async () => {
        mockAiChat.mockResolvedValueOnce({
            result: '[{"name": "TEST", "personId": "p1"}]\n\nThe matching was done.',
            usage: noUsage,
        });

        const result = await llmMatchMembers(
            ['TEST'],
            [{ id: 'p1', name: 'Test Person' }],
        );

        expect(result.matched).toEqual([{ name: 'TEST', personId: 'p1' }]);
        expect(result.stillUnmatched).toEqual([]);
    });
});

// --- matchAllMembers tests (two-step) ---

describe('matchAllMembers', () => {
    beforeEach(() => {
        mockAiChat.mockReset();
    });

    it('matches all via token-sort without calling LLM', async () => {
        const result = await matchAllMembers(
            ['ΜΠΑΡΜΠΕΡΗΣ ΕΥΘΥΜΙΟΣ'],
            [{ id: 'p1', name: 'Ευθύμιος Μπαρμπέρης' }],
        );
        expect(result.matchedIds).toEqual(['p1']);
        expect(result.unmatched).toEqual([]);
        expect(mockAiChat).not.toHaveBeenCalled();
    });

    it('falls back to LLM for token-sort misses', async () => {
        // "ΓΙΑΝΝΗΣ" is a nickname for "Ιωάννης" — token-sort can't match this
        mockAiChat.mockResolvedValueOnce({
            result: JSON.stringify([
                { name: 'ΠΑΠΑΔΟΠΟΥΛΟΣ ΓΙΑΝΝΗΣ', personId: 'p2' },
            ]),
            usage: noUsage,
        });

        const result = await matchAllMembers(
            ['ΜΠΑΡΜΠΕΡΗΣ ΕΥΘΥΜΙΟΣ', 'ΠΑΠΑΔΟΠΟΥΛΟΣ ΓΙΑΝΝΗΣ'],
            [
                { id: 'p1', name: 'Ευθύμιος Μπαρμπέρης' },
                { id: 'p2', name: 'Ιωάννης Παπαδόπουλος' },
            ],
        );

        // p1 matched by token-sort, p2 matched by LLM
        expect(result.matchedIds).toEqual(['p1', 'p2']);
        expect(result.unmatched).toEqual([]);
        // LLM only received the unmatched name, not p1
        expect(mockAiChat).toHaveBeenCalledOnce();
    });

    it('reports truly unmatched names after both steps', async () => {
        mockAiChat.mockResolvedValueOnce({
            result: JSON.stringify([
                { name: 'ΑΓΝΩΣΤΟΣ ΑΝΘΡΩΠΟΣ', personId: null },
            ]),
            usage: noUsage,
        });

        const result = await matchAllMembers(
            ['ΜΠΑΡΜΠΕΡΗΣ ΕΥΘΥΜΙΟΣ', 'ΑΓΝΩΣΤΟΣ ΑΝΘΡΩΠΟΣ'],
            [{ id: 'p1', name: 'Ευθύμιος Μπαρμπέρης' }],
        );

        expect(result.matchedIds).toEqual(['p1']);
        expect(result.unmatched).toEqual(['ΑΓΝΩΣΤΟΣ ΑΝΘΡΩΠΟΣ']);
    });
});

// --- inferForVotes tests ---

describe('inferForVotes', () => {
    it('infers FOR votes from present members when majority with no explicit FOR', () => {
        const result = inferForVotes(
            ['Alice', 'Bob', 'Charlie'],
            'Κατά πλειοψηφία',
            [{ name: 'Charlie', vote: 'AGAINST' }],
        );
        expect(result.inferredCount).toBe(2);
        expect(result.voteDetails).toEqual([
            { name: 'Charlie', vote: 'AGAINST' },
            { name: 'Alice', vote: 'FOR' },
            { name: 'Bob', vote: 'FOR' },
        ]);
    });

    it('does not infer when explicit FOR votes exist', () => {
        const result = inferForVotes(
            ['Alice', 'Bob'],
            'Κατά πλειοψηφία',
            [{ name: 'Alice', vote: 'FOR' }],
        );
        expect(result.inferredCount).toBe(0);
        expect(result.voteDetails).toEqual([{ name: 'Alice', vote: 'FOR' }]);
    });

    it('does not infer for unanimous decisions', () => {
        const result = inferForVotes(
            ['Alice', 'Bob'],
            'Ομόφωνα',
            [],
        );
        expect(result.inferredCount).toBe(0);
        expect(result.voteDetails).toEqual([]);
    });

    it('does not infer with empty present members', () => {
        const result = inferForVotes(
            [],
            'Κατά πλειοψηφία',
            [{ name: 'Charlie', vote: 'AGAINST' }],
        );
        expect(result.inferredCount).toBe(0);
    });

    it('returns a new array without mutating the input', () => {
        const originalDetails = [{ name: 'Charlie', vote: 'AGAINST' as const }];
        const result = inferForVotes(
            ['Alice', 'Bob', 'Charlie'],
            'Κατά πλειοψηφία',
            originalDetails,
        );
        // Original array not modified
        expect(originalDetails).toHaveLength(1);
        // Result has more entries
        expect(result.voteDetails).toHaveLength(3);
    });

    it('handles null voteResult', () => {
        const result = inferForVotes(['Alice'], null, []);
        expect(result.inferredCount).toBe(0);
    });
});

// --- extractDecisionFromPdf tests ---

describe('extractDecisionFromPdf', () => {
    beforeEach(() => {
        mockAiChat.mockReset();
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

        expect(result).toEqual(mockResult);
        expect(usage).toEqual({ input_tokens: 100, output_tokens: 50 });
        expect(mockAiChat).toHaveBeenCalledOnce();
        expect(fetchSpy).toHaveBeenCalledWith('https://example.com/test-unique-extraction-url.pdf');

        fetchSpy.mockRestore();
    });

    it('calls aiChat with correct parameters', async () => {
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
            },
            usage: { input_tokens: 100, output_tokens: 50 },
        });

        await extractDecisionFromPdf('https://example.com/test-ai-params-url.pdf');

        expect(mockAiChat).toHaveBeenCalledWith(expect.objectContaining({
            model: 'sonnet',
            prefillSystemResponse: '{',
            prependToResponse: '{',
        }));
        expect(mockAiChat.mock.calls[0][0].documentBase64).toBeDefined();
        expect(mockAiChat.mock.calls[0][0].systemPrompt).toContain('ΠΑΡΟΝΤΕΣ');

        fetchSpy.mockRestore();
    });
});
