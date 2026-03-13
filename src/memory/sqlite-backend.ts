/**
 * SQLite memory backend — wraps existing learnings table.
 *
 * Maps the MemoryService interface to the flat learnings table.
 * No semantic search — recall returns recent matches, reflect is a no-op.
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
      db.prepare(
        "INSERT INTO learnings (task_id, content, source) VALUES (?, ?, 'reflection')",
      ).run(options.taskId ?? "unknown", content);
    } catch {
      // DB may not be initialized in tests — best-effort
    }
  }

  async recall(_query: string, options: RecallOptions): Promise<MemoryItem[]> {
    try {
      const db = getDatabase();
      const limit = options.maxResults ?? 10;
      const rows = db
        .prepare(
          "SELECT content, created_at FROM learnings ORDER BY created_at DESC LIMIT ?",
        )
        .all(limit) as Array<{ content: string; created_at: string }>;
      return rows.map((r) => ({
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
