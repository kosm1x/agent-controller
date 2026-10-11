/**
 * Pool window for scripts/benchmark-sonnet-tier.ts: completed fast root tasks
 * created in [after ?? before − windowDays, before) (SQLite UTC text; before
 * unset = now). Takes the db handle, so the tests run it on a fixture without
 * spawning the operator-gated script.
 */

export interface PoolRow {
  task_id: string;
  title: string;
  description: string;
  metadata: string | null;
  classification: string | null;
  output: string;
  created_at: string;
}

interface Queryable {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

export function selectPoolRows(db: Queryable, after: string | undefined, before: string | undefined, windowDays: number): PoolRow[] {
  return db
    .prepare(
      `SELECT task_id, title, description, metadata, classification, output, created_at
         FROM tasks
        WHERE agent_type = 'fast' AND status IN ('completed','completed_with_concerns')
          AND spawn_type = 'root' AND output IS NOT NULL
          AND created_at >= COALESCE(?, datetime(COALESCE(?, 'now'), ?))
          AND (? IS NULL OR created_at < ?)
        ORDER BY created_at DESC, task_id ASC`,
    )
    .all(after ?? null, before ?? null, `-${windowDays} days`, before ?? null, before ?? null) as PoolRow[];
}

export function windowLabel(after: string | undefined, before: string | undefined, windowDays: number): string {
  return `created ${after ?? `${before ?? "now"} − ${windowDays}d`} → ${before ?? "now"} UTC`;
}
