/**
 * The conventions text of several bodies, as opencouncil's
 * `scripts/conventions-text.ts --all` prints it: a `### <city>/<body>` header
 * per body, then the sentences the poll request would carry for it.
 *
 * Keyed `<city>/<body>`. A body with no sentences is left out, so a caller can
 * name it as read cold rather than send an empty hint.
 */
export function parseBodyHints(text: string): Map<string, string> {
    const hints = new Map<string, string>();
    const blocks = text.split(/^### /m);
    if (blocks.length < 2) {
        throw new Error('expected `### <city>/<body>` headers, as scripts/conventions-text.ts --all prints them; a single body\'s text is not a per-body file');
    }
    for (const block of blocks.slice(1)) {
        const newline = block.indexOf('\n');
        const key = (newline < 0 ? block : block.slice(0, newline)).trim();
        const body = newline < 0 ? '' : block.slice(newline + 1).trim();
        if (key && body) hints.set(key, body);
    }
    return hints;
}
