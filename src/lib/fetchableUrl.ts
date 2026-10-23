/**
 * The URLs in a task request (media, agenda, decision PDFs) are fetched by
 * this server. Node's fetch also serves `data:` and `blob:` URLs, and the
 * same strings reach yt-dlp as arguments, so every sink parses the value
 * here first and accepts http and https only.
 */
export function assertFetchableUrl(value: unknown, name = 'url'): URL {
    if (typeof value !== 'string') {
        throw new Error(`${name} must be a string`);
    }
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error(`${name} is not a valid URL`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`${name} must use http or https`);
    }
    return url;
}
