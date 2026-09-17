import path from "node:path";
import { createHash } from "node:crypto";

const TEXT_EXTENSIONS = new Set([
  ".md", ".mdx", ".txt", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".xml", ".html", ".htm",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".kt", ".swift",
  ".c", ".h", ".cpp", ".hpp", ".css", ".less", ".scss", ".sql", ".sh", ".zsh", ".fish",
]);
const DOCUMENT_EXTENSIONS = new Set([".pdf", ".docx"]);

export type ParsedKnowledgeChunk = {
  ordinal: number;
  heading?: string;
  content: string;
  contentHash: string;
  tokenCount: number;
  lineStart: number;
  lineEnd: number;
};

function estimateTokens(value: string): number {
  const cjk = (value.match(/[\u3400-\u9fff]/gu) ?? []).length;
  return cjk + Math.ceil(Math.max(0, [...value].length - cjk) / 4);
}

function cleanHtml(value: string): string {
  return value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ").replace(/&nbsp;/gu, " ").replace(/&amp;/gu, "&");
}

export function supportsKnowledgeFile(file: string): boolean {
  const extension = path.extname(file).toLowerCase();
  return TEXT_EXTENSIONS.has(extension) || DOCUMENT_EXTENSIONS.has(extension);
}

export function parseKnowledgeText(file: string, bytes: Buffer, chunkTokens: number, overlapTokens: number): ParsedKnowledgeChunk[] {
  if (!TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) return [];
  let text = bytes.toString("utf8").replace(/\0/gu, "").replace(/\r\n?/gu, "\n");
  if ([".html", ".htm"].includes(path.extname(file).toLowerCase())) text = cleanHtml(text);
  const lines = text.split("\n");
  const maxChars = Math.max(512, chunkTokens * 4);
  const overlapChars = Math.max(0, Math.min(maxChars - 1, overlapTokens * 4));
  const chunks: ParsedKnowledgeChunk[] = [];
  let start = 0;
  while (start < lines.length) {
    let end = start;
    let length = 0;
    let heading: string | undefined;
    while (end < lines.length) {
      const line = lines[end]!;
      if (!heading) heading = line.match(/^#{1,6}\s+(.+)$/u)?.[1]?.trim();
      if (length > 0 && length + line.length + 1 > maxChars) break;
      length += line.length + 1;
      end += 1;
    }
    if (end === start) end += 1;
    const content = lines.slice(start, end).join("\n").trim();
    if (content) chunks.push({
      ordinal: chunks.length, heading, content,
      contentHash: createHash("sha256").update(content).digest("hex"), tokenCount: estimateTokens(content),
      lineStart: start + 1, lineEnd: end,
    });
    if (end >= lines.length) break;
    let rewind = 0;
    let cursor = end - 1;
    while (cursor > start && rewind < overlapChars) { rewind += lines[cursor]!.length + 1; cursor -= 1; }
    start = Math.max(start + 1, cursor + 1);
  }
  return chunks;
}

async function extractPdf(bytes: Buffer): Promise<string> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
  const document = await task.promise;
  try {
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items.flatMap((item) => "str" in item && typeof item.str === "string" ? [item.str] : []).join(" ").trim();
      if (text) pages.push(`# Page ${pageNumber}\n${text}`);
      page.cleanup();
    }
    return pages.join("\n\n");
  } finally { await task.destroy(); }
}

async function extractDocx(bytes: Buffer): Promise<string> {
  const module = await import("mammoth");
  const mammoth = module.default ?? module;
  const result = await mammoth.extractRawText({ buffer: bytes });
  return result.value;
}

/** Parse binary office documents before applying the same deterministic chunker. */
export async function parseKnowledgeFile(file: string, bytes: Buffer, chunkTokens: number, overlapTokens: number): Promise<ParsedKnowledgeChunk[]> {
  const extension = path.extname(file).toLowerCase();
  if (TEXT_EXTENSIONS.has(extension)) return parseKnowledgeText(file, bytes, chunkTokens, overlapTokens);
  const extracted = extension === ".pdf" ? await extractPdf(bytes) : extension === ".docx" ? await extractDocx(bytes) : "";
  if (!extracted.trim()) throw new Error(`No extractable text was found in '${path.basename(file)}'.`);
  return parseKnowledgeText("extracted.md", Buffer.from(extracted), chunkTokens, overlapTokens);
}
