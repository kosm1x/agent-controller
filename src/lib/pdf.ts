/**
 * Local PDF extraction via OpenDataLoader PDF.
 *
 * Converts PDF files to Markdown using a local Java-based parser.
 * No external API calls, no rate limits, no truncation (unless maxChars set).
 * Requires Java 17+ on PATH.
 * Optional: `pdftotext` (poppler-utils) is the fallback for PDFs the filtered
 * pass reads as empty; without it the slower ODL tiny-filter pass is used.
 */

import { convert } from "@opendataloader/pdf";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "node:util";
import { safeFetch } from "./url-safety.js";

const DEFAULT_MAX_CHARS = 50_000;
const execFileAsync = promisify(execFile);

/**
 * Plain text via poppler's pdftotext (no shell, argv array). One call per
 * comma-separated range of `pages`; a range that is not `N` or `N-M`, or more
 * than 20 ranges, skips pdftotext and returns "".
 */
async function pdftotext(pdfPath: string, pages?: string): Promise<string> {
  const parts = pages ? pages.split(",") : [];
  if (parts.length > 20) return "";
  const ranges: string[][] = [];
  for (const part of parts) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) return "";
    ranges.push(["-f", m[1], "-l", m[2] ?? m[1]]);
  }
  let text = "";
  for (const range of ranges.length ? ranges : [[]]) {
    const { stdout } = await execFileAsync(
      "pdftotext",
      ["-q", "-enc", "UTF-8", ...range, "--", pdfPath, "-"],
      { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 },
    );
    text += stdout;
  }
  return text;
}

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
    // discarded wholesale by ODL's "tiny" text filter, so the default pass can
    // return nothing; with that filter off ODL returns the text out of order,
    // while pdftotext reads it correctly. pdftotext applies no hidden-text
    // filter, so it runs only when the fully filtered pass found nothing.
    // If it is missing, fails or is empty, retry ODL with only the tiny filter
    // off (hidden-text and off-page stay on as a prompt-injection defence). A
    // failed retry keeps the empty result: callers report an image-only PDF.
    if (!content.trim()) {
      const text = await pdftotext(pdfPath, opts?.pages).catch(() => "");
      content = text.trim() ? text : await runPass("tiny").catch(() => content);
    }

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
