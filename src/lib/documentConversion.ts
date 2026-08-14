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
 * call can actually carry: a PDF rides in the request base64-encoded, which
 * costs a third more bytes, and Anthropic rejects requests over 32MB. 20MB
 * encodes to ~26.7MB, leaving room for the prompt and the rest of the payload.
 */
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

/**
 * A .docx is a zip, so its download size says nothing about what it expands to
 * — a small archive can decompress into gigabytes. Council agendas are text and
 * a few images; 100MB of uncompressed entries is already far past plausible.
 */
export const MAX_DOCX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;

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

const EOCD_SIGNATURE = 0x06054b50;                  // "PK\x05\x06" — end of central directory
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;        // "PK\x01\x02" — central directory file header
const CENTRAL_HEADER_FIXED_SIZE = 46;
const ZIP64_SIZE_SENTINEL = 0xffffffff;             // real size lives in the zip64 extra field

/**
 * Sums the uncompressed sizes a zip declares for its entries, reading only the
 * central directory — no decompression. This is what lets an archive be
 * rejected before mammoth expands it.
 *
 * A zip64 sentinel returns Infinity: the real size is in an extra field, but
 * any entry claiming ≥4GB is past every limit we care about anyway.
 *
 * Throws when the central directory can't be read. Every .docx has one, and
 * refusing to convert a file whose structure we can't account for is the
 * safe direction.
 */
export const declaredUncompressedSize = (zip: Buffer): number => {
    // The EOCD record sits at the end, after a variable-length comment.
    const scanFloor = Math.max(0, zip.length - 22 - 0xffff);
    let eocd = -1;
    for (let i = zip.length - 22; i >= scanFloor; i--) {
        if (zip.readUInt32LE(i) === EOCD_SIGNATURE) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) {
        throw new Error("Malformed .docx: no zip end-of-central-directory record");
    }

    const entryCount = zip.readUInt16LE(eocd + 10);
    let offset = zip.readUInt32LE(eocd + 16);
    let total = 0;

    for (let i = 0; i < entryCount; i++) {
        if (offset + CENTRAL_HEADER_FIXED_SIZE > zip.length || zip.readUInt32LE(offset) !== CENTRAL_HEADER_SIGNATURE) {
            throw new Error("Malformed .docx: truncated or corrupt zip central directory");
        }

        const uncompressed = zip.readUInt32LE(offset + 24);
        if (uncompressed === ZIP64_SIZE_SENTINEL) {
            return Infinity;
        }
        total += uncompressed;

        const nameLength = zip.readUInt16LE(offset + 28);
        const extraLength = zip.readUInt16LE(offset + 30);
        const commentLength = zip.readUInt16LE(offset + 32);
        offset += CENTRAL_HEADER_FIXED_SIZE + nameLength + extraLength + commentLength;
    }

    return total;
};

/**
 * Guards the conversion against decompression bombs. An inflated
 * word/document.xml is expanded in-process before any HTML comes back for the
 * output check to look at, so the bound has to be on the archive rather than
 * on the result. Entries mammoth never reads are decompressed lazily and may
 * cost nothing, but they are summed here too — it is the cheaper assumption.
 *
 * The declared sizes come from the zip's own headers, which a hostile file
 * could understate. Catching that would mean decompressing with a running
 * ceiling, which mammoth gives no way to do — so this bounds the ordinary
 * bomb, and the download cap bounds everything upstream of it.
 */
export const checkDocxExpansion = (docx: Buffer): void => {
    const declared = declaredUncompressedSize(docx);
    if (declared > MAX_DOCX_UNCOMPRESSED_BYTES) {
        const size = declared === Infinity ? '4GB+' : `${Math.round(declared / 1024 / 1024)}MB`;
        throw new Error(`DOCX expands to ${size}, over the ${MAX_DOCX_UNCOMPRESSED_BYTES / 1024 / 1024}MB limit — this does not look like a council agenda`);
    }
};

/**
 * mammoth inlines embedded images as base64 data URIs, which would be tens of
 * thousands of useless tokens in the prompt. Agenda images are letterheads and
 * signatures, so drop them and keep the markup.
 */
export const stripImages = (html: string): string => html.replace(/<img\b[^>]*>/gi, '');

/**
 * Text left once tags and non-breaking spaces are removed. What matters is
 * whether the model has anything to read: a scanned agenda converts to markup
 * wrapping a single image, which survives image stripping as an empty shell
 * like `<p></p>` — not an empty string, but nothing to extract from either.
 */
const readableText = (html: string): string => html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:nbsp|#160|#xa0);/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Rejects conversions that can't produce a usable extraction. Oversized markup
 * fails rather than being truncated: this task promises every subject on the
 * agenda, and silently dropping the tail of the document would break that
 * promise without anyone noticing.
 */
export const checkConvertedHtml = (html: string): string => {
    if (readableText(html) === '') {
        throw new Error("DOCX conversion produced no readable text — the file may be corrupt, or an agenda scanned to images, which this task cannot read");
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
    checkDocxExpansion(docx);

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
