/**
 * One-time migration of SQLite learnings → Hindsight.
 *
 * Reads all rows from the learnings table, batch-retains to mc-operational,
 * and writes a migration marker. Idempotent — skips if marker exists.
 */

import type Database from "better-sqlite3";
import { getMemoryService } from "./index.js";

const MIGRATION_MARKER = "__hindsight_migration_done";

/**
 * Migrate existing SQLite learnings to Hindsight.
 * No-op if already migrated or if no learnings exist.
 */
export async function migrateLearningsToHindsight(
  db: Database.Database,
): Promise<void> {
  // Check migration marker
  try {
    const marker = db
      .prepare("SELECT content FROM learnings WHERE task_id = ? LIMIT 1")
      .get(MIGRATION_MARKER) as { content: string } | undefined;

    if (marker) {
      console.log("[memory] Migration already completed, skipping");
      return;
    }
  } catch {
    // Table may not exist
    return;
  }

  // Read all learnings
  let rows: Array<{ task_id: string; content: string; created_at: string }>;
  try {
    rows = db
      .prepare(
        "SELECT task_id, content, created_at FROM learnings ORDER BY created_at ASC",
      )
      .all() as typeof rows;
  } catch {
    return;
  }

  if (rows.length === 0) {
    console.log("[memory] No learnings to migrate");
    return;
  }

  console.log(`[memory] Migrating ${rows.length} learnings to Hindsight...`);

  const memory = getMemoryService();
  let migrated = 0;

  for (const row of rows) {
    try {
      await memory.retain(row.content, {
        bank: "mc-operational",
        tags: ["reflection", "migrated"],
        taskId: row.task_id,
        async: false, // Synchronous to ensure data reaches Hindsight
      });
      migrated++;
    } catch (err) {
      console.warn(
        `[memory] Migration failed for learning: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // Write migration marker
  try {
    db.prepare(
      "INSERT INTO learnings (task_id, content, source) VALUES (?, ?, 'migration')",
    ).run(
      MIGRATION_MARKER,
      `Migrated ${migrated}/${rows.length} learnings to Hindsight`,
    );
  } catch {
    // Best-effort
  }

  console.log(
    `[memory] Migration complete: ${migrated}/${rows.length} learnings`,
  );
}
