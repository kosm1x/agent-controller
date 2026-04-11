/**
 * Temporal Knowledge Graph — entity-relationship triples with validity windows.
 *
 * Tracks facts about entities over time: "Project X status_is Phase 3 complete"
 * with valid_from/valid_to so Jarvis can answer "what was true on date Y?"
 *
 * Adapted from mempalace's temporal KG pattern. SQLite-native, zero extra deps.
 */

import { getDatabase, writeWithRetry } from "../db/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Triple {
  id: number;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  validFrom: string;
  validTo: string | null;
  source: string;
  taskId: string | null;
  createdAt: string;
}

export interface AddTripleOptions {
  confidence?: number;
  source?: "agent" | "user" | "ritual" | "extraction";
  taskId?: string;
  /** If true, auto-invalidate prior triples with same subject+predicate. */
  supersede?: boolean;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Add a triple. By default supersedes (invalidates) prior triples with the
 * same subject+predicate, since entity state is typically latest-wins.
 */
export function addTriple(
  subject: string,
  predicate: string,
  object: string,
  opts: AddTripleOptions = {},
): number {
  const db = getDatabase();
  const { confidence = 1.0, source = "agent", taskId, supersede = true } = opts;

  // Normalize subject for consistent lookups
  const normSubject = subject.trim().toLowerCase();
  const normPredicate = predicate.trim().toLowerCase();

  // Auto-invalidate prior matching triples
  if (supersede) {
    writeWithRetry(() =>
      db
        .prepare(
          `UPDATE knowledge_triples
           SET valid_to = datetime('now')
           WHERE LOWER(subject) = ? AND LOWER(predicate) = ? AND valid_to IS NULL`,
        )
        .run(normSubject, normPredicate),
    );
  }

  const result = writeWithRetry(() =>
    db
      .prepare(
        `INSERT INTO knowledge_triples (subject, predicate, object, confidence, source, task_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        subject.trim(),
        predicate.trim(),
        object.trim(),
        confidence,
        source,
        taskId ?? null,
      ),
  );

  return (result as { lastInsertRowid: number }).lastInsertRowid;
}

/**
 * Query triples with optional filters.
 * @param asOf — ISO date string to query historical state ("what was true on this date?")
 */
export function queryTriples(opts: {
  subject?: string;
  predicate?: string;
  object?: string;
  asOf?: string;
  activeOnly?: boolean;
  limit?: number;
}): Triple[] {
  const db = getDatabase();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.subject) {
    conditions.push("LOWER(subject) = ?");
    params.push(opts.subject.trim().toLowerCase());
  }
  if (opts.predicate) {
    conditions.push("LOWER(predicate) = ?");
    params.push(opts.predicate.trim().toLowerCase());
  }
  if (opts.object) {
    conditions.push("LOWER(object) LIKE ?");
    params.push(`%${opts.object.trim().toLowerCase()}%`);
  }
  if (opts.asOf) {
    conditions.push("valid_from <= ?");
    conditions.push("(valid_to IS NULL OR valid_to > ?)");
    params.push(opts.asOf, opts.asOf);
  } else if (opts.activeOnly !== false) {
    // Default: only currently valid triples
    conditions.push("valid_to IS NULL");
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts.limit ?? 50;

  const rows = db
    .prepare(
      `SELECT id, subject, predicate, object, confidence, valid_from, valid_to, source, task_id, created_at
       FROM knowledge_triples ${where}
       ORDER BY valid_from DESC
       LIMIT ?`,
    )
    .all(...params, limit) as Array<{
    id: number;
    subject: string;
    predicate: string;
    object: string;
    confidence: number;
    valid_from: string;
    valid_to: string | null;
    source: string;
    task_id: string | null;
    created_at: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    subject: r.subject,
    predicate: r.predicate,
    object: r.object,
    confidence: r.confidence,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    source: r.source,
    taskId: r.task_id,
    createdAt: r.created_at,
  }));
}

/**
 * Invalidate a triple (set valid_to = now).
 */
export function invalidateTriple(id: number): void {
  const db = getDatabase();
  writeWithRetry(() =>
    db
      .prepare(
        "UPDATE knowledge_triples SET valid_to = datetime('now') WHERE id = ?",
      )
      .run(id),
  );
}

/**
 * Get full history for an entity — all triples (including invalidated).
 */
export function getEntityHistory(subject: string, limit = 50): Triple[] {
  return queryTriples({ subject, activeOnly: false, limit });
}

/**
 * Format triples as readable text for LLM context injection.
 */
export function formatTriples(triples: Triple[]): string {
  if (triples.length === 0) return "No known facts.";
  return triples
    .map((t) => {
      const validity = t.validTo ? ` [invalid since ${t.validTo}]` : "";
      const conf =
        t.confidence < 1.0 ? ` (confidence: ${t.confidence.toFixed(1)})` : "";
      return `• ${t.subject} → ${t.predicate} → ${t.object}${conf}${validity}`;
    })
    .join("\n");
}
