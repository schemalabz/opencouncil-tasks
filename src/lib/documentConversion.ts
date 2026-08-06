import mammoth from "mammoth";
import puppeteer from "puppeteer";

/**
 * Agenda documents arrive as whatever the municipality published. Claude's
 * document block only accepts PDFs, so anything else has to be converted
 * before it reaches the model.
 */
export type DocumentFormat = 'pdf' | 'docx' | 'doc' | 'unknown';

const PDF_MAGIC = '%PDF-';
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);       // "PK\x03\x04"
const OLE2_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]);      // legacy .doc/.xls

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
 * Wraps mammoth's bare HTML in a printable document. The styling exists so the
 * model sees the same structure a reader would: table borders make cells
 * distinguishable, and the font stack has to cover Greek.
 */
export const buildPrintableHtml = (bodyHtml: string): string => `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body {
    font-family: "DejaVu Sans", "Liberation Sans", "Noto Sans", Arial, sans-serif;
    font-size: 11pt;
    line-height: 1.4;
    color: #000;
  }
  h1 { font-size: 16pt; }
  h2 { font-size: 14pt; }
  h3 { font-size: 12pt; }
  table {
    border-collapse: collapse;
    width: 100%;
    margin: 8pt 0;
  }
  th, td {
    border: 1px solid #666;
    padding: 4pt 6pt;
    vertical-align: top;
    text-align: left;
  }
  img { max-width: 100%; }
  p { margin: 6pt 0; }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;

/**
 * Converts a .docx to PDF by rendering mammoth's HTML in headless Chrome.
 * Chrome is already a dependency of this service (puppeteer, for YouTube
 * scraping), which keeps this from pulling in a full office suite.
 */
export const convertDocxToPdf = async (docx: Buffer): Promise<Buffer> => {
    const { value: bodyHtml, messages } = await mammoth.convertToHtml({ buffer: docx });

    const warnings = messages.filter(m => m.type === 'warning');
    if (warnings.length > 0) {
        console.log(`   ⚠️  ${warnings.length} docx conversion warning(s), e.g. "${warnings[0].message}"`);
    }

    if (bodyHtml.trim() === '') {
        throw new Error("DOCX conversion produced an empty document — the file may be corrupt or contain only images without text");
    }

    const browser = await puppeteer.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.setContent(buildPrintableHtml(bodyHtml), { waitUntil: 'load' });
        const pdf = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' },
        });
        return Buffer.from(pdf);
    } finally {
        await browser.close();
    }
};

/**
 * Downloads an agenda document and returns it as base64-encoded PDF,
 * converting from .docx when needed.
 */
export const fetchDocumentAsPdfBase64 = async (url: string): Promise<{ base64: string; sourceFormat: DocumentFormat }> => {
    console.log(`   Downloading ${url}`);
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to download document from ${url}: ${response.status} ${response.statusText}`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    const sourceFormat = detectDocumentFormat(bytes);
    console.log(`   Downloaded ${Math.round(bytes.length / 1024)}KB (detected format: ${sourceFormat})`);

    if (sourceFormat === 'pdf') {
        return { base64: bytes.toString('base64'), sourceFormat };
    }

    if (sourceFormat === 'docx') {
        console.log(`   Converting DOCX to PDF...`);
        const pdf = await convertDocxToPdf(bytes);
        console.log(`   Converted to ${Math.round(pdf.length / 1024)}KB PDF`);
        return { base64: pdf.toString('base64'), sourceFormat };
    }

    if (sourceFormat === 'doc') {
        throw new Error(`Unsupported document format at ${url}: legacy Word (.doc). Please provide a PDF or .docx file.`);
    }

    throw new Error(`Unsupported document format at ${url}: expected a PDF or .docx file.`);
};
