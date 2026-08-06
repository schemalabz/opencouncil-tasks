import mammoth from "mammoth";

/**
 * Agenda documents arrive as whatever the municipality published. Claude's
 * document block only accepts PDFs, so a .docx has to become something the
 * model can read before extraction.
 */
export type DocumentFormat = 'pdf' | 'docx' | 'doc' | 'unknown';

const PDF_MAGIC = '%PDF-';
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);       // "PK\x03\x04"
const OLE2_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]);      // legacy .doc/.xls

/**
 * Real agendas are a few hundred KB. The ceiling is set by what the extraction
 * call can actually carry: Anthropic rejects requests over 32MB, so a larger
 * PDF would fail mid-call with a far less obvious error than this one.
 */
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

/**
 * Converted markup goes into the prompt, so its size is token spend. 500K
 * characters is far more than any council agenda and still well inside the
 * context window — passing it means something is wrong with the document.
 */
export const MAX_CONVERTED_HTML_CHARS = 500_000;

/**
 * Identifies a document by its bytes rather than by URL extension: agenda URLs
 * are often signed or extension-less, and a wrong extension is common enough
 * that the content is the only trustworthy signal.
 */
export const detectDocumentFormat = (bytes: Buffer): DocumentFormat => {
    // Some PDFs carry leading junk before the header, so search a small window
    // instead of only looking at offset 0.
    if (bytes.subarray(0, 1024).includes(PDF_MAGIC)) {
        return 'pdf';
    }

    if (bytes.subarray(0, 4).equals(ZIP_MAGIC)) {
        // Every OOXML format is a zip; the word/ entry is what makes it a docx.
        // Entry names are stored uncompressed in the zip headers, so a plain
        // byte search is enough to tell docx from xlsx/pptx/odt.
        return bytes.includes('word/document.xml') ? 'docx' : 'unknown';
    }

    if (bytes.subarray(0, 4).equals(OLE2_MAGIC)) {
        return 'doc';
    }

    return 'unknown';
};

/**
 * mammoth inlines embedded images as base64 data URIs, which would be tens of
 * thousands of useless tokens in the prompt. Agenda images are letterheads and
 * signatures, so drop them and keep the markup.
 */
export const stripImages = (html: string): string => html.replace(/<img\b[^>]*>/gi, '');

/**
 * Rejects conversions that can't produce a usable extraction. Oversized markup
 * fails rather than being truncated: this task promises every subject on the
 * agenda, and silently dropping the tail of the document would break that
 * promise without anyone noticing.
 */
export const checkConvertedHtml = (html: string): string => {
    if (html === '') {
        throw new Error("DOCX conversion produced an empty document — the file may be corrupt or contain only scanned images");
    }

    if (html.length > MAX_CONVERTED_HTML_CHARS) {
        throw new Error(`DOCX conversion produced ${Math.round(html.length / 1024)}KB of markup, over the ${MAX_CONVERTED_HTML_CHARS / 1024}KB limit — this does not look like a council agenda`);
    }

    return html;
};

/**
 * Converts a .docx to HTML. Headings, lists, and tables survive as markup, so
 * the model sees the document's structure — the same structure a rendered PDF
 * would have shown it, without the render.
 */
export const convertDocxToHtml = async (docx: Buffer): Promise<string> => {
    const { value, messages } = await mammoth.convertToHtml({ buffer: docx });

    const warnings = messages.filter(m => m.type === 'warning');
    if (warnings.length > 0) {
        console.log(`   ⚠️  ${warnings.length} docx conversion warning(s), e.g. "${warnings[0].message}"`);
    }

    return checkConvertedHtml(stripImages(value).trim());
};

/**
 * Downloads with a hard byte ceiling, aborting mid-stream rather than
 * buffering an entire oversized response first.
 */
const downloadBounded = async (url: string, maxBytes: number): Promise<Buffer> => {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to download document from ${url}: ${response.status} ${response.statusText}`);
    }

    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        await response.body?.cancel();
        throw new Error(`Document at ${url} is too large: declares ${declaredLength} bytes, over the ${maxBytes / 1024 / 1024}MB limit`);
    }

    if (!response.body) {
        throw new Error(`Failed to download document from ${url}: empty response body`);
    }

    // content-length is advisory (absent on chunked responses, and a server may
    // simply lie), so the ceiling is enforced against the bytes as they arrive.
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) {
            await reader.cancel();
            throw new Error(`Document at ${url} is too large: exceeds the ${maxBytes / 1024 / 1024}MB limit`);
        }
        chunks.push(value);
    }

    return Buffer.concat(chunks);
};

/**
 * An agenda ready for extraction: a PDF goes to Claude as a document block,
 * a converted .docx as markup in the prompt.
 */
export type AgendaDocument =
    | { kind: 'pdf'; base64: string }
    | { kind: 'html'; html: string };

export const fetchAgendaDocument = async (url: string): Promise<AgendaDocument> => {
    console.log(`   Downloading ${url}`);
    const bytes = await downloadBounded(url, MAX_DOCUMENT_BYTES);
    const format = detectDocumentFormat(bytes);
    console.log(`   Downloaded ${Math.round(bytes.length / 1024)}KB (detected format: ${format})`);

    if (format === 'pdf') {
        return { kind: 'pdf', base64: bytes.toString('base64') };
    }

    if (format === 'docx') {
        const html = await convertDocxToHtml(bytes);
        console.log(`   Converted DOCX to ${html.length} characters of HTML`);
        return { kind: 'html', html };
    }

    if (format === 'doc') {
        throw new Error(`Unsupported document format at ${url}: legacy Word (.doc). Please provide a PDF or .docx file.`);
    }

    throw new Error(`Unsupported document format at ${url}: expected a PDF or .docx file.`);
};
