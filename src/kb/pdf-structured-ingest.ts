/**
 * v7.13 Structured PDF ingestion — Option B (MinerU deferred).
 *
 * Uses the existing @opendataloader/pdf markdown extractor and produces
 * KbEntry[] with modality tags (text | table) plus hierarchical metadata
 * (parent_doc_id, section_path, chunk_position). Feeds pgvector via
 * kb_ingest_pdf_structured tool.
 *
 * Design (see docs/planning/phase-beta/18-v7.13-impl-plan.md):
 *  - Sectionize by markdown heading stack (#, ##, ### etc.)
 *  - Detect tables via pipe-format (≥3 rows with a separator line)
 *  - Text modality: chunks up to ~1500 chars at paragraph / sentence boundaries
 *  - Table modality: one table = one chunk (preserves structure)
 *  - Caps at max_chunks (default 500) for pathological inputs
 */

import { randomUUID } from "crypto";
import { basename, extname } from "path";
import { extractPdfToMarkdown } from "../lib/pdf.js";
import type { KbEntry } from "../db/pgvector.js";

export type ChunkModality = "text" | "table";

export interface IngestOptions {
  /** Override parent doc UUID. Auto-generated if absent. */
  parentDocId?: string;
  /** Namespace prefix for chunk paths. Default "pdf-ingest". */
  namespace?: string;
  /** Max chunks produced from one PDF. Default 500. */
  maxChunks?: number;
  /** Tags applied to every chunk. */
  tags?: string[];
  /** Override title used for the parent-doc label. Default: PDF filename. */
  docTitle?: string;
  /** Max chars fed to the extractor. Default 500_000 (large enough for 100+ pages). */
  pdfMaxChars?: number;
}

export interface IngestResult {
  parentDocId: string;
  docTitle: string;
  chunks: KbEntry[];
  counts: {
    text: number;
    table: number;
    sections: number;
    truncated: boolean;
  };
  largestTable?: { chars: number; sectionPath: string[] };
}

const DEFAULT_MAX_CHUNKS = 500;
const DEFAULT_PDF_MAX_CHARS = 500_000;
const CHUNK_CHAR_LIMIT = 1500;
const TABLE_MAX_CHARS = 8000;

// ---------------------------------------------------------------------------
// Public: full pipeline
// ---------------------------------------------------------------------------

export async function ingestPdf(
  pdfPath: string,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const markdown = await extractPdfToMarkdown(pdfPath, {
    maxChars: opts.pdfMaxChars ?? DEFAULT_PDF_MAX_CHARS,
  });
  return structureMarkdown(markdown, pdfPath, opts);
}

/**
 * Pure transform — exposed for tests and for callers that already have
 * markdown in hand. The whole pipeline except the filesystem hop.
 */
export function structureMarkdown(
  markdown: string,
  pdfPath: string,
  opts: IngestOptions = {},
): IngestResult {
  const parentDocId = opts.parentDocId ?? randomUUID();
  const namespace = opts.namespace ?? "pdf-ingest";
  const maxChunks = opts.maxChunks ?? DEFAULT_MAX_CHUNKS;
  const docTitle = opts.docTitle ?? defaultDocTitle(pdfPath);
  const docSlug = slugify(basename(pdfPath, extname(pdfPath)) || "doc");

  const blocks = sectionizeAndExtract(markdown);

  const chunks: KbEntry[] = [];
  let position = 0;
  let sectionCount = 0;
  let textCount = 0;
  let tableCount = 0;
  let truncated = false;
  let largestTable: { chars: number; sectionPath: string[] } | undefined;
  const seenSections = new Set<string>();

  for (const block of blocks) {
    if (chunks.length >= maxChunks) {
      truncated = true;
      break;
    }
    const pathKey = block.sectionPath.join("/");
    if (!seenSections.has(pathKey)) {
      seenSections.add(pathKey);
      sectionCount++;
    }

    if (block.kind === "table") {
      // One chunk per table (no splitting)
      const content = block.content;
      const chars = content.length;
      if (chars > TABLE_MAX_CHARS) {
        // Oversize — still ingest but flag via an extra tag
      }
      if (!largestTable || chars > largestTable.chars) {
        largestTable = { chars, sectionPath: block.sectionPath };
      }
      chunks.push(
        makeChunk({
          parentDocId,
          namespace,
          docSlug,
          sectionPath: block.sectionPath,
          position,
          modality: "table",
          title: buildChunkTitle(docTitle, block.sectionPath, "table"),
          content,
          tags: [
            ...(opts.tags ?? []),
            "pdf",
            "table",
            ...(chars > TABLE_MAX_CHARS ? ["oversize-table"] : []),
          ],
        }),
      );
      position++;
      tableCount++;
      continue;
    }

    // Text block — chunk into ~1500-char pieces at paragraph/sentence boundaries
    const pieces = chunkText(block.content, CHUNK_CHAR_LIMIT);
    for (const piece of pieces) {
      if (chunks.length >= maxChunks) {
        truncated = true;
        break;
      }
      chunks.push(
        makeChunk({
          parentDocId,
          namespace,
          docSlug,
          sectionPath: block.sectionPath,
          position,
          modality: "text",
          title: buildChunkTitle(docTitle, block.sectionPath, "text"),
          content: piece,
          tags: [...(opts.tags ?? []), "pdf", "text"],
        }),
      );
      position++;
      textCount++;
    }
  }

  return {
    parentDocId,
    docTitle,
    chunks,
    counts: {
      text: textCount,
      table: tableCount,
      sections: sectionCount,
      truncated,
    },
    largestTable,
  };
}

// ---------------------------------------------------------------------------
// Internals (exported for unit tests)
// ---------------------------------------------------------------------------

interface StructuredBlock {
  kind: "text" | "table";
  content: string;
  sectionPath: string[];
}

/**
 * Walk the markdown lines, track heading stack, emit blocks grouped by
 * section. Tables are emitted as distinct blocks within their containing
 * section; adjacent paragraphs merge into a single text block.
 */
export function sectionizeAndExtract(markdown: string): StructuredBlock[] {
  const lines = markdown.split(/\r?\n/);
  const blocks: StructuredBlock[] = [];
  const stack: { level: number; title: string }[] = [];

  let i = 0;
  let currentText = "";

  const flushText = () => {
    const trimmed = currentText.trim();
    if (trimmed.length > 0) {
      blocks.push({
        kind: "text",
        content: trimmed,
        sectionPath: stack.map((s) => s.title),
      });
    }
    currentText = "";
  };

  while (i < lines.length) {
    const line = lines[i];
    const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (headingMatch) {
      flushText();
      const level = headingMatch[1].length;
      const title = headingMatch[2].trim();
      // Pop to the same or higher-level heading (replacement at same depth)
      while (stack.length > 0 && stack[stack.length - 1].level >= level) {
        stack.pop();
      }
      stack.push({ level, title });
      i++;
      continue;
    }

    // Table detection: ≥3 consecutive `|`-rows with 2nd row being a separator
    if (looksLikeTableStart(lines, i)) {
      flushText();
      const { content, consumed } = consumeTable(lines, i);
      blocks.push({
        kind: "table",
        content,
        sectionPath: stack.map((s) => s.title),
      });
      i += consumed;
      continue;
    }

    // Accumulate text
    currentText += (currentText ? "\n" : "") + line;
    i++;
  }
  flushText();
  return blocks;
}

export function looksLikeTableStart(lines: string[], i: number): boolean {
  if (i + 2 >= lines.length) return false;
  const l0 = lines[i].trim();
  const l1 = lines[i + 1].trim();
  const l2 = lines[i + 2].trim();
  if (!isPipeRow(l0) || !isPipeRow(l1) || !isPipeRow(l2)) return false;
  return isSeparatorRow(l1);
}

function isPipeRow(line: string): boolean {
  return line.startsWith("|") && (line.match(/\|/g)?.length ?? 0) >= 2;
}

function isSeparatorRow(line: string): boolean {
  // Typical separator: | --- | :---: | ---: |
  const cells = line.slice(1, -1).split("|");
  if (cells.length < 2) return false;
  return cells.every((cell) => /^\s*:?-+:?\s*$/.test(cell));
}

function consumeTable(
  lines: string[],
  start: number,
): { content: string; consumed: number } {
  const rows: string[] = [];
  let j = start;
  while (j < lines.length && isPipeRow(lines[j].trim())) {
    rows.push(lines[j]);
    j++;
  }
  return { content: rows.join("\n"), consumed: rows.length };
}

/**
 * Split a long text block into ~limit-char pieces. Splits on double-newline
 * first (paragraph boundaries), then sentence boundaries for paragraphs that
 * exceed the limit on their own.
 */
export function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const paragraphs = text.split(/\n\s*\n/);
  const pieces: string[] = [];
  let current = "";

  const pushWithHardSlice = (buf: string) => {
    // Audit C1: guarantee no chunk exceeds limit. Sentence splitter misses
    // CJK punctuation + paragraphs without Latin sentence terminators; hard-
    // slice fallback preserves the invariant.
    let rest = buf.trim();
    while (rest.length > limit) {
      pieces.push(rest.slice(0, limit));
      rest = rest.slice(limit);
    }
    if (rest.length > 0) pieces.push(rest);
  };

  for (const para of paragraphs) {
    if (para.length > limit) {
      if (current.length > 0) {
        pushWithHardSlice(current);
        current = "";
      }
      const sentences = para.split(/(?<=[.!?。！?])\s*(?=\S)/);
      let sBuf = "";
      for (const sentence of sentences) {
        if (sBuf.length + sentence.length + 1 > limit && sBuf.length > 0) {
          pushWithHardSlice(sBuf);
          sBuf = "";
        }
        sBuf += (sBuf ? " " : "") + sentence;
      }
      if (sBuf.trim().length > 0) pushWithHardSlice(sBuf);
      continue;
    }
    if (current.length + para.length + 2 > limit && current.length > 0) {
      pushWithHardSlice(current);
      current = "";
    }
    current += (current ? "\n\n" : "") + para;
  }
  if (current.trim().length > 0) pushWithHardSlice(current);
  return pieces;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "doc"
  );
}

function buildChunkTitle(
  docTitle: string,
  sectionPath: string[],
  modality: ChunkModality,
): string {
  const sectionSuffix =
    sectionPath.length > 0 ? ` — ${sectionPath.join(" / ")}` : "";
  const modalityTag = modality === "table" ? " (table)" : "";
  return `${docTitle}${sectionSuffix}${modalityTag}`.slice(0, 200);
}

function buildPath(
  namespace: string,
  docSlug: string,
  sectionPath: string[],
  position: number,
): string {
  const sectionSlug = sectionPath.length
    ? sectionPath.map(slugify).join("/")
    : "root";
  const posStr = String(position).padStart(4, "0");
  return `${namespace}/${docSlug}/${sectionSlug}/${posStr}`;
}

function defaultDocTitle(pdfPath: string): string {
  return basename(pdfPath, extname(pdfPath));
}

interface MakeChunkArgs {
  parentDocId: string;
  namespace: string;
  docSlug: string;
  sectionPath: string[];
  position: number;
  modality: ChunkModality;
  title: string;
  content: string;
  tags: string[];
}

function makeChunk(a: MakeChunkArgs): KbEntry {
  return {
    path: buildPath(a.namespace, a.docSlug, a.sectionPath, a.position),
    title: a.title,
    content: a.content,
    type: "ingested",
    qualifier: "pdf",
    tags: a.tags,
    modality: a.modality,
    parent_doc_id: a.parentDocId,
    section_path: a.sectionPath,
    chunk_position: a.position,
  };
}
