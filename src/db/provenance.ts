/**
 * Research Provenance — Layer 0 CRUD for source tracking in Prometheus tasks.
 *
 * Records which sources were consulted during research-heavy goals,
 * whether URLs were actually fetched, and their verification status.
 */

import { getDatabase } from "./index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProvenanceStatus = "verified" | "inferred" | "unverified";

export interface ProvenanceRecord {
  id: number;
  task_id: string;
  goal_id: string;
  tool_name: string;
  url: string | null;
  query: string | null;
  status: ProvenanceStatus;
  content_hash: string | null;
  snippet: string | null;
  created_at: string;
}

export interface ProvenanceStatusCounts {
  verified: number;
  inferred: number;
  unverified: number;
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/** Batch insert provenance records in a transaction. */
export function insertProvenance(
  records: Array<Omit<ProvenanceRecord, "id" | "created_at">>,
): number {
  if (records.length === 0) return 0;
  const db = getDatabase();
  const stmt = db.prepare(
    `INSERT INTO task_provenance (task_id, goal_id, tool_name, url, query, status, content_hash, snippet)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let inserted = 0;
  const tx = db.transaction(() => {
    for (const r of records) {
      const result = stmt.run(
        r.task_id,
        r.goal_id,
        r.tool_name,
        r.url,
        r.query,
        r.status,
        r.content_hash,
        r.snippet,
      );
      inserted += result.changes;
    }
  });
  tx();
  return inserted;
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

/** Get all provenance records for a task, ordered by creation time. */
export function getProvenanceByTask(taskId: string): ProvenanceRecord[] {
  const db = getDatabase();
  return db
    .prepare(
      "SELECT * FROM task_provenance WHERE task_id = ? ORDER BY created_at ASC",
    )
    .all(taskId) as ProvenanceRecord[];
}

/** Get all provenance records for a specific goal. */
export function getProvenanceByGoal(goalId: string): ProvenanceRecord[] {
  const db = getDatabase();
  return db
    .prepare(
      "SELECT * FROM task_provenance WHERE goal_id = ? ORDER BY created_at ASC",
    )
    .all(goalId) as ProvenanceRecord[];
}

/** Get unanchored URLs — records with 'unverified' status. */
export function getUnanchoredUrls(taskId: string): ProvenanceRecord[] {
  const db = getDatabase();
  return db
    .prepare(
      "SELECT * FROM task_provenance WHERE task_id = ? AND status = 'unverified' ORDER BY created_at ASC",
    )
    .all(taskId) as ProvenanceRecord[];
}

/** Count records by status for a task. */
export function countByStatus(taskId: string): ProvenanceStatusCounts {
  const db = getDatabase();
  const rows = db
    .prepare(
      "SELECT status, COUNT(*) as cnt FROM task_provenance WHERE task_id = ? GROUP BY status",
    )
    .all(taskId) as Array<{ status: ProvenanceStatus; cnt: number }>;

  const counts: ProvenanceStatusCounts = {
    verified: 0,
    inferred: 0,
    unverified: 0,
  };
  for (const row of rows) {
    counts[row.status] = row.cnt;
  }
  return counts;
}
