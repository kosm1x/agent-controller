/**
 * Tool result eviction — writes oversized content to a temp file so the LLM
 * can access it via file_read instead of losing it to truncation.
 *
 * Shared between adapter.ts (general tool results) and web-read.ts.
 */

import {
  writeFileSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const EVICT_DIR = join(process.cwd(), "data", "tool-results");
const MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_PROBABILITY = 0.1; // run cleanup ~10% of evictions to avoid I/O on every call

/**
 * Evict oversized content to a temp file. Returns a truncated preview with
 * a table of contents and a file path the LLM can use with file_read.
 *
 * On filesystem errors, falls back to simple head truncation (no file).
 */
export function evictToFile(
  content: string,
  filenamePrefix: string,
  maxPreviewChars: number,
): { preview: string; filePath: string | undefined } {
  // Probabilistic cleanup of old files
  if (Math.random() < CLEANUP_PROBABILITY) {
    cleanupOldFiles();
  }

  let filePath: string | undefined;
  try {
    mkdirSync(EVICT_DIR, { recursive: true });
    const suffix = randomBytes(4).toString("hex");
    filePath = join(EVICT_DIR, `${filenamePrefix}-${Date.now()}-${suffix}.txt`);
    writeFileSync(filePath, content, "utf-8");
  } catch {
    // Disk full or permissions error — fall back to simple truncation
    return {
      preview:
        content.slice(0, maxPreviewChars) +
        `\n\n... (${content.length} chars total — truncated, file eviction failed)`,
      filePath: undefined,
    };
  }

  // Build table of contents from markdown headings (h1-h6)
  const headings = content
    .split("\n")
    .filter((l) => /^#{1,6}\s/.test(l))
    .map((h) => h.replace(/^#+\s*/, "").trim())
    .slice(0, 30);
  const toc =
    headings.length > 0
      ? `\n\nTABLE OF CONTENTS (${headings.length} sections):\n${headings.map((h) => `- ${h}`).join("\n")}`
      : "";

  const preview =
    content.slice(0, maxPreviewChars) +
    `\n\n--- DOCUMENT TRUNCATED (${content.length} chars total) ---` +
    `\nFull content saved to: ${filePath}` +
    `\nUse file_read(path="${filePath}") to read specific sections.` +
    toc;

  return { preview, filePath };
}

/**
 * Check if a tool result already contains a file eviction path.
 * Used by adapter.ts to skip double-eviction when web_read already evicted.
 */
export function hasEvictedPath(result: string): boolean {
  return (
    result.includes("full_content_path") ||
    result.includes("data/tool-results/")
  );
}

/** Remove eviction files older than MAX_AGE_MS. */
function cleanupOldFiles(): void {
  try {
    const files = readdirSync(EVICT_DIR);
    const now = Date.now();
    for (const file of files) {
      try {
        const fullPath = join(EVICT_DIR, file);
        const stat = statSync(fullPath);
        if (now - stat.mtimeMs > MAX_AGE_MS) {
          unlinkSync(fullPath);
        }
      } catch {
        // Ignore per-file errors (already deleted, etc.)
      }
    }
  } catch {
    // Directory doesn't exist yet — nothing to clean
  }
}
