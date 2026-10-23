import type { MinutesPage } from "./read.js";

/**
 * The text form of a document's pages: «=== page N» lines between the pages.
 * The fixtures under fixtures/municipal-minutes/ are excerpts of real minutes
 * in this form, and the CLI reads a .txt in it as it reads a PDF.
 */
export function parsePagedText(text: string): MinutesPage[] {
    const pages: MinutesPage[] = [];
    for (const line of text.split(/\r?\n/)) {
        const marker = /^=== page (\d+)\s*$/.exec(line);
        if (marker) {
            pages.push({ page: Number(marker[1]), lines: [] });
            continue;
        }
        if (pages.length === 0) pages.push({ page: 1, lines: [] });
        if (line.trim()) pages[pages.length - 1].lines.push(line.trim());
    }
    return pages;
}
