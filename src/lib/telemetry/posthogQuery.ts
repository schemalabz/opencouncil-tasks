/**
 * PostHog's private API with a personal API key: HogQL reads through the query endpoint, and
 * the REST calls `eval sync --apply` makes. The sink only holds the ingest token, which can
 * do neither.
 */
export type PosthogQuery = (hogql: string) => Promise<{ columns: string[]; results: unknown[][] }>;

export type PosthogReadConfig = { key: string; project: string; host: string };

export function posthogReadConfig(): PosthogReadConfig | null {
    const { POSTHOG_PERSONAL_API_KEY: key, POSTHOG_PROJECT_ID: project, POSTHOG_API_HOST: host } = process.env;
    return key && project && host ? { key, project, host: host.replace(/\/+$/, '') } : null;
}

export const POSTHOG_READ_ENV = 'POSTHOG_PERSONAL_API_KEY/PROJECT_ID/API_HOST';

/** A non-2xx answer; `status` tells a missing scope (403) from a rejected body (400). */
export class PosthogApiError extends Error {
    constructor(message: string, readonly status: number) {
        super(message);
    }
}

/** One call to `<host>/api/<path>`, where `{project}` stands for the configured project id. */
export type PosthogRequest = <T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown) => Promise<T>;

export function posthogRequest(config: PosthogReadConfig): PosthogRequest {
    return async <T>(method: string, path: string, body?: unknown) => {
        const res = await fetch(`${config.host}/api/${path.replace('{project}', encodeURIComponent(config.project))}`, {
            method,
            headers: { authorization: `Bearer ${config.key}`, 'content-type': 'application/json' },
            ...(body !== undefined && { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) throw new PosthogApiError(`PostHog ${method} ${path} answered HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status);
        return await res.json() as T;
    };
}

export function posthogQuery(config: PosthogReadConfig): PosthogQuery {
    const request = posthogRequest(config);
    return async hogql => {
        const body = await request<{ columns?: string[]; results?: unknown[][] }>('POST', 'projects/{project}/query/', { query: { kind: 'HogQLQuery', query: hogql } });
        return { columns: body.columns ?? [], results: body.results ?? [] };
    };
}

/** Rows as objects keyed by column name. */
export function rowsOf(out: { columns: string[]; results: unknown[][] }): Array<Record<string, unknown>> {
    return out.results.map(row => Object.fromEntries(out.columns.map((c, i) => [c, row[i]])));
}
