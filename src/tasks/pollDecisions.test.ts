import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Decision } from '@schemalabs/diavgeia-cli';
import type { PollDecisionsRequest } from "../types.js";

// Mock diavgeia-cli
const { mockSearchAll, NO_USAGE_MOCK } = vi.hoisted(() => ({
    mockSearchAll: vi.fn(),
    NO_USAGE_MOCK: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
}));
vi.mock('@schemalabs/diavgeia-cli', () => ({
    Diavgeia: vi.fn(() => ({ searchAll: mockSearchAll })),
    msToISODate: (ms: number) => new Date(ms).toISOString().split('T')[0],
}));

// Mock aiChat + usage helpers
vi.mock("../lib/ai.js", () => ({
    aiChat: vi.fn(async () => ({ result: [], usage: NO_USAGE_MOCK })),
    NO_USAGE: NO_USAGE_MOCK,
    addUsage: (a: Record<string, number>, b: Record<string, number>) => ({
        input_tokens: a.input_tokens + b.input_tokens,
        output_tokens: a.output_tokens + b.output_tokens,
        cache_creation_input_tokens: (a.cache_creation_input_tokens || 0) + (b.cache_creation_input_tokens || 0),
        cache_read_input_tokens: (a.cache_read_input_tokens || 0) + (b.cache_read_input_tokens || 0),
    }),
}));

// Mock extractionPipeline (extraction is tested separately)
vi.mock("./utils/extractionPipeline.js", () => ({
    extractDecisionsFromPdfs: vi.fn(async () => ({ decisions: [], warnings: [], usage: NO_USAGE_MOCK })),
}));

import { aiChat } from "../lib/ai.js";
import { extractDecisionsFromPdfs } from "./utils/extractionPipeline.js";
import { pollDecisions } from "./pollDecisions.js";

const mockAiChat = vi.mocked(aiChat);
const mockExtractDecisions = vi.mocked(extractDecisionsFromPdfs);
const noopProgress = vi.fn();
const noUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null, server_tool_use: null, service_tier: null };

async function* asyncIter<T>(items: T[]): AsyncIterable<T> {
    for (const item of items) yield item;
}

function makeDecision(overrides: Partial<Decision> & { ada: string; subject: string }): Decision {
    return {
        protocolNumber: "1/2025",
        issueDate: 1736899200000,        // 2025-01-15
        publishTimestamp: 1736985600000,  // 2025-01-16
        submissionTimestamp: 1736985600000,
        decisionTypeId: "Β.2.2",
        thematicCategoryIds: [],
        organizationId: "6104",
        unitIds: [],
        signerIds: [],
        extraFieldValues: {},
        status: 'PUBLISHED',
        versionId: 'v1',
        correctedVersionId: null,
        documentUrl: `https://diavgeia.gov.gr/doc/${overrides.ada}`,
        documentChecksum: null,
        url: `https://diavgeia.gov.gr/decision/view/${overrides.ada}`,
        attachments: [],
        privateData: false,
        ...overrides,
    };
}

function makeRequest(overrides: Partial<PollDecisionsRequest> = {}): PollDecisionsRequest {
    return {
        callbackUrl: "http://localhost/api/taskStatuses/task-1",
        meetingDate: "2025-01-10",
        diavgeiaUid: "6104",
        people: [],
        subjects: [],
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockSearchAll.mockReturnValue(asyncIter([]));
    // Default: LLM returns no matches
    mockAiChat.mockResolvedValue({ result: [], usage: noUsage });
});

describe("pollDecisions - matching behavior", () => {
    it("linked subjects are excluded from matching passes", async () => {
        const D1 = makeDecision({
            ada: "ADA-D1",
            subject: "Έγκριση προϋπολογισμού 2025",
        });

        mockSearchAll.mockReturnValue(asyncIter([D1]));

        const result = await pollDecisions(
            makeRequest({
                subjects: [
                    {
                        subjectId: "subA",
                        name: "Έγκριση προϋπολογισμού 2025",
                        agendaItemIndex: 1,
                        existingDecision: { ada: "ADA-D1", decisionTitle: "Έγκριση προϋπολογισμού 2025", pdfUrl: "https://diavgeia.gov.gr/doc/ADA-D1" },
                    },
                ],
            }),
            noopProgress,
        );

        expect(result.matches).toHaveLength(0);
        expect(result.unmatchedSubjects).toHaveLength(0);
        expect(result.reassignments).toHaveLength(0);
    });

    it("matches a non-conflicting decision normally", async () => {
        const D1 = makeDecision({
            ada: "ADA-D1",
            subject: "Έγκριση προϋπολογισμού 2025",
        });
        const D2 = makeDecision({
            ada: "ADA-D2",
            subject: "Τροποποίηση κανονισμού λειτουργίας",
            protocolNumber: "2/2025",
        });

        mockSearchAll.mockReturnValue(asyncIter([D1, D2]));

        const result = await pollDecisions(
            makeRequest({
                subjects: [
                    {
                        subjectId: "subA",
                        name: "Έγκριση προϋπολογισμού 2025",
                        agendaItemIndex: 1,
                        existingDecision: { ada: "ADA-D1", decisionTitle: "Έγκριση προϋπολογισμού 2025", pdfUrl: "https://diavgeia.gov.gr/doc/ADA-D1" },
                    },
                    { subjectId: "subB", name: "Τροποποίηση κανονισμού λειτουργίας", agendaItemIndex: 2 },
                ],
            }),
            noopProgress,
        );

        const matchB = result.matches.find(m => m.subjectId === "subB");
        expect(matchB).toBeDefined();
        expect(matchB!.ada).toBe("ADA-D2");
        expect(result.reassignments).toHaveLength(0);
    });

    it("works with subjects that have no existingDecision field (backward compat)", async () => {
        const D1 = makeDecision({
            ada: "ADA-D1",
            subject: "Έγκριση προϋπολογισμού 2025",
        });

        mockSearchAll.mockReturnValue(asyncIter([D1]));

        const result = await pollDecisions(
            makeRequest({
                subjects: [
                    { subjectId: "subA", name: "Έγκριση προϋπολογισμού 2025", agendaItemIndex: 1 },
                ],
            }),
            noopProgress,
        );

        expect(result.matches).toHaveLength(1);
        expect(result.matches[0].ada).toBe("ADA-D1");
        expect(result.reassignments).toHaveLength(0);
    });
});

describe("pollDecisions - conflict resolution", () => {
    it("reassigns when unlinked subject matches a linked ADA and LLM confirms", async () => {
        // D1 is the only decision. A incorrectly holds it. B is the correct owner.
        const D1 = makeDecision({
            ada: "ADA-D1",
            subject: "Παράταση προθεσμίας του έργου ανάπλασης",
        });

        mockSearchAll.mockReturnValue(asyncIter([D1]));

        // B matches D1 in the first pass (high word coverage).
        // Conflict resolution detects the collision and calls LLM.
        mockAiChat.mockResolvedValueOnce({
            result: { winner: "A", reason: "Subject A is semantically closer to the decision" },
            usage: noUsage,
        });

        const result = await pollDecisions(
            makeRequest({
                subjects: [
                    {
                        subjectId: "subA",
                        name: "Ψήφισμα κατά της βίας",
                        agendaItemIndex: 1,
                        existingDecision: { ada: "ADA-D1", decisionTitle: "Παράταση προθεσμίας του έργου ανάπλασης", pdfUrl: "https://diavgeia.gov.gr/doc/ADA-D1" },
                    },
                    { subjectId: "subB", name: "Παράταση έργου ανάπλασης", agendaItemIndex: 2 },
                ],
            }),
            noopProgress,
        );

        // D1 reassigned from subA to subB
        expect(result.reassignments).toHaveLength(1);
        expect(result.reassignments[0]).toEqual({
            ada: "ADA-D1",
            fromSubjectId: "subA",
            toSubjectId: "subB",
            reason: "Subject A is semantically closer to the decision",
        });

        // subB in matches with D1
        const matchB = result.matches.find(m => m.subjectId === "subB");
        expect(matchB).toBeDefined();
        expect(matchB!.ada).toBe("ADA-D1");
    });

    it("keeps linked assignment when LLM says linked is correct", async () => {
        // Both A and B have similar names to D1. A is linked. B matches D1 too.
        const D1 = makeDecision({
            ada: "ADA-D1",
            subject: "Έγκριση προϋπολογισμού 2025",
        });

        mockSearchAll.mockReturnValue(asyncIter([D1]));

        // B matches D1 in first pass (exact match). Conflict resolution: linked wins.
        mockAiChat.mockResolvedValueOnce({
            result: { winner: "B", reason: "Subject B is the correct match" },
            usage: noUsage,
        });

        const result = await pollDecisions(
            makeRequest({
                subjects: [
                    {
                        subjectId: "subA",
                        name: "Έγκριση προϋπολογισμού 2025",
                        agendaItemIndex: 1,
                        existingDecision: { ada: "ADA-D1", decisionTitle: "Έγκριση προϋπολογισμού 2025", pdfUrl: "https://diavgeia.gov.gr/doc/ADA-D1" },
                    },
                    { subjectId: "subB", name: "Έγκριση τεχνικού προϋπολογισμού 2025", agendaItemIndex: 2 },
                ],
            }),
            noopProgress,
        );

        // No reassignment — linked subject keeps D1
        expect(result.reassignments).toHaveLength(0);
        // subB removed from matches and added to unmatched
        expect(result.matches.find(m => m.subjectId === "subB")).toBeUndefined();
        expect(result.unmatchedSubjects.find(u => u.subjectId === "subB")).toBeDefined();
    });

    it("skips conflict resolution when linked ADA is not in fetched decisions", async () => {
        // D1 (linked to A) was NOT fetched — outside date range. D2 is fetched.
        const D2 = makeDecision({
            ada: "ADA-D2",
            subject: "Άλλη απόφαση",
        });

        mockSearchAll.mockReturnValue(asyncIter([D2]));

        // LLM matching pass for unmatched B (D2 is available)
        mockAiChat.mockResolvedValueOnce({
            result: [{ subjectId: "subB", ada: null, confidence: "none", reasoning: "No match" }],
            usage: noUsage,
        });

        const result = await pollDecisions(
            makeRequest({
                subjects: [
                    {
                        subjectId: "subA",
                        name: "Old subject",
                        agendaItemIndex: 1,
                        existingDecision: { ada: "ADA-D1", decisionTitle: "Old decision outside range", pdfUrl: "https://diavgeia.gov.gr/doc/ADA-D1" },
                    },
                    { subjectId: "subB", name: "Unmatched subject", agendaItemIndex: 2 },
                ],
            }),
            noopProgress,
        );

        // No conflict (B didn't match ADA-D1 since it's not in fetched decisions)
        expect(mockAiChat).toHaveBeenCalledTimes(1); // Only LLM matching pass
        expect(result.reassignments).toHaveLength(0);
    });
});

describe("pollDecisions - mixed scenario", () => {
    it("handles normal matches, reassignments, and unmatched subjects together", async () => {
        const D1 = makeDecision({
            ada: "ADA-D1",
            subject: "Παράταση προθεσμίας έργου ανάπλασης",
            protocolNumber: "1/2025",
        });
        const D2 = makeDecision({
            ada: "ADA-D2",
            subject: "Τροποποίηση κανονισμού λειτουργίας",
            protocolNumber: "2/2025",
        });
        const D3 = makeDecision({
            ada: "ADA-D3",
            subject: "Ορισμός μελών επιτροπής",
            protocolNumber: "3/2025",
        });

        mockSearchAll.mockReturnValue(asyncIter([D1, D2, D3]));

        // Flow:
        // First pass: subC ("Παράταση έργου ανάπλασης") matches D1 (word coverage).
        //             subD ("Κάτι εντελώς διαφορετικό") — no match.
        // LLM pass:   subD vs available [D2, D3] — no match (1st aiChat).
        // Conflict:   subC's match D1 collides with subA's linked D1 (2nd aiChat).
        mockAiChat
            .mockResolvedValueOnce({
                // LLM matching for subD — no match
                result: [{ subjectId: "subD", ada: null, confidence: "none", reasoning: "No match" }],
                usage: noUsage,
            })
            .mockResolvedValueOnce({
                // Conflict resolution: subC vs subA for D1 — subC wins
                result: { winner: "A", reason: "Subject C better matches the decision" },
                usage: noUsage,
            });

        const result = await pollDecisions(
            makeRequest({
                subjects: [
                    // subA incorrectly holds D1
                    {
                        subjectId: "subA",
                        name: "Ψήφισμα",
                        agendaItemIndex: 1,
                        existingDecision: { ada: "ADA-D1", decisionTitle: "Παράταση προθεσμίας έργου ανάπλασης", pdfUrl: "https://diavgeia.gov.gr/doc/ADA-D1" },
                    },
                    // subB correctly holds D2
                    {
                        subjectId: "subB",
                        name: "Τροποποίηση κανονισμού λειτουργίας",
                        agendaItemIndex: 2,
                        existingDecision: { ada: "ADA-D2", decisionTitle: "Τροποποίηση κανονισμού λειτουργίας", pdfUrl: "https://diavgeia.gov.gr/doc/ADA-D2" },
                    },
                    // subC should get D1 via reassignment
                    { subjectId: "subC", name: "Παράταση έργου ανάπλασης", agendaItemIndex: 3 },
                    // subD has no match
                    { subjectId: "subD", name: "Κάτι εντελώς διαφορετικό", agendaItemIndex: 4 },
                ],
            }),
            noopProgress,
        );

        // subC matched D1, triggering reassignment from subA
        expect(result.reassignments).toHaveLength(1);
        expect(result.reassignments[0].ada).toBe("ADA-D1");
        expect(result.reassignments[0].fromSubjectId).toBe("subA");
        expect(result.reassignments[0].toSubjectId).toBe("subC");

        // subC in matches with D1
        const matchC = result.matches.find(m => m.subjectId === "subC");
        expect(matchC).toBeDefined();
        expect(matchC!.ada).toBe("ADA-D1");

        // subD unmatched
        expect(result.unmatchedSubjects.find(u => u.subjectId === "subD")).toBeDefined();

        // Linked subjects not in matches
        expect(result.matches.find(m => m.subjectId === "subA")).toBeUndefined();
        expect(result.matches.find(m => m.subjectId === "subB")).toBeUndefined();
    });
});

describe("pollDecisions - verification", () => {
    const people = [{ id: "person1", name: "Test Person" }];

    it("discards match when PDF subject number mismatches agendaItemIndex", async () => {
        const D1 = makeDecision({
            ada: "ADA-D1",
            subject: "Έγκριση προϋπολογισμού 2025",
        });

        mockSearchAll.mockReturnValue(asyncIter([D1]));

        mockExtractDecisions.mockResolvedValueOnce({
            decisions: [{
                subjectId: "subA",
                excerpt: "test",
                references: "",
                presentMemberIds: [],
                absentMemberIds: [],
                voteResult: null,
                voteDetails: [],
                unmatchedMembers: [],
                subjectInfo: { number: 5, isOutOfAgenda: false },
                warnings: [],
            }],
            warnings: [],
            usage: noUsage,
        });

        const result = await pollDecisions(
            makeRequest({
                people,
                subjects: [
                    { subjectId: "subA", name: "Έγκριση προϋπολογισμού 2025", agendaItemIndex: 3 },
                ],
            }),
            noopProgress,
        );

        // Match discarded — subject moved to unmatched
        expect(result.matches).toHaveLength(0);
        expect(result.unmatchedSubjects.find(u => u.subjectId === "subA")).toBeDefined();
        expect(result.extractions?.warnings.length).toBeGreaterThan(0);
    });

    it("re-matches to correct subject when number mismatch has a candidate", async () => {
        // D1 matches subA by title, but PDF says it's subject #5, not #3
        // subB is item #5 and currently unmatched
        const D1 = makeDecision({
            ada: "ADA-D1",
            subject: "Έγκριση προϋπολογισμού 2025",
        });

        mockSearchAll.mockReturnValue(asyncIter([D1]));
        // LLM matching for subB (no match for it)
        mockAiChat.mockResolvedValueOnce({
            result: [{ subjectId: "subB", ada: null, confidence: "none", reasoning: "No match" }],
            usage: noUsage,
        });

        mockExtractDecisions.mockResolvedValueOnce({
            decisions: [{
                subjectId: "subA",
                excerpt: "test",
                references: "",
                presentMemberIds: [],
                absentMemberIds: [],
                voteResult: null,
                voteDetails: [],
                unmatchedMembers: [],
                subjectInfo: { number: 5, isOutOfAgenda: false },
                warnings: [],
            }],
            warnings: [],
            usage: noUsage,
        });

        const result = await pollDecisions(
            makeRequest({
                people,
                subjects: [
                    { subjectId: "subA", name: "Έγκριση προϋπολογισμού 2025", agendaItemIndex: 3 },
                    { subjectId: "subB", name: "Θέμα 5ο", agendaItemIndex: 5 },
                ],
            }),
            noopProgress,
        );

        // subA match discarded, re-matched to subB
        expect(result.matches.find(m => m.subjectId === "subA")).toBeUndefined();
        const matchB = result.matches.find(m => m.subjectId === "subB");
        expect(matchB).toBeDefined();
        expect(matchB!.ada).toBe("ADA-D1");
        // subA in unmatched (removed from original match), subB no longer unmatched
        expect(result.unmatchedSubjects.find(u => u.subjectId === "subA")).toBeDefined();
        expect(result.unmatchedSubjects.find(u => u.subjectId === "subB")).toBeUndefined();
    });

    it("keeps match for outOfAgenda subject when PDF says isOutOfAgenda: true", async () => {
        const D1 = makeDecision({
            ada: "ADA-D1",
            subject: "Έκτακτο θέμα",
        });

        mockSearchAll.mockReturnValue(asyncIter([D1]));

        mockExtractDecisions.mockResolvedValueOnce({
            decisions: [{
                subjectId: "subA",
                excerpt: "test",
                references: "",
                presentMemberIds: [],
                absentMemberIds: [],
                voteResult: null,
                voteDetails: [],
                unmatchedMembers: [],
                subjectInfo: { number: 2, isOutOfAgenda: true },
                warnings: [],
            }],
            warnings: [],
            usage: noUsage,
        });

        const result = await pollDecisions(
            makeRequest({
                people,
                subjects: [
                    { subjectId: "subA", name: "Έκτακτο θέμα", agendaItemIndex: null },
                ],
            }),
            noopProgress,
        );

        // Match kept — outOfAgenda consistent
        expect(result.matches).toHaveLength(1);
        expect(result.matches[0].subjectId).toBe("subA");
        expect(result.unmatchedSubjects).toHaveLength(0);
    });

    it("discards outOfAgenda match when PDF says regular item", async () => {
        const D1 = makeDecision({
            ada: "ADA-D1",
            subject: "Έκτακτο θέμα",
        });

        mockSearchAll.mockReturnValue(asyncIter([D1]));

        mockExtractDecisions.mockResolvedValueOnce({
            decisions: [{
                subjectId: "subA",
                excerpt: "test",
                references: "",
                presentMemberIds: [],
                absentMemberIds: [],
                voteResult: null,
                voteDetails: [],
                unmatchedMembers: [],
                subjectInfo: { number: 3, isOutOfAgenda: false },
                warnings: [],
            }],
            warnings: [],
            usage: noUsage,
        });

        const result = await pollDecisions(
            makeRequest({
                people,
                subjects: [
                    { subjectId: "subA", name: "Έκτακτο θέμα", agendaItemIndex: null },
                ],
            }),
            noopProgress,
        );

        // Match discarded — PDF says regular item but subject is outOfAgenda
        expect(result.matches).toHaveLength(0);
        expect(result.unmatchedSubjects.find(u => u.subjectId === "subA")).toBeDefined();
    });

    it("discards regular match when PDF says out-of-agenda", async () => {
        const D1 = makeDecision({
            ada: "ADA-D1",
            subject: "Θέμα 3ο",
        });

        mockSearchAll.mockReturnValue(asyncIter([D1]));

        mockExtractDecisions.mockResolvedValueOnce({
            decisions: [{
                subjectId: "subA",
                excerpt: "test",
                references: "",
                presentMemberIds: [],
                absentMemberIds: [],
                voteResult: null,
                voteDetails: [],
                unmatchedMembers: [],
                subjectInfo: { number: 1, isOutOfAgenda: true },
                warnings: [],
            }],
            warnings: [],
            usage: noUsage,
        });

        const result = await pollDecisions(
            makeRequest({
                people,
                subjects: [
                    { subjectId: "subA", name: "Θέμα 3ο", agendaItemIndex: 3 },
                ],
            }),
            noopProgress,
        );

        // Match discarded — regular subject but PDF says out-of-agenda
        expect(result.matches).toHaveLength(0);
        expect(result.unmatchedSubjects.find(u => u.subjectId === "subA")).toBeDefined();
    });

    it("re-matches cascading mismatches when similar titles cause shifted assignments", async () => {
        // Three similar-titled decisions: title matching pairs each to the wrong subject
        // sub6 (#6) → PDF-for-#7, sub7 (#7) → PDF-for-#8, sub8 (#8) → PDF-for-#9
        // With single-pass, sub7 can't be reassigned because it's still "matched".
        // Two-pass frees all three simultaneously, allowing correct reassignment.
        const D1 = makeDecision({ ada: "ADA-D1", subject: "Διαγραφή οφειλών ΤΑΠ Α" });
        const D2 = makeDecision({ ada: "ADA-D2", subject: "Διαγραφή οφειλών ΤΑΠ Β" });
        const D3 = makeDecision({ ada: "ADA-D3", subject: "Διαγραφή οφειλών ΤΑΠ Γ" });

        mockSearchAll.mockReturnValue(asyncIter([D1, D2, D3]));

        mockExtractDecisions.mockResolvedValueOnce({
            decisions: [
                {
                    subjectId: "sub6", excerpt: "", references: "",
                    presentMemberIds: [], absentMemberIds: [],
                    voteResult: null, voteDetails: [], unmatchedMembers: [],
                    subjectInfo: { number: 7, isOutOfAgenda: false }, warnings: [],
                },
                {
                    subjectId: "sub7", excerpt: "", references: "",
                    presentMemberIds: [], absentMemberIds: [],
                    voteResult: null, voteDetails: [], unmatchedMembers: [],
                    subjectInfo: { number: 8, isOutOfAgenda: false }, warnings: [],
                },
                {
                    subjectId: "sub8", excerpt: "", references: "",
                    presentMemberIds: [], absentMemberIds: [],
                    voteResult: null, voteDetails: [], unmatchedMembers: [],
                    subjectInfo: { number: 9, isOutOfAgenda: false }, warnings: [],
                },
            ],
            warnings: [],
            usage: noUsage,
        });

        const result = await pollDecisions(
            makeRequest({
                people,
                subjects: [
                    { subjectId: "sub6", name: "Διαγραφή οφειλών ΤΑΠ Α", agendaItemIndex: 6 },
                    { subjectId: "sub7", name: "Διαγραφή οφειλών ΤΑΠ Β", agendaItemIndex: 7 },
                    { subjectId: "sub8", name: "Διαγραφή οφειλών ΤΑΠ Γ", agendaItemIndex: 8 },
                ],
            }),
            noopProgress,
        );

        // sub6's PDF says #7 → reassigned to sub7
        // sub7's PDF says #8 → reassigned to sub8
        // sub8's PDF says #9 → no subject #9, but sub8 was already filled above
        const matchedIds = result.matches.map(m => m.subjectId);
        expect(matchedIds).toContain("sub7");
        expect(matchedIds).toContain("sub8");
        expect(matchedIds).not.toContain("sub6");

        // Only sub6 stays unmatched — nothing points to #6
        const unmatchedIds = result.unmatchedSubjects.map(u => u.subjectId);
        expect(unmatchedIds).toEqual(["sub6"]);
    });
});
