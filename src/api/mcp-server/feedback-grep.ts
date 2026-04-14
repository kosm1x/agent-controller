/**
 * Feedback grep helper — reads `feedback_*.md` files from the memory
 * directory and returns substring matches with context snippets.
 *
 * Kept separate from tools.ts so it can be tested without spinning up
 * the full MCP server. Simple substring match (case-insensitive), no
 * FTS5 — the corpus is ~80 files and grows slowly, so walk+grep is
 * plenty fast. If it ever matters, cache file list with mtime check.
 */

import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

const DEFAULT_MEMORY_DIR = "/root/.claude/projects/-root-claude/memory";
const MAX_FILES = 500;
const SNIPPET_CHARS = 160;

export interface FeedbackMatch {
  file: string;
  matchCount: number;
  snippet: string;
}

export interface FeedbackSearchOptions {
  query: string;
  limit?: number;
  memoryDir?: string;
}

/**
 * Search `feedback_*.md` files for a case-insensitive substring.
 * Returns up to `limit` matches (default 10), ordered by match count desc.
 */
export function searchFeedback(
  options: FeedbackSearchOptions,
): FeedbackMatch[] {
  const query = options.query.toLowerCase();
  const limit = options.limit ?? 10;
  const memoryDir = options.memoryDir ?? DEFAULT_MEMORY_DIR;

  if (query.length === 0) return [];

  let entries: string[];
  try {
    entries = readdirSync(memoryDir);
  } catch {
    return [];
  }

  // v7.7.1 M4 fix: resolve memoryDir to a real path once and confine all
  // file reads to its subtree. Use lstat (never stat) so symlinks are
  // detected and refused — a symlink inside the memory dir pointing at
  // /etc/shadow or ~/.aws/credentials must not be followed. Combined with
  // the startsWith("feedback_") filename filter, this closes the
  // "confined-directory read" escape path.
  let memoryRoot: string;
  try {
    memoryRoot = realpathSync(resolve(memoryDir));
  } catch {
    return [];
  }

  const candidates = entries
    .filter((name) => name.startsWith("feedback_") && name.endsWith(".md"))
    .slice(0, MAX_FILES);

  const matches: FeedbackMatch[] = [];
  for (const name of candidates) {
    const path = join(memoryRoot, name);
    let content: string;
    try {
      // lstat — do not follow symlinks. A symlink (even to a regular file)
      // is refused because it could escape the memoryRoot confinement.
      const stat = lstatSync(path);
      if (!stat.isFile()) continue; // symlinks return false for isFile()
      // Defense-in-depth: verify the realpath is still inside memoryRoot
      // before reading. Guards against TOCTOU if the directory is modified
      // between readdirSync and lstatSync.
      const real = realpathSync(path);
      if (real !== path && !real.startsWith(memoryRoot + "/")) continue;
      content = readFileSync(path, "utf-8");
    } catch {
      continue;
    }

    const lower = content.toLowerCase();
    let matchCount = 0;
    let fromIndex = 0;
    let firstMatchIndex = -1;

    while (true) {
      const idx = lower.indexOf(query, fromIndex);
      if (idx === -1) break;
      if (firstMatchIndex === -1) firstMatchIndex = idx;
      matchCount++;
      fromIndex = idx + query.length;
    }

    if (matchCount > 0 && firstMatchIndex >= 0) {
      const start = Math.max(
        0,
        firstMatchIndex - Math.floor(SNIPPET_CHARS / 2),
      );
      const end = Math.min(
        content.length,
        firstMatchIndex + query.length + Math.floor(SNIPPET_CHARS / 2),
      );
      const snippet = content.slice(start, end).replace(/\s+/g, " ").trim();
      matches.push({
        file: name,
        matchCount,
        snippet:
          (start > 0 ? "…" : "") + snippet + (end < content.length ? "…" : ""),
      });
    }
  }

  matches.sort((a, b) => b.matchCount - a.matchCount);
  return matches.slice(0, limit);
}
