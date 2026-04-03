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
  let inserted = 0;

  writeWithRetry(() => {
    const stmt = db.prepare(`
      INSERT INTO signals (source, domain, signal_type, key, value_numeric, value_text, metadata, geo_lat, geo_lon, content_hash, source_timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = db.transaction((batch: Signal[]) => {
      for (const s of batch) {
        // Skip if content_hash already exists (dedup)
        if (s.contentHash) {
          const existing = db
            .prepare("SELECT 1 FROM signals WHERE content_hash = ? LIMIT 1")
            .get(s.contentHash);
          if (existing) continue;
        }

        stmt.run(
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
        );
        inserted++;
      }
    });

    tx(signals);
  });

  return inserted;
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

/** Get all snapshots (for mc-ctl status). */
export function getAllSnapshots(): SnapshotRow[] {
  const db = getDatabase();
  return db
    .prepare("SELECT * FROM signal_snapshots ORDER BY snapshot_at DESC")
    .all() as SnapshotRow[];
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

/** Prune signals older than N days. Returns deleted count. */
export function pruneOldSignals(days: number = 30): number {
  const db = getDatabase();
  const result = db
    .prepare(
      "DELETE FROM signals WHERE collected_at < datetime('now', '-' || ? || ' days')",
    )
    .run(days);
  return result.changes;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** SHA-256 content hash for dedup. */
export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
