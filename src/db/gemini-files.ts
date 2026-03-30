/**
 * Gemini Files tracking — CRUD for uploaded Gemini API files.
 *
 * Files uploaded to the Gemini Files API expire after 48h.
 * This module tracks them in SQLite so gemini_research can
 * reference active uploads and auto-filter expired ones.
 */

import { getDatabase } from "./index.js";

export interface GeminiFileRow {
  name: string;
  display_name: string;
  uri: string;
  mime_type: string;
  size_bytes: number;
  state: string;
  expires_at: string;
  created_at: string;
}

let _tableReady = false;

export function ensureGeminiFilesTable(): void {
  if (_tableReady) return;
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS gemini_files (
      id           INTEGER PRIMARY KEY,
      name         TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      uri          TEXT NOT NULL,
      mime_type    TEXT NOT NULL,
      size_bytes   INTEGER DEFAULT 0,
      state        TEXT DEFAULT 'PROCESSING',
      expires_at   TEXT NOT NULL,
      created_at   TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_gemini_files_state ON gemini_files(state);
    CREATE INDEX IF NOT EXISTS idx_gemini_files_expires ON gemini_files(expires_at);
  `);
  _tableReady = true;
}

export function upsertGeminiFile(file: {
  name: string;
  displayName: string;
  uri: string;
  mimeType: string;
  sizeBytes: number;
  state: string;
  expiresAt: string;
}): void {
  ensureGeminiFilesTable();
  const db = getDatabase();
  db.prepare(
    `INSERT INTO gemini_files (name, display_name, uri, mime_type, size_bytes, state, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name)
     DO UPDATE SET uri = excluded.uri,
                   state = excluded.state,
                   size_bytes = excluded.size_bytes,
                   expires_at = excluded.expires_at`,
  ).run(
    file.name,
    file.displayName,
    file.uri,
    file.mimeType,
    file.sizeBytes,
    file.state,
    file.expiresAt,
  );
}

export function updateGeminiFileState(name: string, state: string): void {
  ensureGeminiFilesTable();
  const db = getDatabase();
  db.prepare("UPDATE gemini_files SET state = ? WHERE name = ?").run(
    state,
    name,
  );
}

export function listActiveGeminiFiles(): GeminiFileRow[] {
  ensureGeminiFilesTable();
  const db = getDatabase();
  return db
    .prepare(
      `SELECT name, display_name, uri, mime_type, size_bytes, state, expires_at, created_at
       FROM gemini_files
       WHERE state = 'ACTIVE' AND datetime(expires_at) > datetime('now')
       ORDER BY created_at DESC`,
    )
    .all() as GeminiFileRow[];
}

export function getGeminiFile(nameOrDisplay: string): GeminiFileRow | null {
  ensureGeminiFilesTable();
  const db = getDatabase();
  return db
    .prepare(
      `SELECT name, display_name, uri, mime_type, size_bytes, state, expires_at, created_at
         FROM gemini_files
         WHERE name = ? OR display_name = ?
         ORDER BY created_at DESC LIMIT 1`,
    )
    .get(nameOrDisplay, nameOrDisplay) as GeminiFileRow | null;
}

export function cleanupExpiredGeminiFiles(): number {
  ensureGeminiFilesTable();
  const db = getDatabase();
  const result = db
    .prepare(
      "DELETE FROM gemini_files WHERE datetime(expires_at) <= datetime('now')",
    )
    .run();
  return result.changes;
}
