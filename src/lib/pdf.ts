/**
 * Local PDF extraction via OpenDataLoader PDF.
 *
 * Converts PDF files to Markdown using a local Java-based parser.
 * No external API calls, no rate limits, no truncation (unless maxChars set).
 * Requires Java 17+ on PATH.
 */

import { convert } from "@opendataloader/pdf";
import { mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { safeFetch } from "./url-safety.js";

const DEFAULT_MAX_CHARS = 50_000;

export interface PdfExtractOptions {
  /** Page range, e.g. "1,3,5-7". Default: all pages. */
  pages?: string;
  /** Max characters to return. Default: 50000. */
  maxChars?: number;
}

/**
 * Extract a local PDF file to Markdown.
 * Returns the Markdown content string.
 */
export async function extractPdfToMarkdown(
  pdfPath: string,
  opts?: PdfExtractOptions,
): Promise<string> {
  const outDirs: string[] = [];
  const runPass = async (contentSafetyOff?: string): Promise<string> => {
    const outDir = await mkdtemp(join(tmpdir(), "odl-pdf-"));
    outDirs.push(outDir);
    await convert([pdfPath], {
      outputDir: outDir,
      format: "markdown",
      imageOutput: "off",
      quiet: true,
      ...(opts?.pages && { pages: opts.pages }),
      ...(contentSafetyOff && { contentSafetyOff }),
    });

    // Find the generated .md file
    const files = await readdir(outDir);
    const mdFile = files.find((f) => f.endsWith(".md"));
    if (!mdFile) {
      throw new Error("PDF extraction produced no Markdown output");
    }
    return readFile(join(outDir, mdFile), "utf-8");
  };

  try {
    let content = await runPass();
    // Text drawn with Type 3 fonts on a large canvas (e.g. slide decks) is
    // discarded wholesale by the "tiny" text filter, so the default pass can
    // return nothing. Retry with only that filter off; the hidden-text and
    // off-page filters stay on as a prompt-injection defence. A failed retry
    // keeps the empty result, which callers report as an image-only PDF.
    if (!content.trim()) content = await runPass("tiny").catch(() => content);

    const max = opts?.maxChars ?? DEFAULT_MAX_CHARS;
    if (content.length > max) {
      content =
        content.slice(0, max) +
        `\n\n...(truncated, ${content.length} total chars)`;
    }

    return content;
  } finally {
    for (const dir of outDirs) {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/**
 * Download a URL to a temp file, extract PDF to Markdown, clean up.
 * Used by both web-read and telegram handlers.
 */
export async function extractPdfFromUrl(
  url: string,
  opts?: PdfExtractOptions & { timeoutMs?: number },
): Promise<string> {
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const tmpDir = await mkdtemp(join(tmpdir(), "odl-dl-"));
  const tmpPath = join(tmpDir, "download.pdf");

  try {
    const response = await safeFetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(tmpPath, buffer);

    return await extractPdfToMarkdown(tmpPath, opts);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
