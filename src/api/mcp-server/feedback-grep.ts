/**
 * Feedback grep helper — reads `feedback_*.md` files from the memory
 * directory and returns substring matches with context snippets.
 *
 * Kept separate from tools.ts so it can be tested without spinning up
 * the full MCP server. Simple substring match (case-insensitive), no
 * FTS5 — the corpus is ~80 files and grows slowly, so walk+grep is
 * plenty fast. If it ever matters, cache file list with mtime check.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

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

  const candidates = entries
    .filter((name) => name.startsWith("feedback_") && name.endsWith(".md"))
    .slice(0, MAX_FILES);

  const matches: FeedbackMatch[] = [];
  for (const name of candidates) {
    const path = join(memoryDir, name);
    let content: string;
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
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
