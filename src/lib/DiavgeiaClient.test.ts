import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DiavgeiaClient, DiavgeiaDecision } from './DiavgeiaClient.js';

// Minimal valid API response factory
function makeApiDecision(overrides: Record<string, unknown> = {}) {
    return {
        ada: 'ΨΘ82ΩΡΦ-7ΑΙ',
        subject: 'ΕΓΚΡΙΣΗ ΠΡΟΫΠΟΛΟΓΙΣΜΟΥ',
        protocolNumber: '258/2024',
        issueDate: 1734566400000,        // 2024-12-19T00:00:00Z
        publishTimestamp: 1734652800000,  // 2024-12-20T00:00:00Z
        organizationId: '6104',
        unitIds: ['81689'],
        decisionTypeId: 'Β.1.1',
        thematicCategoryIds: ['16'],
        documentUrl: 'https://diavgeia.gov.gr/doc/ΨΘ82ΩΡΦ-7ΑΙ',
        url: 'https://diavgeia.gov.gr/luminapi/api/decisions/ΨΘ82ΩΡΦ-7ΑΙ',
        status: 'PUBLISHED',
        ...overrides,
    };
}

function makeApiResponse(decisions: Record<string, unknown>[] = [makeApiDecision()], total?: number) {
    return {
        info: {
            total: total ?? decisions.length,
            page: 0,
            size: 100,
            actualSize: decisions.length,
        },
        decisions,
    };
}

describe('DiavgeiaClient', () => {
    let client: DiavgeiaClient;
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        client = new DiavgeiaClient();
        fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('searchDecisions', () => {
        it('uses the correct base URL', async () => {
            fetchSpy.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(makeApiResponse([])),
            });

            await client.searchDecisions({
                organizationUid: '6104',
                fromDate: '2024-12-01',
                toDate: '2024-12-31',
            });

            const url = fetchSpy.mock.calls[0][0] as string;
            expect(url).toMatch(/^https:\/\/diavgeia\.gov\.gr\/luminapi\/opendata\/search\?/);
        });

        it('passes required query parameters', async () => {
            fetchSpy.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(makeApiResponse([])),
            });

            await client.searchDecisions({
                organizationUid: '6104',
                fromDate: '2024-12-01',
                toDate: '2024-12-31',
            });

            const url = new URL(fetchSpy.mock.calls[0][0] as string);
            expect(url.searchParams.get('org')).toBe('6104');
            expect(url.searchParams.get('from_issue_date')).toBe('2024-12-01');
            expect(url.searchParams.get('to_issue_date')).toBe('2024-12-31');
            expect(url.searchParams.get('status')).toBe('PUBLISHED');
            expect(url.searchParams.get('page')).toBe('0');
            expect(url.searchParams.get('size')).toBe('100');
        });

        it('includes optional unit and type filters when provided', async () => {
            fetchSpy.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(makeApiResponse([])),
            });

            await client.searchDecisions({
                organizationUid: '6104',
                fromDate: '2024-12-01',
                toDate: '2024-12-31',
                unitId: '81689',
                decisionTypeId: 'Β.1.1',
            });

            const url = new URL(fetchSpy.mock.calls[0][0] as string);
            expect(url.searchParams.get('unit')).toBe('81689');
            expect(url.searchParams.get('type')).toBe('Β.1.1');
        });

        it('omits optional filters when not provided', async () => {
            fetchSpy.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(makeApiResponse([])),
            });

            await client.searchDecisions({
                organizationUid: '6104',
                fromDate: '2024-12-01',
                toDate: '2024-12-31',
            });

            const url = new URL(fetchSpy.mock.calls[0][0] as string);
            expect(url.searchParams.has('unit')).toBe(false);
            expect(url.searchParams.has('type')).toBe(false);
        });

        it('normalizes issueDate from milliseconds to ISO date string', async () => {
            fetchSpy.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(makeApiResponse([
                    makeApiDecision({ issueDate: 1734566400000 }), // 2024-12-19T00:00:00Z
                ])),
            });

            const result = await client.searchDecisions({
                organizationUid: '6104',
                fromDate: '2024-12-01',
                toDate: '2024-12-31',
            });

            expect(result.decisions[0].issueDate).toBe('2024-12-19');
        });

        it('normalizes publishTimestamp to publishDate ISO string', async () => {
            fetchSpy.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(makeApiResponse([
                    makeApiDecision({ publishTimestamp: 1734652800000 }), // 2024-12-20T00:00:00Z
                ])),
            });

            const result = await client.searchDecisions({
                organizationUid: '6104',
                fromDate: '2024-12-01',
                toDate: '2024-12-31',
            });

            expect(result.decisions[0].publishDate).toBe('2024-12-20');
        });

        it('includes unitIds in normalized decision', async () => {
            fetchSpy.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(makeApiResponse([
                    makeApiDecision({ unitIds: ['81689', '100084744'] }),
                ])),
            });

            const result = await client.searchDecisions({
                organizationUid: '6104',
                fromDate: '2024-12-01',
                toDate: '2024-12-31',
            });

            expect(result.decisions[0].unitIds).toEqual(['81689', '100084744']);
        });

        it('defaults unitIds to empty array when missing', async () => {
            fetchSpy.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(makeApiResponse([
                    makeApiDecision({ unitIds: undefined }),
                ])),
            });

            const result = await client.searchDecisions({
                organizationUid: '6104',
                fromDate: '2024-12-01',
                toDate: '2024-12-31',
            });

            expect(result.decisions[0].unitIds).toEqual([]);
        });

        it('defaults thematicCategoryIds to empty array when missing', async () => {
            fetchSpy.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(makeApiResponse([
                    makeApiDecision({ thematicCategoryIds: undefined }),
                ])),
            });

            const result = await client.searchDecisions({
                organizationUid: '6104',
                fromDate: '2024-12-01',
                toDate: '2024-12-31',
            });

            expect(result.decisions[0].thematicCategoryIds).toEqual([]);
        });

        it('maps all fields from API response to normalized format', async () => {
            fetchSpy.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(makeApiResponse([makeApiDecision()])),
            });

            const result = await client.searchDecisions({
                organizationUid: '6104',
                fromDate: '2024-12-01',
                toDate: '2024-12-31',
            });

            const d = result.decisions[0];
            expect(d).toEqual({
                ada: 'ΨΘ82ΩΡΦ-7ΑΙ',
                subject: 'ΕΓΚΡΙΣΗ ΠΡΟΫΠΟΛΟΓΙΣΜΟΥ',
                protocolNumber: '258/2024',
                issueDate: '2024-12-19',
                publishDate: '2024-12-20',
                decisionTypeId: 'Β.1.1',
                thematicCategoryIds: ['16'],
                organizationId: '6104',
                unitIds: ['81689'],
                documentUrl: 'https://diavgeia.gov.gr/doc/ΨΘ82ΩΡΦ-7ΑΙ',
                url: 'https://diavgeia.gov.gr/luminapi/api/decisions/ΨΘ82ΩΡΦ-7ΑΙ',
            } satisfies DiavgeiaDecision);
        });

        it('returns info metadata alongside decisions', async () => {
            fetchSpy.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(makeApiResponse([makeApiDecision()], 42)),
            });

            const result = await client.searchDecisions({
                organizationUid: '6104',
                fromDate: '2024-12-01',
                toDate: '2024-12-31',
            });

            expect(result.info.total).toBe(42);
            expect(result.info.page).toBe(0);
            expect(result.info.size).toBe(100);
        });

        it('throws on non-OK response', async () => {
            fetchSpy.mockResolvedValueOnce({
                ok: false,
                status: 500,
                statusText: 'Internal Server Error',
            });

            await expect(client.searchDecisions({
                organizationUid: '6104',
                fromDate: '2024-12-01',
                toDate: '2024-12-31',
            })).rejects.toThrow('Diavgeia API error: 500 Internal Server Error');
        });
    });

    describe('retry behavior', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        const searchParams = {
            organizationUid: '6104',
            fromDate: '2024-12-01',
            toDate: '2024-12-31',
        };

        function advanceRetryTimers() {
            // Flush the sleep promise by advancing past the max possible delay
            return vi.advanceTimersByTimeAsync(10000);
        }

        it('retries on 503 and eventually succeeds', async () => {
            fetchSpy
                .mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Service Temporarily Unavailable' })
                .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(makeApiResponse([makeApiDecision()])) });

            const promise = client.searchDecisions(searchParams);
            await advanceRetryTimers();
            const result = await promise;

            expect(fetchSpy).toHaveBeenCalledTimes(2);
            expect(result.decisions[0].ada).toBe('ΨΘ82ΩΡΦ-7ΑΙ');
        });

        it('retries on 429 and eventually succeeds', async () => {
            fetchSpy
                .mockResolvedValueOnce({ ok: false, status: 429, statusText: 'Too Many Requests' })
                .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(makeApiResponse([makeApiDecision()])) });

            const promise = client.searchDecisions(searchParams);
            await advanceRetryTimers();
            const result = await promise;

            expect(fetchSpy).toHaveBeenCalledTimes(2);
            expect(result.decisions[0].ada).toBe('ΨΘ82ΩΡΦ-7ΑΙ');
        });

        it('throws after max retries exhausted', async () => {
            fetchSpy.mockResolvedValue({ ok: false, status: 503, statusText: 'Service Temporarily Unavailable' });

            const promise = client.searchDecisions(searchParams);
            promise.catch(() => {}); // prevent unhandled rejection during timer advancement

            await vi.runAllTimersAsync();

            await expect(promise).rejects.toThrow('Diavgeia API error: 503 Service Temporarily Unavailable');
            expect(fetchSpy).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
        });

        it('does not retry on non-retryable errors', async () => {
            fetchSpy.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Internal Server Error' });

            await expect(client.searchDecisions(searchParams))
                .rejects.toThrow('Diavgeia API error: 500 Internal Server Error');
            expect(fetchSpy).toHaveBeenCalledTimes(1);
        });
    });

    describe('fetchAllDecisions', () => {
        it('returns all decisions from a single page', async () => {
            fetchSpy.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(makeApiResponse([
                    makeApiDecision({ ada: 'AAA' }),
                    makeApiDecision({ ada: 'BBB' }),
                ], 2)),
            });

            const decisions = await client.fetchAllDecisions({
                organizationUid: '6104',
                fromDate: '2024-12-01',
                toDate: '2024-12-31',
            });

            expect(decisions).toHaveLength(2);
            expect(decisions[0].ada).toBe('AAA');
            expect(decisions[1].ada).toBe('BBB');
        });

        it('paginates through multiple pages', async () => {
            // fetchAllDecisions uses pageSize=100, so mock total > 100 to trigger pagination
            const page0Decisions = Array.from({ length: 100 }, (_, i) =>
                makeApiDecision({ ada: `ADA-${i}` })
            );
            // Page 0: 100 of 101 total
            fetchSpy.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({
                    info: { total: 101, page: 0, size: 100 },
                    decisions: page0Decisions,
                }),
            });
            // Page 1: 1 of 101 total
            fetchSpy.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({
                    info: { total: 101, page: 1, size: 100 },
                    decisions: [makeApiDecision({ ada: 'ADA-100' })],
                }),
            });

            const decisions = await client.fetchAllDecisions({
                organizationUid: '6104',
                fromDate: '2024-12-01',
                toDate: '2024-12-31',
            });

            expect(decisions).toHaveLength(101);
            expect(decisions[0].ada).toBe('ADA-0');
            expect(decisions[100].ada).toBe('ADA-100');
            expect(fetchSpy).toHaveBeenCalledTimes(2);
        });

        it('stops at empty result set', async () => {
            fetchSpy.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(makeApiResponse([], 0)),
            });

            const decisions = await client.fetchAllDecisions({
                organizationUid: '6104',
                fromDate: '2024-12-01',
                toDate: '2024-12-31',
            });

            expect(decisions).toHaveLength(0);
            expect(fetchSpy).toHaveBeenCalledTimes(1);
        });
    });
});
