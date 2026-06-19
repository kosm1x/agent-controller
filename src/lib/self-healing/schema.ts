/**
 * Self-healing triage schema — one table. Called from initDatabase().
 *
 * `triage_report` persists each diagnosis (root cause + OPERATOR-facing
 * recommendations). It is a READ-ONLY artifact: nothing reads `recommended_json`
 * to act — the hard-stop is structural. All `CREATE IF NOT EXISTS` and a NEW
 * table (not a column add), so it's boot-safe on the existing mc.db.
 */

import type Database from "better-sqlite3";

export function ensureSelfHealingTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS triage_report (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id        TEXT NOT NULL UNIQUE,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      severity         TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low')),
      anomalies_json   TEXT NOT NULL DEFAULT '[]',
      root_cause       TEXT NOT NULL,
      affected_json    TEXT NOT NULL DEFAULT '[]',
      recommended_json TEXT NOT NULL DEFAULT '[]',
      confidence       TEXT NOT NULL DEFAULT 'low' CHECK (confidence IN ('high','medium','low')),
      model            TEXT,
      cost_usd         REAL,
      status           TEXT NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open','acknowledged','resolved','false_positive')),
      acknowledged_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_triage_open
      ON triage_report(created_at DESC) WHERE acknowledged_at IS NULL;
  `);
}
