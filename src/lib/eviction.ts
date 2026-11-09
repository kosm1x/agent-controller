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
import { join, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";

// Outside the read-blocked mission-control data tree so file_read can open
// what the preview points at; under root-owned /root so no other account can
// create or redirect it. MC_TOOL_RESULTS_DIR is an override (used by tests).
const DEFAULT_EVICT_DIR = "/root/claude/mission-control/tool-results";
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
    const dir = getEvictDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const suffix = randomBytes(4).toString("hex");
    filePath = join(dir, `${filenamePrefix}-${Date.now()}-${suffix}.txt`);
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
    `\nUse file_read(path="${filePath}") to read specific sections (the file is kept for about one hour).` +
    toc;

  return { preview, filePath };
}

/** The directory evicted tool results are written to. */
export function getEvictDir(): string {
  return process.env.MC_TOOL_RESULTS_DIR || DEFAULT_EVICT_DIR;
}

/**
 * True when `path` is lexically inside the eviction directory (no symlink
 * resolution; the read itself is judged by the read guard on the
 * kernel-resolved path).
 */
export function isEvictedPath(path: string): boolean {
  return resolve(path).startsWith(resolve(getEvictDir()) + sep);
}

/**
 * Check if a tool result already contains a file eviction path.
 * Used by adapter.ts to skip double-eviction when web_read already evicted.
 * The old data/tool-results/ spelling stays recognised for conversations
 * that still carry a path from before the move. A file_read result that
 * echoes a path in the eviction directory also matches, so a large `lines=`
 * slice of a spilled file is passed whole instead of being spilled again.
 */
export function hasEvictedPath(result: string): boolean {
  return (
    result.includes("full_content_path") ||
    result.includes(resolve(getEvictDir()) + "/") ||
    result.includes("data/tool-results/")
  );
}

/** Remove eviction files older than MAX_AGE_MS. */
function cleanupOldFiles(): void {
  try {
    const dir = getEvictDir();
    const files = readdirSync(dir);
    const now = Date.now();
    for (const file of files) {
      try {
        const fullPath = join(dir, file);
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
