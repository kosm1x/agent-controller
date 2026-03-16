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

  async recall(_query: string, options: RecallOptions): Promise<MemoryItem[]> {
    try {
      const db = getDatabase();
      const limit = options.maxResults ?? 10;

      // Filter by bank; optionally filter by tags overlap
      if (options.tags && options.tags.length > 0) {
        // Match rows where any requested tag appears in stored tags JSON array
        const placeholders = options.tags.map(() => "?").join(",");
        const sql = `
          SELECT content, created_at FROM conversations
          WHERE bank = ?
            AND EXISTS (
              SELECT 1 FROM json_each(tags) je
              WHERE je.value IN (${placeholders})
            )
          ORDER BY created_at DESC
          LIMIT ?
        `;
        const rows = db
          .prepare(sql)
          .all(options.bank, ...options.tags, limit) as Array<{
          content: string;
          created_at: string;
        }>;
        return rows.reverse().map((r) => ({
          content: r.content,
          createdAt: r.created_at,
        }));
      }

      // Bank-only filter
      const rows = db
        .prepare(
          "SELECT content, created_at FROM conversations WHERE bank = ? ORDER BY created_at DESC LIMIT ?",
        )
        .all(options.bank, limit) as Array<{
        content: string;
        created_at: string;
      }>;
      // Reverse so oldest first → natural conversation order
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
