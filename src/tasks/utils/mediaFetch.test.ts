import { describe, it, expect, vi, afterEach } from 'vitest';
import { ProxyAgent, Response } from 'undici';
import { fetchMedia, mediaProxy, type MediaFetchDeps } from './mediaFetch.js';

const URL_ = 'https://archive-video.granicus.com/sandiego/clip.mp4';
const PROXY = 'http://user:secret@proxy.test:3128';

function deps(statuses: number[], proxy: string | undefined = PROXY) {
    const fetch = vi.fn<MediaFetchDeps['fetch']>();
    for (const status of statuses) fetch.mockResolvedValueOnce(new Response(status === 206 ? 'x' : 'blocked', { status }));
    return { fetch, proxy };
}

describe('fetchMedia', () => {
    afterEach(() => vi.restoreAllMocks());

    it('returns a direct answer without touching the proxy', async () => {
        const d = deps([206]);
        const res = await fetchMedia(URL_, { headers: { range: 'bytes=0-0' } }, d);
        expect(res.status).toBe(206);
        expect(d.fetch).toHaveBeenCalledTimes(1);
        expect(d.fetch.mock.calls[0][1]).not.toHaveProperty('dispatcher');
    });

    it.each([403, 429])('retries through the proxy when the host answers %i', async (status) => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const d = deps([status, 206]);
        const res = await fetchMedia(URL_, { method: 'HEAD' }, d);
        expect(res.status).toBe(206);
        expect(d.fetch).toHaveBeenCalledTimes(2);
        const [url, init] = d.fetch.mock.calls[1];
        expect(url).toBe(URL_);
        expect(init.method).toBe('HEAD');
        expect(init.dispatcher).toBeInstanceOf(ProxyAgent);
    });

    it('keeps the refusal when no proxy is configured', async () => {
        const d = { ...deps([403]), proxy: undefined };
        const res = await fetchMedia(URL_, {}, d);
        expect(res.status).toBe(403);
        expect(d.fetch).toHaveBeenCalledTimes(1);
    });

    it('does not retry other failures through the proxy', async () => {
        const d = deps([404]);
        const res = await fetchMedia(URL_, {}, d);
        expect(res.status).toBe(404);
        expect(d.fetch).toHaveBeenCalledTimes(1);
    });

    it('never logs the proxy address or its credentials', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await fetchMedia(URL_, {}, deps([403, 206]));
        expect(warn.mock.calls.flat().join(' ')).not.toContain('secret');
        expect(warn.mock.calls.flat().join(' ')).not.toContain('proxy.test');
    });
});

describe('mediaProxy', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('prefers YTDLP_PROXY over the generic proxy variables', () => {
        vi.stubEnv('YTDLP_PROXY', 'http://a:1');
        vi.stubEnv('HTTPS_PROXY', 'http://b:2');
        expect(mediaProxy()).toBe('http://a:1');
    });

    it('is undefined when no proxy is set', () => {
        vi.stubEnv('YTDLP_PROXY', '');
        vi.stubEnv('HTTP_PROXY', '');
        vi.stubEnv('HTTPS_PROXY', '');
        expect(mediaProxy()).toBeUndefined();
    });
});
