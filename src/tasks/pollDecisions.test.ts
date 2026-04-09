import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Decision } from '@schemalabs/diavgeia-cli';
import type { PollDecisionsRequest } from "../types.js";

// Mock diavgeia-cli
const { mockSearchAll } = vi.hoisted(() => ({
    mockSearchAll: vi.fn(),
}));
vi.mock('@schemalabs/diavgeia-cli', () => ({
    Diavgeia: vi.fn(() => ({ searchAll: mockSearchAll })),
    msToISODate: (ms: number) => new Date(ms).toISOString().split('T')[0],
}));

// Mock aiChat
vi.mock("../lib/ai.js", () => ({
    aiChat: vi.fn(async () => ({ result: [], usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null, server_tool_use: null, service_tier: null } })),
}));

import { aiChat } from "../lib/ai.js";
import { pollDecisions } from "./pollDecisions.js";

const mockAiChat = vi.mocked(aiChat);
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
                        existingDecision: { ada: "ADA-D1", decisionTitle: "Έγκριση προϋπολογισμού 2025" },
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
                        existingDecision: { ada: "ADA-D1", decisionTitle: "Έγκριση προϋπολογισμού 2025" },
                    },
                    { subjectId: "subB", name: "Τροποποίηση κανονισμού λειτουργίας" },
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
                    { subjectId: "subA", name: "Έγκριση προϋπολογισμού 2025" },
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
                        existingDecision: { ada: "ADA-D1", decisionTitle: "Παράταση προθεσμίας του έργου ανάπλασης" },
                    },
                    { subjectId: "subB", name: "Παράταση έργου ανάπλασης" },
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
                        existingDecision: { ada: "ADA-D1", decisionTitle: "Έγκριση προϋπολογισμού 2025" },
                    },
                    { subjectId: "subB", name: "Έγκριση τεχνικού προϋπολογισμού 2025" },
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
                        existingDecision: { ada: "ADA-D1", decisionTitle: "Old decision outside range" },
                    },
                    { subjectId: "subB", name: "Unmatched subject" },
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
                        existingDecision: { ada: "ADA-D1", decisionTitle: "Παράταση προθεσμίας έργου ανάπλασης" },
                    },
                    // subB correctly holds D2
                    {
                        subjectId: "subB",
                        name: "Τροποποίηση κανονισμού λειτουργίας",
                        existingDecision: { ada: "ADA-D2", decisionTitle: "Τροποποίηση κανονισμού λειτουργίας" },
                    },
                    // subC should get D1 via reassignment
                    { subjectId: "subC", name: "Παράταση έργου ανάπλασης" },
                    // subD has no match
                    { subjectId: "subD", name: "Κάτι εντελώς διαφορετικό" },
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
