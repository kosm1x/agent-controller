/**
 * Signal store — SQLite CRUD for the Intelligence Depot.
 *
 * Handles batch inserts, snapshot management, and signal queries.
 * All writes use writeWithRetry for WAL contention handling.
 */

import { getDatabase, writeWithRetry } from "../db/index.js";
import type { Signal, SignalRow, SnapshotRow } from "./types.js";
import { createHash } from "crypto";

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/**
 * Batch insert signals into the store. Returns inserted row count.
 * Deduplicates by content_hash — skips signals already present.
 */
export function insertSignals(signals: Signal[]): number {
  if (signals.length === 0) return 0;

  const db = getDatabase();

  // Counted INSIDE the retry callback: writeWithRetry re-invokes fn() on
  // SQLITE_BUSY after the tx rolls back — an outer accumulator would keep the
  // rolled-back attempt's count and double-report (pre-2026-07-05 latent bug).
  return writeWithRetry(() => {
    let inserted = 0;
    // Dedup rides the UNIQUE idx_signals_hash_uq: ON CONFLICT DO NOTHING skips
    // already-seen hashes in one statement (no per-row SELECT). Scoped to the
    // hash conflict — any other constraint violation still throws. NULL hashes
    // never conflict (SQLite NULLs are distinct), same as the old skip-if-hash
    // behavior. `changes` is 1 on insert, 0 on dedup-skip.
    const stmt = db.prepare(`
      INSERT INTO signals (source, domain, signal_type, key, value_numeric, value_text, metadata, geo_lat, geo_lon, content_hash, source_timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(content_hash) DO NOTHING
    `);

    const tx = db.transaction((batch: Signal[]) => {
      for (const s of batch) {
        inserted += stmt.run(
          s.source,
          s.domain,
          s.signalType,
          s.key,
          s.valueNumeric ?? null,
          s.valueText ?? null,
          s.metadata ? JSON.stringify(s.metadata) : null,
          s.geoLat ?? null,
          s.geoLon ?? null,
          s.contentHash ?? null,
          s.sourceTimestamp ?? null,
        ).changes;
      }
    });

    tx(signals);
    return inserted;
  });
}

/**
 * UPSERT a snapshot for delta comparison.
 * Increments run_count on update.
 */
export function upsertSnapshot(
  source: string,
  key: string,
  valueNumeric: number | null,
  valueText: string | null,
  hash: string | null,
): void {
  const db = getDatabase();
  writeWithRetry(() =>
    db
      .prepare(
        `INSERT INTO signal_snapshots (source, key, last_value_numeric, last_value_text, last_hash, snapshot_at, run_count)
         VALUES (?, ?, ?, ?, ?, datetime('now'), 1)
         ON CONFLICT(source, key) DO UPDATE SET
           last_value_numeric = excluded.last_value_numeric,
           last_value_text = excluded.last_value_text,
           last_hash = excluded.last_hash,
           snapshot_at = datetime('now'),
           run_count = run_count + 1`,
      )
      .run(source, key, valueNumeric, valueText, hash),
  );
}

/** Get the current snapshot for a source+key pair. */
export function getSnapshot(
  source: string,
  key: string,
): SnapshotRow | undefined {
  const db = getDatabase();
  return db
    .prepare("SELECT * FROM signal_snapshots WHERE source = ? AND key = ?")
    .get(source, key) as SnapshotRow | undefined;
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

/** Get recent signals, optionally filtered by source and/or domain. */
export function getRecentSignals(
  hours: number = 24,
  source?: string,
  domain?: string,
  limit: number = 100,
): SignalRow[] {
  const db = getDatabase();
  const conditions = ["collected_at >= datetime('now', '-' || ? || ' hours')"];
  const params: unknown[] = [hours];

  if (source) {
    conditions.push("source = ?");
    params.push(source);
  }
  if (domain) {
    conditions.push("domain = ?");
    params.push(domain);
  }

  params.push(limit);

  return db
    .prepare(
      `SELECT * FROM signals WHERE ${conditions.join(" AND ")} ORDER BY collected_at DESC LIMIT ?`,
    )
    .all(...params) as SignalRow[];
}

/** Count signals by source for the last N hours. */
export function getSignalCounts(
  hours: number = 24,
): Array<{ source: string; count: number }> {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT source, COUNT(*) as count FROM signals
       WHERE collected_at >= datetime('now', '-' || ? || ' hours')
       GROUP BY source ORDER BY count DESC`,
    )
    .all(hours) as Array<{ source: string; count: number }>;
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

/** Prune signals older than N days. Returns deleted count. */
export function pruneOldSignals(days: number = 30): number {
  const db = getDatabase();
  let changes = 0;
  writeWithRetry(() => {
    const result = db
      .prepare(
        "DELETE FROM signals WHERE collected_at < datetime('now', '-' || ? || ' days')",
      )
      .run(days);
    changes = result.changes;
  });
  return changes;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** SHA-256 content hash for dedup. */
export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
