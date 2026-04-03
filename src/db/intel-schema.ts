/**
 * Intelligence Depot schema — 4 SQLite tables for signal collection,
 * delta computation, alerting, and statistical baselines.
 *
 * Called from initDatabase(). All CREATE IF NOT EXISTS — safe to re-run.
 */

import type Database from "better-sqlite3";

export function ensureIntelTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      domain TEXT NOT NULL,
      signal_type TEXT NOT NULL,
      key TEXT NOT NULL,
      value_numeric REAL,
      value_text TEXT,
      metadata TEXT,
      geo_lat REAL,
      geo_lon REAL,
      content_hash TEXT,
      collected_at TEXT NOT NULL DEFAULT (datetime('now')),
      source_timestamp TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_signals_source_key ON signals(source, key);
    CREATE INDEX IF NOT EXISTS idx_signals_domain ON signals(domain, collected_at);
    CREATE INDEX IF NOT EXISTS idx_signals_hash ON signals(content_hash);

    CREATE TABLE IF NOT EXISTS signal_snapshots (
      source TEXT NOT NULL,
      key TEXT NOT NULL,
      last_value_numeric REAL,
      last_value_text TEXT,
      last_hash TEXT,
      snapshot_at TEXT NOT NULL DEFAULT (datetime('now')),
      run_count INTEGER DEFAULT 1,
      PRIMARY KEY (source, key)
    );

    CREATE TABLE IF NOT EXISTS signal_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tier TEXT NOT NULL CHECK (tier IN ('FLASH', 'PRIORITY', 'ROUTINE')),
      domain TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      signals_json TEXT NOT NULL,
      delivered_via TEXT,
      content_hash TEXT,
      cooldown_until TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      delivered_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_tier ON signal_alerts(tier, created_at);
    CREATE INDEX IF NOT EXISTS idx_alerts_hash ON signal_alerts(content_hash, cooldown_until);

    CREATE TABLE IF NOT EXISTS signal_baselines (
      source TEXT NOT NULL,
      key TEXT NOT NULL,
      window TEXT NOT NULL CHECK (window IN ('1h', '6h', '24h', '7d', '30d')),
      mean REAL NOT NULL,
      stddev REAL NOT NULL,
      min_val REAL,
      max_val REAL,
      sample_count INTEGER NOT NULL,
      computed_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (source, key, window)
    );
  `);
}
