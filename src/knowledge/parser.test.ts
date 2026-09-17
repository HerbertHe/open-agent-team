import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { parseKnowledgeFile, parseKnowledgeText, supportsKnowledgeFile } from "./parser";

test("parses supported text and HTML into deterministic overlapping chunks", () => {
  assert.equal(supportsKnowledgeFile("guide.md"), true);
  assert.equal(supportsKnowledgeFile("guide.pdf"), true);
  assert.equal(supportsKnowledgeFile("guide.docx"), true);
  const source = `<script>ignore me</script><h1>Guide</h1>\n${"shared knowledge line\n".repeat(80)}`;
  const first = parseKnowledgeText("guide.html", Buffer.from(source), 128, 16);
  const second = parseKnowledgeText("guide.html", Buffer.from(source), 128, 16);
  assert.ok(first.length > 1);
  assert.deepEqual(second, first);
  assert.equal(first.some(({ content }) => content.includes("ignore me")), false);
  assert.ok(first.every(({ contentHash }) => contentHash.length === 64));
  assert.ok(first.every(({ lineStart, lineEnd }) => lineStart <= lineEnd));
});

function minimalPdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

test("extracts PDF and DOCX before deterministic chunking", async () => {
  const pdf = await parseKnowledgeFile("guide.pdf", minimalPdf("Shared PDF knowledge"), 128, 16);
  assert.match(pdf.map(({ content }) => content).join("\n"), /Shared PDF knowledge/);

  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Shared DOCX knowledge</w:t></w:r></w:p></w:body></w:document>`);
  const docx = await parseKnowledgeFile("guide.docx", await zip.generateAsync({ type: "nodebuffer" }), 128, 16);
  assert.match(docx.map(({ content }) => content).join("\n"), /Shared DOCX knowledge/);
});
