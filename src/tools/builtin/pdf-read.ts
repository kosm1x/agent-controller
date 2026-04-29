/**
 * PDF read tool — extracts and intelligently serves PDF content.
 *
 * Short PDFs (≤10K chars): returns full content inline.
 * Long PDFs (>10K chars): saves to temp file, returns preview + path.
 *   - With `query`: keyword-searches the full text and returns matching sections.
 *   - Without `query`: returns first ~2K chars + metadata for LLM to use file_read.
 *
 * Supports both URLs and local file paths.
 * Uses existing @opendataloader/pdf (Java 17) for extraction.
 */

import { writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Tool } from "../types.js";
import { extractPdfToMarkdown, extractPdfFromUrl } from "../../lib/pdf.js";
import { validateOutboundUrl } from "../../lib/url-safety.js";
import { validatePathSafety } from "./immutable-core.js";

const INLINE_THRESHOLD = 10_000; // chars — return full content if under this
const PREVIEW_CHARS = 2_000; // chars of preview for long PDFs
const QUERY_RESULT_CHARS = 8_000; // max chars returned for query matches
const EXTRACT_MAX_CHARS = 200_000; // generous limit for full extraction to file

/**
 * Simple keyword search: score paragraphs by how many query words they contain.
 * Returns top-scoring paragraphs up to maxChars.
 */
function searchContent(
  content: string,
  query: string,
  maxChars: number,
): { matches: string; matchCount: number } {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);
  if (words.length === 0) {
    return { matches: content.slice(0, maxChars), matchCount: 0 };
  }

  // Split into paragraphs (double newline or heading boundaries)
  const paragraphs = content.split(/\n{2,}|\n(?=#)/).filter((p) => p.trim());

  const scored = paragraphs.map((p) => {
    const lower = p.toLowerCase();
    const score = words.reduce(
      (sum, w) => sum + (lower.includes(w) ? 1 : 0),
      0,
    );
    return { text: p.trim(), score };
  });

  // Keep only paragraphs that match at least one word, sorted by score desc
  const hits = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (hits.length === 0) {
    return { matches: "", matchCount: 0 };
  }

  // Accumulate top hits up to maxChars
  let result = "";
  let count = 0;
  for (const hit of hits) {
    if (result.length + hit.text.length + 4 > maxChars) break;
    result += hit.text + "\n\n";
    count++;
  }

  return { matches: result.trimEnd(), matchCount: count };
}

export const pdfReadTool: Tool = {
  name: "pdf_read",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "pdf_read",
      description: `Read and extract content from a PDF file. Returns clean Markdown.

USE WHEN:
- The user shares a PDF URL or sends a PDF file and wants you to read, summarize, or answer questions about it
- You need to extract specific information from a PDF (use the 'query' parameter)
- You need to read specific pages from a large PDF (use the 'pages' parameter)
- The user says "lee este PDF", "qué dice este documento", "resume este PDF"

DO NOT USE WHEN:
- The URL is a regular web page, not a PDF (use web_read instead)
- You already have the PDF content from a previous tool call

BEHAVIOR:
- Short PDFs (under ~10K chars): full content returned inline
- Long PDFs: content saved to a temp file. Use file_read with the returned 'file' path to read specific sections
- With 'query': searches the full PDF and returns the most relevant sections (no need for file_read)
- With 'pages': extracts only the requested page range (faster, less content)

TIPS:
- For a quick overview of a long PDF: call with pages="1-3" first
- To find specific info in a long PDF: use the query parameter
- To read a long PDF section by section: use file_read with the returned file path`,
      parameters: {
        type: "object",
        properties: {
          source: {
            type: "string",
            description:
              "URL to a PDF file (https://...) or local file path (/path/to/file.pdf)",
          },
          pages: {
            type: "string",
            description:
              'Page range to extract, e.g. "1-5", "3,7,10-15". Default: all pages',
          },
          query: {
            type: "string",
            description:
              "Search query to find relevant sections in the PDF. Returns matching paragraphs ranked by relevance",
          },
        },
        required: ["source"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const source = args.source as string;
    if (!source) {
      return JSON.stringify({ error: "source is required" });
    }

    const pages = args.pages as string | undefined;
    const query = args.query as string | undefined;

    try {
      // Extract PDF content
      const isUrl =
        source.startsWith("http://") || source.startsWith("https://");
      let content: string;

      if (isUrl) {
        // Sec1 round-2 fix: validate outbound URL (SSRF guard)
        const urlError = validateOutboundUrl(source);
        if (urlError) {
          return JSON.stringify({ error: `Blocked source URL: ${urlError}` });
        }
        content = await extractPdfFromUrl(source, {
          pages,
          maxChars: EXTRACT_MAX_CHARS,
          timeoutMs: 30_000,
        });
      } else {
        // Sec2 round-2 fix: validate local path (read-denylist guard)
        const safety = validatePathSafety(source, "read");
        if (!safety.safe) {
          return JSON.stringify({ error: `Read blocked: ${safety.reason}` });
        }
        if (!existsSync(source)) {
          return JSON.stringify({ error: `File not found: ${source}` });
        }
        content = await extractPdfToMarkdown(source, {
          pages,
          maxChars: EXTRACT_MAX_CHARS,
        });
      }

      const totalChars = content.length;

      // Image-only PDF detected: 0 extractable chars. Teach the LLM the next
      // step explicitly — this is the poka-yoke pattern from feedback_aci_*.
      // Without this hint Jarvis runs the chain pdf_read → screenshot → vision
      // → playwright → drive thumbnails and dead-ends on each (Session 114).
      if (totalChars === 0) {
        return JSON.stringify({
          source,
          content: "",
          chars: 0,
          truncated: false,
          imageOnly: true,
          hint: "PDF contains 0 extractable text characters — likely image-only or scan. For visual analysis: call gemini_upload with this same source path, then call gemini_research with your question. Gemini's vision API reads slide images, diagrams, and scanned text directly.",
        });
      }

      // Short PDF: return everything inline
      if (totalChars <= INLINE_THRESHOLD) {
        return JSON.stringify({
          source,
          content,
          chars: totalChars,
          truncated: false,
        });
      }

      // Long PDF: save full content to temp file
      const filePath = join(
        tmpdir(),
        `pdf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`,
      );
      await writeFile(filePath, content, "utf-8");

      // With query: search and return relevant sections
      if (query) {
        const { matches, matchCount } = searchContent(
          content,
          query,
          QUERY_RESULT_CHARS,
        );

        if (matchCount === 0) {
          return JSON.stringify({
            source,
            chars: totalChars,
            file: filePath,
            query,
            matches: 0,
            content: content.slice(0, PREVIEW_CHARS),
            note: `No matches for "${query}". Preview shown. Use file_read with the 'file' path to browse the full content.`,
          });
        }

        return JSON.stringify({
          source,
          chars: totalChars,
          file: filePath,
          query,
          matches: matchCount,
          content: matches,
          note:
            matchCount > 5
              ? `Showing top ${matchCount} matching sections. Use file_read with the 'file' path for full content.`
              : undefined,
        });
      }

      // No query: return preview + file path
      return JSON.stringify({
        source,
        chars: totalChars,
        file: filePath,
        content: content.slice(0, PREVIEW_CHARS),
        note: `PDF is ${totalChars} chars. Full content saved to file. Use file_read with path "${filePath}" to read specific sections.`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: `PDF read failed: ${message}`, source });
    }
  },
};
