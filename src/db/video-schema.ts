/**
 * Video production schema — video_jobs table for tracking render pipelines.
 */

import type Database from "better-sqlite3";

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
}
