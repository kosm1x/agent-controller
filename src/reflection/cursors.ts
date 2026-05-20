/**
 * Reflection cursors — bounded-diff state for the V8.1 Proactive Context
 * Engine (spec §7).
 *
 * Each reflection pass reads ONLY the events after its cursor — never "all
 * memory" (the Letta sleep-time pattern). A cursor's `last_event_id` anchors
 * on `tasks.id` (the INTEGER primary key; `task_id` is the separate TEXT
 * uuid). The scope builder (`src/reflection/scope.ts`) reads the delta
 * `tasks.id > cursor.last_event_id`; the runner advances the cursor
 * atomically once the pass succeeds.
 *
 * Three named cursors, one per reflection consumer (spec §7):
 *   - `morning_brief`            — advances on every promoted brief
 *   - `pattern_detector`         — advances on every blocker-detection pass
 *   - `general_events_discovery` — advances on every auto-discovery cron pass
 */

import { getDatabase, writeWithRetry } from "../db/index.js";

/** The named reflection cursors. A closed union — callers cannot mistype. */
export type ReflectionCursorName =
  | "morning_brief"
  | "pattern_detector"
  | "general_events_discovery";

/** Canonical cursor list — the single source of truth for `seedReflectionCursors`. */
export const REFLECTION_CURSORS: readonly ReflectionCursorName[] = [
  "morning_brief",
  "pattern_detector",
  "general_events_discovery",
] as const;

export interface ReflectionCursor {
  cursorName: ReflectionCursorName;
  /** Last `tasks.id` this cursor has processed. 0 means "nothing yet". */
  lastEventId: number;
  /** ISO timestamp of the last advance, or null for a never-advanced cursor. */
  updatedAt: string | null;
}

interface CursorRow {
  cursor_name: string;
  last_event_id: number;
  updated_at: string;
}

/**
 * Idempotently create the three named cursor rows at `last_event_id = 0`.
 * Safe to call on every startup — `INSERT OR IGNORE` leaves an advanced
 * cursor untouched. Called from `src/index.ts` so the rows are present from
 * boot (observability); `advanceCursor` also self-heals a missing row.
 */
export function seedReflectionCursors(): void {
  const db = getDatabase();
  writeWithRetry(() => {
    const stmt = db.prepare(
      "INSERT OR IGNORE INTO reflection_cursors (cursor_name, last_event_id) VALUES (?, 0)",
    );
    const seed = db.transaction((names: readonly string[]) => {
      for (const name of names) stmt.run(name);
    });
    seed(REFLECTION_CURSORS);
  });
}

/**
 * Read a cursor. An unseeded cursor reads as `{ lastEventId: 0 }` (a missing
 * row means "process from the beginning" — the scope builder bounds the read
 * by the trigger window regardless). Pure read — never writes.
 */
export function readCursor(name: ReflectionCursorName): ReflectionCursor {
  const row = getDatabase()
    .prepare(
      "SELECT cursor_name, last_event_id, updated_at FROM reflection_cursors WHERE cursor_name = ?",
    )
    .get(name) as CursorRow | undefined;
  if (!row) {
    return { cursorName: name, lastEventId: 0, updatedAt: null };
  }
  return {
    cursorName: name,
    lastEventId: row.last_event_id,
    updatedAt: row.updated_at,
  };
}

/**
 * Advance a cursor to `toEventId`.
 *
 * MONOTONIC — a cursor never moves backward. A `toEventId` less than or equal
 * to the current value is a no-op (a reflection pass that processed no new
 * events, or an out-of-order retry, must not rewind the cursor and re-surface
 * already-processed events). The advance is atomic: the row is ensured then
 * conditionally updated inside one transaction. Returns the resulting cursor.
 */
export function advanceCursor(
  name: ReflectionCursorName,
  toEventId: number,
): ReflectionCursor {
  if (!Number.isInteger(toEventId) || toEventId < 0) {
    throw new Error(
      `advanceCursor: toEventId must be a non-negative integer, got ${toEventId}`,
    );
  }
  const db = getDatabase();
  writeWithRetry(() => {
    const tx = db.transaction(() => {
      db.prepare(
        "INSERT OR IGNORE INTO reflection_cursors (cursor_name, last_event_id) VALUES (?, 0)",
      ).run(name);
      // The `last_event_id < ?` guard makes a non-advancing call a no-op.
      db.prepare(
        `UPDATE reflection_cursors
            SET last_event_id = ?, updated_at = datetime('now')
          WHERE cursor_name = ? AND last_event_id < ?`,
      ).run(toEventId, name, toEventId);
    });
    tx();
  });
  return readCursor(name);
}
