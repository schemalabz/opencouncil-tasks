import { describe, it, expect, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { describePageRanges, extractPdfPageSet, extractPdfPages, headAndTailPages } from './pdfPages.js';

/** Built rather than fixtured, so the test carries no binary asset. Page i is 200 + i wide, so a slice says which pages it holds. */
async function buildPdf(pages: number): Promise<Buffer> {
    const doc = await PDFDocument.create();
    for (let i = 0; i < pages; i++) doc.addPage([200 + i, 200]);
    return Buffer.from(await doc.save());
}

/** The widths of a slice's pages, which name the source pages it took. */
async function pageWidths(base64: string): Promise<number[]> {
    return (await PDFDocument.load(Buffer.from(base64, 'base64'))).getPages().map(p => p.getWidth());
}

async function pageCount(base64: string): Promise<number> {
    return (await PDFDocument.load(Buffer.from(base64, 'base64'))).getPageCount();
}

describe('extractPdfPageSet', () => {
    it('takes a head-and-tail slice without duplicating the overlap', async () => {
        const pdf = await buildPdf(4);
        expect(await pageCount(await extractPdfPageSet(pdf, [0, 1, 2, 2, 3]))).toBe(4);
    });

    it('drops indices past the end when some remain valid', async () => {
        const pdf = await buildPdf(2);
        expect(await pageCount(await extractPdfPageSet(pdf, [0, 1, 7, 8]))).toBe(2);
    });

    it('throws rather than returning a blank PDF when nothing is selected', async () => {
        const pdf = await buildPdf(3);
        await expect(extractPdfPageSet(pdf, [])).rejects.toThrow(/No valid pages/);
        await expect(extractPdfPageSet(pdf, [9, 10])).rejects.toThrow(/No valid pages/);
    });

    // A progressive read slices the same document up to eleven times. It parses
    // once and passes the document, so both inputs must reach the same slice.
    it('slices a document the caller already parsed the same way as the bytes', async () => {
        const pdf = await buildPdf(6);
        // Each slice is a new document that pdf-lib stamps with the current time,
        // so two slices taken a second apart are different bytes: compare the
        // pages each one took, with the clock moved between the two on purpose.
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            vi.setSystemTime(new Date('2026-09-25T10:00:00Z'));
            const fromDoc = await extractPdfPageSet(await PDFDocument.load(pdf), [0, 5]);
            vi.setSystemTime(new Date('2026-09-25T10:00:01Z'));
            const fromBytes = await extractPdfPageSet(pdf, [0, 5]);
            expect(await pageWidths(fromDoc)).toEqual([200, 205]);
            expect(await pageWidths(fromBytes)).toEqual([200, 205]);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('extractPdfPages', () => {
    it('clamps a range that runs past the end', async () => {
        const pdf = await buildPdf(10);
        expect(await pageCount(await extractPdfPages(pdf, 0, 3))).toBe(3);
        expect(await pageCount(await extractPdfPages(pdf, 0, 50))).toBe(10);
    });
});

describe('headAndTailPages', () => {
    it('returns the opening and closing pages of a long document', () => {
        expect(headAndTailPages(139, 3, 2)).toEqual([0, 1, 2, 137, 138]);
    });

    it('never repeats a page when the two ends meet', () => {
        // A 4-page document: the head is 0,1,2 and the tail is 2,3.
        expect(headAndTailPages(4, 3, 2)).toEqual([0, 1, 2, 3]);
    });

    it('returns every page when the document is shorter than the window', () => {
        expect(headAndTailPages(2, 3, 2)).toEqual([0, 1]);
    });
});

describe('describePageRanges', () => {
    it('collapses the two ends of a long document into two runs', () => {
        expect(describePageRanges(headAndTailPages(139, 3, 2))).toBe('1-3 and 138-139');
    });

    it('reports one run when the ends meet', () => {
        expect(describePageRanges(headAndTailPages(4, 3, 2))).toBe('1-4');
    });

    it('reports a single page without a range', () => {
        expect(describePageRanges([0, 5, 6])).toBe('1 and 6-7');
    });
});
