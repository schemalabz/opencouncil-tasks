/**
 * Client for the Diavgeia (Greek Government Transparency) API
 * https://diavgeia.gov.gr/api/help
 */

const DIAVGEIA_API_BASE = 'https://diavgeia.gov.gr/opendata';

// Raw API response types (as returned by the Diavgeia API)
interface DiavgeiaApiDecision {
    ada: string;
    subject: string;
    protocolNumber: string;
    issueDate: number; // Timestamp in milliseconds
    organizationId: string;
    decisionTypeId: string;
    thematicCategoryIds: string[];
    documentUrl: string;
    url: string;
}

interface DiavgeiaApiResponse {
    info: {
        total: number;
        page: number;
        size: number;
    };
    decisions: DiavgeiaApiDecision[];
}

// Our normalized decision type
export interface DiavgeiaDecision {
    ada: string; // Unique decision identifier (ADA)
    subject: string; // Decision subject/title
    protocolNumber: string; // Protocol number
    issueDate: string; // ISO date string when the decision was issued
    decisionTypeId: string; // e.g., "Β.2.2", "2.4.7.1"
    thematicCategoryIds: string[];
    organizationId: string;
    documentUrl: string; // URL to the PDF document
    url: string; // URL to the decision page on Diavgeia
}

export class DiavgeiaClient {
    /**
     * Search for decisions from an organization around a specific date
     */
    async searchDecisions(params: {
        organizationUid: string;
        fromDate: string; // ISO date (YYYY-MM-DD)
        toDate: string; // ISO date (YYYY-MM-DD)
        decisionTypeId?: string; // Filter by decision type
        unitId?: string; // Filter by organizational unit (e.g., "81689" for ΔΗΜΟΤΙΚΟ ΣΥΜΒΟΥΛΙΟ)
        page?: number;
        size?: number;
    }): Promise<{ info: DiavgeiaApiResponse['info']; decisions: DiavgeiaDecision[] }> {
        const { organizationUid, fromDate, toDate, decisionTypeId, unitId, page = 0, size = 100 } = params;

        const queryParams = new URLSearchParams({
            org: organizationUid,
            from_issue_date: fromDate,
            to_issue_date: toDate,
            page: page.toString(),
            size: size.toString(),
            status: 'PUBLISHED',
        });

        if (decisionTypeId) {
            queryParams.set('type', decisionTypeId);
        }

        if (unitId) {
            queryParams.set('unit', unitId);
        }

        const url = `${DIAVGEIA_API_BASE}/search?${queryParams}`;
        console.log(`Fetching Diavgeia decisions: ${url}`);

        const response = await fetch(url, {
            headers: {
                'Accept': 'application/json',
            },
        });

        if (!response.ok) {
            throw new Error(`Diavgeia API error: ${response.status} ${response.statusText}`);
        }

        const data: DiavgeiaApiResponse = await response.json();

        // Map raw API response to our normalized format
        const decisions: DiavgeiaDecision[] = data.decisions.map(d => ({
            ada: d.ada,
            subject: d.subject,
            protocolNumber: d.protocolNumber,
            issueDate: new Date(d.issueDate).toISOString().split('T')[0],
            decisionTypeId: d.decisionTypeId,
            thematicCategoryIds: d.thematicCategoryIds || [],
            organizationId: d.organizationId,
            documentUrl: d.documentUrl,
            url: d.url,
        }));

        return { info: data.info, decisions };
    }

    /**
     * Fetch all decisions from an organization within a date range
     * Handles pagination automatically
     */
    async fetchAllDecisions(params: {
        organizationUid: string;
        fromDate: string;
        toDate: string;
        decisionTypeId?: string;
        unitId?: string;
    }): Promise<DiavgeiaDecision[]> {
        const allDecisions: DiavgeiaDecision[] = [];
        let page = 0;
        const pageSize = 100;

        while (true) {
            const response = await this.searchDecisions({
                ...params,
                page,
                size: pageSize,
            });

            allDecisions.push(...response.decisions);

            // Check if we've fetched all pages
            const totalPages = Math.ceil(response.info.total / pageSize);
            if (page >= totalPages - 1) {
                break;
            }

            page++;
        }

        console.log(`Fetched ${allDecisions.length} decisions from Diavgeia`);
        return allDecisions;
    }
}

export const diavgeiaClient = new DiavgeiaClient();
