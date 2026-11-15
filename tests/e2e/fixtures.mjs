// Builds the documents the end-to-end tests open, in a fresh temp directory.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import JSZip from "jszip";

export const PDF_PAGE_COUNT = 3;
export const DOCX_TEXT = "Hello from the Word end-to-end test";

async function buildPdf() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= PDF_PAGE_COUNT; i += 1) {
    const page = pdf.addPage([595, 842]);
    page.drawText(`End-to-end page ${i}`, { x: 72, y: 760, size: 28, font });
  }
  return pdf.save();
}

async function buildDocx() {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>${DOCX_TEXT}</w:t></w:r></w:p>
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>
  </w:body>
</w:document>`,
  );
  return zip.generateAsync({ type: "uint8array" });
}

export async function createFixtures() {
  const dir = mkdtempSync(join(tmpdir(), "pdf-reader-e2e-"));
  const files = {
    pdf: join(dir, "sample.pdf"),
    docx: join(dir, "sample.docx"),
    corrupt: join(dir, "corrupt.pdf"),
    missing: join(dir, "does-not-exist.pdf"),
    legacyDoc: join(dir, "legacy.docx"),
  };
  writeFileSync(files.pdf, await buildPdf());
  writeFileSync(files.docx, await buildDocx());
  writeFileSync(files.corrupt, "this is not a PDF at all");
  // A legacy .doc (OLE header) saved under a .docx name.
  writeFileSync(
    files.legacyDoc,
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]),
  );
  return { dir, files };
}
