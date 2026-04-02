/**
 * SQLite database singleton.
 *
 * Uses better-sqlite3 with WAL mode and performance pragmas.
 * Creates the data directory and runs schema.sql on first access.
 */

import { mkdirSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { ensureTuningTables } from "../tuning/schema.js";
import { activateBestVariant } from "../tuning/activation.js";

let _db: Database.Database | null = null;

/**
 * Initialize the database at the given path.
 * Creates the directory if needed, enables WAL, applies schema.
 */
export function initDatabase(dbPath: string): Database.Database {
  if (_db) return _db;

  // Ensure parent directory exists
  mkdirSync(dirname(dbPath), { recursive: true });

  _db = new BetterSqlite3(dbPath);

  // Performance pragmas
  _db.pragma("journal_mode = WAL");
  _db.pragma("synchronous = NORMAL");
  _db.pragma("cache_size = -64000"); // 64MB
  _db.pragma("busy_timeout = 1000"); // Short: surface contention fast, retry at app level
  _db.pragma("foreign_keys = ON");

  // Apply schema
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const schemaPath = resolve(__dirname, "schema.sql");
  const schema = readFileSync(schemaPath, "utf-8");
  _db.exec(schema);

  // Additive migrations (safe to re-run)
  const skillCols = _db.prepare("PRAGMA table_info(skills)").all() as Array<{
    name: string;
  }>;
  if (!skillCols.some((c) => c.name === "last_used")) {
    _db.exec("ALTER TABLE skills ADD COLUMN last_used TEXT");
  }

  // Cost ledger for budget enforcement (v2.21)
  _db.exec(`CREATE TABLE IF NOT EXISTS cost_ledger (
    id                INTEGER PRIMARY KEY,
    run_id            TEXT NOT NULL,
    task_id           TEXT NOT NULL,
    agent_type        TEXT NOT NULL,
    model             TEXT NOT NULL DEFAULT 'unknown',
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd          REAL NOT NULL DEFAULT 0.0,
    created_at        TEXT DEFAULT (datetime('now'))
  )`);
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_cost_ledger_created ON cost_ledger(created_at)",
  );
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_cost_ledger_task ON cost_ledger(task_id)",
  );

  // v4.0 S1: composite indexes for query performance
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_conversations_bank_created ON conversations(bank, created_at DESC)",
  );
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_outcomes_task_id ON task_outcomes(task_id)",
  );
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_outcomes_runner_success ON task_outcomes(ran_on, success)",
  );

  // v4.0 S3: FTS5 full-text search + embedding vectors
  _db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS conversations_fts USING fts5(
      content, content='conversations', content_rowid='id'
    )
  `);
  // Triggers for FTS5 sync
  _db.exec(`
    CREATE TRIGGER IF NOT EXISTS conversations_ai AFTER INSERT ON conversations BEGIN
      INSERT INTO conversations_fts(rowid, content) VALUES (new.id, new.content);
    END
  `);
  _db.exec(`
    CREATE TRIGGER IF NOT EXISTS conversations_ad AFTER DELETE ON conversations BEGIN
      INSERT INTO conversations_fts(conversations_fts, rowid, content) VALUES('delete', old.id, old.content);
    END
  `);
  _db.exec(`
    CREATE TRIGGER IF NOT EXISTS conversations_au AFTER UPDATE ON conversations BEGIN
      INSERT INTO conversations_fts(conversations_fts, rowid, content) VALUES('delete', old.id, old.content);
      INSERT INTO conversations_fts(rowid, content) VALUES (new.id, new.content);
    END
  `);
  // Backfill FTS5 from existing conversations
  _db.exec(`
    INSERT OR IGNORE INTO conversations_fts(rowid, content)
    SELECT id, content FROM conversations
  `);
  // Embedding vectors table
  _db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_embeddings (
      conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id),
      embedding       BLOB NOT NULL
    )
  `);

  // Self-tuning tables (v2.27)
  // v5.0: Jarvis internal file system — persistent knowledge base
  _db.exec(`CREATE TABLE IF NOT EXISTS jarvis_files (
    id          TEXT PRIMARY KEY,
    path        TEXT UNIQUE NOT NULL,
    title       TEXT NOT NULL,
    content     TEXT NOT NULL DEFAULT '',
    tags        TEXT DEFAULT '[]',
    qualifier   TEXT DEFAULT 'reference' CHECK(qualifier IN ('always-read','enforce','conditional','reference','workspace')),
    condition   TEXT,
    priority    INTEGER DEFAULT 50,
    related_to  TEXT DEFAULT '[]',
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  )`);
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_jarvis_files_qualifier ON jarvis_files(qualifier)",
  );
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_jarvis_files_priority ON jarvis_files(priority)",
  );

  ensureTuningTables();

  // Activate best variant from archive (v2.28 — HyperAgents pattern)
  activateBestVariant();

  return _db;
}

/**
 * Get the database instance.
 * @throws if initDatabase() hasn't been called.
 */
export function getDatabase(): Database.Database {
  if (!_db)
    throw new Error("Database not initialized. Call initDatabase() first.");
  return _db;
}

/**
 * Close the database connection with a final WAL checkpoint.
 */
export function closeDatabase(): void {
  if (_db) {
    try {
      _db.pragma("wal_checkpoint(PASSIVE)");
    } catch {
      // Best-effort — non-fatal
    }
    _db.close();
    _db = null;
  }
}

// ---------------------------------------------------------------------------
// Write retry with jitter (Hermes v0.5 pattern)
// ---------------------------------------------------------------------------

const WRITE_MAX_RETRIES = 10;
const WRITE_RETRY_MIN_MS = 20;
const WRITE_RETRY_MAX_MS = 150;
const CHECKPOINT_EVERY_N = 100;

let _writeCount = 0;

/**
 * Execute a synchronous DB write with jitter retry on SQLITE_BUSY.
 *
 * better-sqlite3's built-in busy_timeout uses deterministic sleep which
 * causes convoy effects under concurrent writes. This wrapper:
 * - Catches SQLITE_BUSY / "database is locked" errors
 * - Retries with random jitter (20-150ms) to break convoy patterns
 * - Periodic PASSIVE WAL checkpoint every 100 writes
 *
 * Use for high-contention callers (event bus, outcome tracker, memory).
 * Sequential callers (task creation, rituals) can use bare .run().
 */
export function writeWithRetry<T>(fn: () => T): T {
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < WRITE_MAX_RETRIES; attempt++) {
    try {
      const result = fn();
      _writeCount++;
      if (_writeCount % CHECKPOINT_EVERY_N === 0) {
        try {
          _db?.pragma("wal_checkpoint(PASSIVE)");
        } catch {
          // Best-effort checkpoint — non-fatal
        }
      }
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("SQLITE_BUSY") || msg.includes("database is locked")) {
        lastErr = err instanceof Error ? err : new Error(msg);
        if (attempt < WRITE_MAX_RETRIES - 1) {
          // Random jitter breaks convoy pattern
          const jitter =
            WRITE_RETRY_MIN_MS +
            Math.random() * (WRITE_RETRY_MAX_MS - WRITE_RETRY_MIN_MS);
          const end = Date.now() + jitter;
          while (Date.now() < end) {
            /* spin-wait: better-sqlite3 is sync, no setTimeout available */
          }
        }
        continue;
      }
      throw err;
    }
  }
  throw lastErr ?? new Error("database is locked after max retries");
}
