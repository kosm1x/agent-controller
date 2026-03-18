/**
 * SQLite memory backend — conversations table + learnings table.
 *
 * Maps the MemoryService interface to SQLite tables:
 * - conversations: bank/tags-aware storage for conversation memory
 * - learnings: legacy operational learnings (Prometheus reflections)
 *
 * No semantic search — recall returns recent matches filtered by bank/tags.
 */

import { getDatabase } from "../db/index.js";
import type {
  MemoryService,
  MemoryItem,
  RetainOptions,
  RecallOptions,
  ReflectOptions,
} from "./types.js";

/** Extract meaningful keywords from a query string for SQLite LIKE matching. */
function extractKeywords(query: string): string[] {
  const stopWords = new Set([
    "el",
    "la",
    "los",
    "las",
    "un",
    "una",
    "de",
    "del",
    "en",
    "con",
    "por",
    "para",
    "que",
    "es",
    "y",
    "o",
    "a",
    "al",
    "se",
    "no",
    "su",
    "mi",
    "me",
    "the",
    "a",
    "an",
    "is",
    "are",
    "was",
    "in",
    "on",
    "of",
    "and",
    "or",
    "to",
    "for",
    "it",
    "at",
    "by",
    "do",
    "be",
    "he",
    "she",
    "we",
    "you",
    "what",
    "how",
    "who",
    "when",
    "where",
    "this",
    "that",
    "my",
    "your",
    "user",
    "jarvis",
    "fede",
  ]);

  return query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !stopWords.has(w))
    .slice(0, 6); // Cap at 6 keywords to keep queries fast
}

export class SqliteMemoryBackend implements MemoryService {
  readonly backend = "sqlite" as const;

  async retain(content: string, options: RetainOptions): Promise<void> {
    try {
      const db = getDatabase();
      const tags = JSON.stringify(options.tags ?? []);
      db.prepare(
        "INSERT INTO conversations (bank, tags, content) VALUES (?, ?, ?)",
      ).run(options.bank, tags, content);
    } catch {
      // DB may not be initialized in tests — best-effort
    }
  }

  async recall(query: string, options: RecallOptions): Promise<MemoryItem[]> {
    try {
      const db = getDatabase();
      const limit = options.maxResults ?? 10;

      // Extract keywords from query for relevance matching
      const keywords = extractKeywords(query);
      const hasKeywords = keywords.length > 0;

      // Build tag filter clause
      let tagClause = "";
      const tagParams: string[] = [];
      if (options.tags && options.tags.length > 0) {
        const placeholders = options.tags.map(() => "?").join(",");
        tagClause = `AND EXISTS (SELECT 1 FROM json_each(tags) je WHERE je.value IN (${placeholders}))`;
        tagParams.push(...options.tags);
      }

      if (hasKeywords) {
        // Keyword-matched recall: prioritize rows that match query terms,
        // then fall back to recent rows to fill the limit.
        const likeConditions = keywords
          .map(() => "content LIKE ?")
          .join(" OR ");
        const likeParams = keywords.map((k) => `%${k}%`);

        // First: rows matching keywords (scored by match count, then recency)
        const matchSql = `
          SELECT content, created_at,
            (${keywords.map(() => "CASE WHEN content LIKE ? THEN 1 ELSE 0 END").join(" + ")}) AS score
          FROM conversations
          WHERE bank = ? ${tagClause}
            AND (${likeConditions})
          ORDER BY score DESC, created_at DESC
          LIMIT ?
        `;
        const matchParams = [
          ...likeParams, // for score calculation
          options.bank,
          ...tagParams,
          ...likeParams, // for WHERE filter
          limit,
        ];
        const matched = db.prepare(matchSql).all(...matchParams) as Array<{
          content: string;
          created_at: string;
          score: number;
        }>;

        if (matched.length >= limit) {
          return matched.map((r) => ({
            content: r.content,
            createdAt: r.created_at,
          }));
        }

        // Fill remaining slots with most recent (non-duplicate)
        const remaining = limit - matched.length;
        const matchedContents = new Set(matched.map((r) => r.content));
        const recentSql = `
          SELECT content, created_at FROM conversations
          WHERE bank = ? ${tagClause}
          ORDER BY created_at DESC
          LIMIT ?
        `;
        const recentRows = db
          .prepare(recentSql)
          .all(
            options.bank,
            ...tagParams,
            remaining + matched.length,
          ) as Array<{
          content: string;
          created_at: string;
        }>;

        const filler = recentRows
          .filter((r) => !matchedContents.has(r.content))
          .slice(0, remaining);

        const combined = [...matched, ...filler];
        // Sort chronologically for natural reading order
        combined.sort(
          (a, b) =>
            new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
        );
        return combined.map((r) => ({
          content: r.content,
          createdAt: r.created_at,
        }));
      }

      // No keywords — fall back to recency-only
      const sql = `
        SELECT content, created_at FROM conversations
        WHERE bank = ? ${tagClause}
        ORDER BY created_at DESC
        LIMIT ?
      `;
      const rows = db
        .prepare(sql)
        .all(options.bank, ...tagParams, limit) as Array<{
        content: string;
        created_at: string;
      }>;
      return rows.reverse().map((r) => ({
        content: r.content,
        createdAt: r.created_at,
      }));
    } catch {
      return [];
    }
  }

  async reflect(_query: string, _options: ReflectOptions): Promise<string> {
    // SQLite backend doesn't support synthesis
    return "";
  }

  async isHealthy(): Promise<boolean> {
    try {
      getDatabase();
      return true;
    } catch {
      return false;
    }
  }
}
