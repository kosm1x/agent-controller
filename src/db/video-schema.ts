/**
 * Video production schema — video_jobs table for tracking render pipelines.
 */

import type Database from "better-sqlite3";

/** v7.4 S1 additive columns. Each added only if missing (idempotent). */
const V74_ADDITIVE_COLUMNS: Array<{ name: string; ddl: string }> = [
  {
    name: "manifest_json",
    ddl: "ALTER TABLE video_jobs ADD COLUMN manifest_json TEXT",
  },
  {
    name: "frame_hash",
    ddl: "ALTER TABLE video_jobs ADD COLUMN frame_hash TEXT",
  },
  {
    name: "cost_cents",
    ddl: "ALTER TABLE video_jobs ADD COLUMN cost_cents INTEGER DEFAULT 0",
  },
  {
    name: "ffmpeg_pid",
    ddl: "ALTER TABLE video_jobs ADD COLUMN ffmpeg_pid INTEGER",
  },
];

export function ensureVideoTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS video_jobs (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id           TEXT UNIQUE NOT NULL,
      status           TEXT DEFAULT 'pending',
      topic            TEXT NOT NULL,
      duration_seconds INTEGER DEFAULT 60,
      resolution       TEXT DEFAULT '1080p',
      template         TEXT DEFAULT 'landscape',
      script_json      TEXT,
      assets_json      TEXT,
      output_file      TEXT,
      error_message    TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at     TEXT,
      expires_at       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_video_jobs_status ON video_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_video_jobs_expires ON video_jobs(expires_at);
  `);

  // v7.4 additive migrations — idempotent via PRAGMA column_info check.
  const existingCols = new Set(
    (
      db.prepare("PRAGMA table_info(video_jobs)").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name),
  );
  for (const col of V74_ADDITIVE_COLUMNS) {
    if (!existingCols.has(col.name)) {
      db.exec(col.ddl);
    }
  }
}
