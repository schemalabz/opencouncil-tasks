import { PDFDocument } from 'pdf-lib';

/**
 * Page selection for PDFs handed to a model.
 *
 * Kept apart from the decision-specific code because it is neither: a caller
 * that wants the first three pages and the last two of a 139-page document has
 * nothing to do with Greek municipal law, and the decision module's tests mock
 * `pdf-lib` wholesale, which leaves slicing untestable there.
 */

/**
 * A PDF to slice: the bytes, or a document a caller has already parsed.
 *
 * Every caller reads the page count before it can choose pages, so it holds a
 * parsed document already. Passing the buffer made each slice parse it again,
 * and a progressive read of one 19-page document parsed the same bytes about
 * eleven times.
 */
export type PdfSource = Buffer | PDFDocument;

/** `instanceof PDFDocument` is not usable: tests that mock `pdf-lib` leave it un-callable. */
const loaded = (source: PdfSource): Promise<PDFDocument> =>
    Buffer.isBuffer(source) ? PDFDocument.load(source) : Promise.resolve(source);

/**
 * Build a new PDF from an explicit list of 0-indexed pages, returned as base64.
 *
 * Out-of-range and duplicate indices are dropped and the given order is kept,
 * so a caller can ask for a head-and-tail slice without first working out
 * whether the two ranges overlap.
 */
export async function extractPdfPageSet(source: PdfSource, pageIndices: number[]): Promise<string> {
    const srcDoc = await loaded(source);
    const totalPages = srcDoc.getPageCount();

    const seen = new Set<number>();
    const wanted = pageIndices.filter(i => {
        if (!Number.isInteger(i) || i < 0 || i >= totalPages || seen.has(i)) return false;
        seen.add(i);
        return true;
    });

    // A selection that matches nothing would otherwise produce a blank PDF,
    // and a model handed a blank page returns a confident observation of
    // nothing. Fail loudly instead.
    if (wanted.length === 0) {
        throw new Error(`No valid pages selected from a ${totalPages}-page PDF (asked for ${JSON.stringify(pageIndices)})`);
    }

    const newDoc = await PDFDocument.create();
    const copiedPages = await newDoc.copyPages(srcDoc, wanted);
    for (const page of copiedPages) {
        newDoc.addPage(page);
    }

    const pdfBytes = await newDoc.save();
    return Buffer.from(pdfBytes).toString('base64');
}

/**
 * Extract a range of pages from a PDF buffer and return as base64.
 * Pages are 0-indexed: extractPdfPages(buf, 0, 5) → first 5 pages.
 */
export async function extractPdfPages(source: PdfSource, startPage: number, endPage: number): Promise<string> {
    const srcDoc = await loaded(source);
    const actualEnd = Math.min(endPage, srcDoc.getPageCount());
    return extractPdfPageSet(
        srcDoc,
        Array.from({ length: Math.max(0, actualEnd - startPage) }, (_, i) => startPage + i),
    );
}

/**
 * The pages of a document that carry what a survey needs: the opening, where a
 * Greek decision states its session, roll call and attendance changes, and the
 * closing, where it states its vote and its own number. The middle is subject
 * matter, and in this corpus it can run to 135 pages of bound-in study.
 */
export function headAndTailPages(totalPages: number, head: number, tail: number): number[] {
    const indices = [
        ...Array.from({ length: Math.min(head, totalPages) }, (_, i) => i),
        ...Array.from({ length: Math.min(tail, totalPages) }, (_, i) => totalPages - Math.min(tail, totalPages) + i),
    ];
    return [...new Set(indices)].sort((a, b) => a - b);
}

/**
 * The selection as page numbers a reader would recognise: 1-based, and
 * contiguous runs collapsed. A model told which pages of the document it holds
 * can report a page number the document itself prints.
 */
export function describePageRanges(pageIndices: number[]): string {
    const pages = [...new Set(pageIndices)].sort((a, b) => a - b).map(i => i + 1);
    const runs: string[] = [];
    for (let i = 0; i < pages.length;) {
        let end = i;
        while (end + 1 < pages.length && pages[end + 1] === pages[end] + 1) end++;
        runs.push(i === end ? `${pages[i]}` : `${pages[i]}-${pages[end]}`);
        i = end + 1;
    }
    return runs.join(' and ');
}
