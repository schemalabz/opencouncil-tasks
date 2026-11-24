import { fetch as undiciFetch, ProxyAgent, type RequestInit, type Response } from "undici";

/** The residential proxy for media hosts that throttle or block datacenter addresses. */
export function mediaProxy(): string | undefined {
    return process.env.YTDLP_PROXY || process.env.HTTP_PROXY || process.env.HTTPS_PROXY || undefined;
}

// Answers that a residential address can get past. Granicus' CloudFront answers 403
// "Request blocked" to the task server's datacenter address and serves the same request
// from a residential one.
const BLOCKED_STATUSES = new Set([403, 429]);

let cachedAgent: { proxy: string; dispatcher: ProxyAgent } | undefined;
function proxyDispatcher(proxy: string): ProxyAgent {
    if (cachedAgent?.proxy !== proxy) cachedAgent = { proxy, dispatcher: new ProxyAgent(proxy) };
    return cachedAgent.dispatcher;
}

export interface MediaFetchDeps {
    fetch: (url: string, init: RequestInit) => Promise<Response>;
    proxy: string | undefined;
}

/**
 * Fetches a media file directly, and once more through the media proxy when the host
 * refuses the direct request. Most direct files (our Spaces, municipal servers) need no
 * proxy, so a multi-GB file crosses the proxy's residential uplink only when it must.
 */
export async function fetchMedia(
    url: string,
    init: RequestInit = {},
    deps: MediaFetchDeps = { fetch: undiciFetch, proxy: mediaProxy() },
): Promise<Response> {
    const direct = await deps.fetch(url, init);
    if (!BLOCKED_STATUSES.has(direct.status) || !deps.proxy) return direct;
    await direct.body?.cancel();
    console.warn(`[media-fetch] ${new URL(url).origin} answered ${direct.status} to the direct request; retrying through the media proxy`);
    return deps.fetch(url, { ...init, dispatcher: proxyDispatcher(deps.proxy) });
}
