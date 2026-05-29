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
    aiChat: vi.fn(async () => ({ result: { matches: [], reassignments: [], unmatched: [] }, usage: NO_USAGE_MOCK })),
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
    extractDecisionsFromPdfs: vi.fn(async () => ({
        decisions: [], warnings: [], usage: NO_USAGE_MOCK,
        initialAttendance: [], unmatchedInitialAttendance: [],
        nonDecisionSubjectAttendance: [], allSubjectAttendance: [],
    })),
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
    // Default: resolver returns empty results
    mockAiChat.mockResolvedValue({ result: { matches: [], reassignments: [], unmatched: [] }, usage: noUsage });
});

describe("pollDecisions - resolver matching", () => {
    it("linked subjects are excluded from matching, resolver not called", async () => {
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
        expect(mockAiChat).not.toHaveBeenCalled();
    });

    it("resolver matches unlinked subjects to decisions", async () => {
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

        // Resolver returns a match for the unlinked subject
        mockAiChat.mockResolvedValueOnce({
            result: {
                matches: [{ subjectId: "subB", ada: "ADA-D2", confidence: "high", reasoning: "Title matches" }],
                reassignments: [],
                unmatched: [],
            },
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
                    { subjectId: "subB", name: "Τροποποίηση κανονισμού λειτουργίας", agendaItemIndex: 2 },
                ],
            }),
            noopProgress,
        );

        const matchB = result.matches.find(m => m.subjectId === "subB");
        expect(matchB).toBeDefined();
        expect(matchB!.ada).toBe("ADA-D2");
        expect(result.reassignments).toHaveLength(0);
        expect(result.unmatchedSubjects).toHaveLength(0);
    });

    it("resolver leaves subjects unmatched with reasoning", async () => {
        const D1 = makeDecision({
            ada: "ADA-D1",
            subject: "Έγκριση προϋπολογισμού 2025",
        });

        mockSearchAll.mockReturnValue(asyncIter([D1]));

        mockAiChat.mockResolvedValueOnce({
            result: {
                matches: [],
                reassignments: [],
                unmatched: [{ subjectId: "subA", reasoning: "No decision matches this subject" }],
            },
            usage: noUsage,
        });

        const result = await pollDecisions(
            makeRequest({
                subjects: [
                    { subjectId: "subA", name: "Κάτι εντελώς διαφορετικό", agendaItemIndex: 1 },
                ],
            }),
            noopProgress,
        );

        expect(result.matches).toHaveLength(0);
        expect(result.unmatchedSubjects).toHaveLength(1);
        expect(result.unmatchedSubjects[0].subjectId).toBe("subA");
        expect(result.unmatchedSubjects[0].reason).toBe("No decision matches this subject");
    });

    it("subjects not mentioned by resolver are added to unmatched", async () => {
        const D1 = makeDecision({
            ada: "ADA-D1",
            subject: "Έγκριση προϋπολογισμού 2025",
        });

        mockSearchAll.mockReturnValue(asyncIter([D1]));

        // Resolver doesn't mention subA at all (not in matches nor unmatched)
        mockAiChat.mockResolvedValueOnce({
            result: {
                matches: [],
                reassignments: [],
                unmatched: [],
            },
            usage: noUsage,
        });

        const result = await pollDecisions(
            makeRequest({
                subjects: [
                    { subjectId: "subA", name: "Κάτι εντελώς διαφορετικό", agendaItemIndex: 1 },
                ],
            }),
            noopProgress,
        );

        expect(result.matches).toHaveLength(0);
        expect(result.unmatchedSubjects).toHaveLength(1);
        expect(result.unmatchedSubjects[0].subjectId).toBe("subA");
        expect(result.unmatchedSubjects[0].reason).toBe("Not mentioned in resolver output");
    });
});

describe("pollDecisions - resolver reassignments", () => {
    it("resolver can reassign a linked decision to a different subject", async () => {
        const D1 = makeDecision({
            ada: "ADA-D1",
            subject: "Παράταση προθεσμίας του έργου ανάπλασης",
        });

        mockSearchAll.mockReturnValue(asyncIter([D1]));

        mockAiChat.mockResolvedValueOnce({
            result: {
                matches: [{ subjectId: "subB", ada: "ADA-D1", confidence: "high", reasoning: "Title matches" }],
                reassignments: [{ ada: "ADA-D1", fromSubjectId: "subA", toSubjectId: "subB", reasoning: "Subject B is the correct match for this decision" }],
                unmatched: [],
            },
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

        expect(result.reassignments).toHaveLength(1);
        expect(result.reassignments[0]).toEqual({
            ada: "ADA-D1",
            fromSubjectId: "subA",
            toSubjectId: "subB",
            reason: "Subject B is the correct match for this decision",
        });

        const matchB = result.matches.find(m => m.subjectId === "subB");
        expect(matchB).toBeDefined();
        expect(matchB!.ada).toBe("ADA-D1");
    });

    it("reassignment reason comes from resolver reasoning", async () => {
        const D1 = makeDecision({
            ada: "ADA-D1",
            subject: "Παράταση προθεσμίας του έργου ανάπλασης",
        });

        mockSearchAll.mockReturnValue(asyncIter([D1]));

        const expectedReason = "Subject A is unrelated; subject B matches the extension project";
        mockAiChat.mockResolvedValueOnce({
            result: {
                matches: [{ subjectId: "subB", ada: "ADA-D1", confidence: "medium", reasoning: "Partial match" }],
                reassignments: [{ ada: "ADA-D1", fromSubjectId: "subA", toSubjectId: "subB", reasoning: expectedReason }],
                unmatched: [],
            },
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

        expect(result.reassignments).toHaveLength(1);
        expect(result.reassignments[0].reason).toBe(expectedReason);
    });
});

describe("pollDecisions - resolver edge cases", () => {
    it("works with no unlinked subjects (resolver skipped)", async () => {
        const D1 = makeDecision({
            ada: "ADA-D1",
            subject: "Έγκριση προϋπολογισμού 2025",
        });
        const D2 = makeDecision({
            ada: "ADA-D2",
            subject: "Τροποποίηση κανονισμού",
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
                    {
                        subjectId: "subB",
                        name: "Τροποποίηση κανονισμού",
                        agendaItemIndex: 2,
                        existingDecision: { ada: "ADA-D2", decisionTitle: "Τροποποίηση κανονισμού", pdfUrl: "https://diavgeia.gov.gr/doc/ADA-D2" },
                    },
                ],
            }),
            noopProgress,
        );

        expect(result.matches).toHaveLength(0);
        expect(result.unmatchedSubjects).toHaveLength(0);
        expect(result.reassignments).toHaveLength(0);
        expect(mockAiChat).not.toHaveBeenCalled();
    });

    it("works with no decisions fetched", async () => {
        mockSearchAll.mockReturnValue(asyncIter([]));

        // Resolver called but no candidates, returns all unmatched
        mockAiChat.mockResolvedValueOnce({
            result: {
                matches: [],
                reassignments: [],
                unmatched: [{ subjectId: "subA", reasoning: "No decisions available" }],
            },
            usage: noUsage,
        });

        const result = await pollDecisions(
            makeRequest({
                subjects: [
                    { subjectId: "subA", name: "Έγκριση προϋπολογισμού 2025", agendaItemIndex: 1 },
                ],
            }),
            noopProgress,
        );

        expect(mockAiChat).toHaveBeenCalledTimes(1);
        expect(result.matches).toHaveLength(0);
        expect(result.unmatchedSubjects).toHaveLength(1);
        expect(result.unmatchedSubjects[0].subjectId).toBe("subA");
    });
});

describe("pollDecisions - subjectInfo warnings", () => {
    const people = [{ id: "person1", name: "Test Person" }];

    it("emits warning but preserves match when PDF subject number mismatches agendaItemIndex", async () => {
        const D1 = makeDecision({
            ada: "ADA-D1",
            subject: "Έγκριση προϋπολογισμού 2025",
        });

        mockSearchAll.mockReturnValue(asyncIter([D1]));

        mockAiChat.mockResolvedValueOnce({
            result: {
                matches: [{ subjectId: "subA", ada: "ADA-D1", confidence: "high", reasoning: "Title matches" }],
                reassignments: [],
                unmatched: [],
            },
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
            initialAttendance: [],
            unmatchedInitialAttendance: [],
            nonDecisionSubjectAttendance: [],
            allSubjectAttendance: [],
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

        // Match preserved — mismatch emitted as warning only
        expect(result.matches).toHaveLength(1);
        expect(result.matches[0].subjectId).toBe("subA");
        expect(result.unmatchedSubjects).toHaveLength(0);
        expect(result.extractions?.warnings.length).toBeGreaterThan(0);
        expect(result.extractions?.warnings[0]).toContain("subjectInfo mismatch");
    });

    it("emits warning but preserves match for number mismatch (no cascade)", async () => {
        // D1 matches subA by title, but PDF says it's subject #5, not #3.
        // Previously this would cascade into re-matching; now it stays with subA.
        const D1 = makeDecision({
            ada: "ADA-D1",
            subject: "Έγκριση προϋπολογισμού 2025",
        });

        mockSearchAll.mockReturnValue(asyncIter([D1]));

        mockAiChat.mockResolvedValueOnce({
            result: {
                matches: [{ subjectId: "subA", ada: "ADA-D1", confidence: "high", reasoning: "Title matches" }],
                reassignments: [],
                unmatched: [{ subjectId: "subB", reasoning: "No matching decision" }],
            },
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
            initialAttendance: [],
            unmatchedInitialAttendance: [],
            nonDecisionSubjectAttendance: [],
            allSubjectAttendance: [],
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

        // subA match preserved — no cascade re-matching
        expect(result.matches.find(m => m.subjectId === "subA")).toBeDefined();
        expect(result.extractions?.warnings.some(w => w.includes("subjectInfo mismatch"))).toBe(true);
    });

    it("keeps match for outOfAgenda subject when PDF says isOutOfAgenda: true (no warning)", async () => {
        const D1 = makeDecision({
            ada: "ADA-D1",
            subject: "Έκτακτο θέμα",
        });

        mockSearchAll.mockReturnValue(asyncIter([D1]));

        mockAiChat.mockResolvedValueOnce({
            result: {
                matches: [{ subjectId: "subA", ada: "ADA-D1", confidence: "high", reasoning: "Title matches" }],
                reassignments: [],
                unmatched: [],
            },
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
                subjectInfo: { number: 2, isOutOfAgenda: true },
                warnings: [],
            }],
            warnings: [],
            usage: noUsage,
            initialAttendance: [],
            unmatchedInitialAttendance: [],
            nonDecisionSubjectAttendance: [],
            allSubjectAttendance: [],
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

        // Match kept — outOfAgenda consistent, no warning
        expect(result.matches).toHaveLength(1);
        expect(result.matches[0].subjectId).toBe("subA");
        expect(result.unmatchedSubjects).toHaveLength(0);
        expect(result.extractions?.warnings).toHaveLength(0);
    });

    it("emits warning but preserves match when outOfAgenda subject PDF says regular item", async () => {
        const D1 = makeDecision({
            ada: "ADA-D1",
            subject: "Έκτακτο θέμα",
        });

        mockSearchAll.mockReturnValue(asyncIter([D1]));

        mockAiChat.mockResolvedValueOnce({
            result: {
                matches: [{ subjectId: "subA", ada: "ADA-D1", confidence: "high", reasoning: "Title matches" }],
                reassignments: [],
                unmatched: [],
            },
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
                subjectInfo: { number: 3, isOutOfAgenda: false },
                warnings: [],
            }],
            warnings: [],
            usage: noUsage,
            initialAttendance: [],
            unmatchedInitialAttendance: [],
            nonDecisionSubjectAttendance: [],
            allSubjectAttendance: [],
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

        // Match preserved — warning emitted instead of discard
        expect(result.matches).toHaveLength(1);
        expect(result.matches[0].subjectId).toBe("subA");
        expect(result.unmatchedSubjects).toHaveLength(0);
        expect(result.extractions?.warnings.some(w => w.includes("subjectInfo mismatch"))).toBe(true);
    });

    it("emits warning but preserves match when regular subject PDF says out-of-agenda", async () => {
        const D1 = makeDecision({
            ada: "ADA-D1",
            subject: "Θέμα 3ο",
        });

        mockSearchAll.mockReturnValue(asyncIter([D1]));

        mockAiChat.mockResolvedValueOnce({
            result: {
                matches: [{ subjectId: "subA", ada: "ADA-D1", confidence: "high", reasoning: "Title matches" }],
                reassignments: [],
                unmatched: [],
            },
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
                subjectInfo: { number: 1, isOutOfAgenda: true },
                warnings: [],
            }],
            warnings: [],
            usage: noUsage,
            initialAttendance: [],
            unmatchedInitialAttendance: [],
            nonDecisionSubjectAttendance: [],
            allSubjectAttendance: [],
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

        // Match preserved — warning emitted instead of discard
        expect(result.matches).toHaveLength(1);
        expect(result.matches[0].subjectId).toBe("subA");
        expect(result.unmatchedSubjects).toHaveLength(0);
        expect(result.extractions?.warnings.some(w => w.includes("subjectInfo mismatch"))).toBe(true);
    });

    it("emits per-subject warnings for cascading mismatches without re-matching", async () => {
        // Previously, similar titles caused cascading re-assignments.
        // Now, all matches are preserved and each mismatch emits an independent warning.
        const D1 = makeDecision({ ada: "ADA-D1", subject: "Διαγραφή οφειλών ΤΑΠ Α" });
        const D2 = makeDecision({ ada: "ADA-D2", subject: "Διαγραφή οφειλών ΤΑΠ Β" });
        const D3 = makeDecision({ ada: "ADA-D3", subject: "Διαγραφή οφειλών ΤΑΠ Γ" });

        mockSearchAll.mockReturnValue(asyncIter([D1, D2, D3]));

        mockAiChat.mockResolvedValueOnce({
            result: {
                matches: [
                    { subjectId: "sub6", ada: "ADA-D1", confidence: "high", reasoning: "Title matches" },
                    { subjectId: "sub7", ada: "ADA-D2", confidence: "high", reasoning: "Title matches" },
                    { subjectId: "sub8", ada: "ADA-D3", confidence: "high", reasoning: "Title matches" },
                ],
                reassignments: [],
                unmatched: [],
            },
            usage: noUsage,
        });

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
            initialAttendance: [],
            unmatchedInitialAttendance: [],
            nonDecisionSubjectAttendance: [],
            allSubjectAttendance: [],
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

        // All matches preserved — no cascade re-matching
        const matchedIds = result.matches.map(m => m.subjectId);
        expect(matchedIds).toContain("sub6");
        expect(matchedIds).toContain("sub7");
        expect(matchedIds).toContain("sub8");
        expect(result.unmatchedSubjects).toHaveLength(0);

        // Three warnings emitted — one per mismatch
        expect(result.extractions?.warnings.filter(w => w.includes("subjectInfo mismatch"))).toHaveLength(3);
    });
});
