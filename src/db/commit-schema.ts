/**
 * COMMIT Schema — Native SQLite tables for the COMMIT productivity framework.
 *
 * Migrated from external Supabase/Postgres. Single-user (no user_id column).
 * UUIDs preserved as TEXT primary keys for compatibility with existing data.
 */

import { getDatabase } from "./index.js";

const STATUS_CHECK = `CHECK(status IN ('not_started','in_progress','completed','on_hold'))`;
const PRIORITY_CHECK = `CHECK(priority IN ('high','medium','low'))`;
const MODIFIED_BY_CHECK = `CHECK(modified_by IN ('user','jarvis','system'))`;

export function ensureCommitTables(): void {
  const db = getDatabase();

  // --- Hierarchy (4 tables) ---

  db.exec(`CREATE TABLE IF NOT EXISTS commit_visions (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    description   TEXT DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'not_started' ${STATUS_CHECK},
    target_date   TEXT,
    "order"       INTEGER DEFAULT 0,
    modified_by   TEXT DEFAULT 'user' ${MODIFIED_BY_CHECK},
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now')),
    last_edited_at TEXT DEFAULT (datetime('now'))
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS commit_goals (
    id            TEXT PRIMARY KEY,
    vision_id     TEXT,
    title         TEXT NOT NULL,
    description   TEXT DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'not_started' ${STATUS_CHECK},
    target_date   TEXT,
    "order"       INTEGER DEFAULT 0,
    modified_by   TEXT DEFAULT 'user' ${MODIFIED_BY_CHECK},
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now')),
    last_edited_at TEXT DEFAULT (datetime('now'))
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS commit_objectives (
    id            TEXT PRIMARY KEY,
    goal_id       TEXT,
    title         TEXT NOT NULL,
    description   TEXT DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'not_started' ${STATUS_CHECK},
    priority      TEXT DEFAULT 'medium' ${PRIORITY_CHECK},
    target_date   TEXT,
    "order"       INTEGER DEFAULT 0,
    modified_by   TEXT DEFAULT 'user' ${MODIFIED_BY_CHECK},
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now')),
    last_edited_at TEXT DEFAULT (datetime('now'))
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS commit_tasks (
    id            TEXT PRIMARY KEY,
    objective_id  TEXT,
    title         TEXT NOT NULL,
    description   TEXT DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'not_started' ${STATUS_CHECK},
    priority      TEXT DEFAULT 'medium' ${PRIORITY_CHECK},
    due_date      TEXT,
    completed_at  TEXT,
    is_recurring  INTEGER DEFAULT 0,
    notes         TEXT DEFAULT '',
    document_links TEXT DEFAULT '[]',
    "order"       INTEGER DEFAULT 0,
    modified_by   TEXT DEFAULT 'user' ${MODIFIED_BY_CHECK},
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now')),
    last_edited_at TEXT DEFAULT (datetime('now'))
  )`);

  // --- Tracking ---

  db.exec(`CREATE TABLE IF NOT EXISTS commit_completions (
    id              TEXT PRIMARY KEY,
    task_id         TEXT NOT NULL,
    completion_date TEXT NOT NULL DEFAULT (date('now')),
    created_at      TEXT DEFAULT (datetime('now')),
    UNIQUE(task_id, completion_date)
  )`);

  // --- Introspection ---

  db.exec(`CREATE TABLE IF NOT EXISTS commit_journal (
    id              TEXT PRIMARY KEY,
    content         TEXT NOT NULL,
    entry_date      TEXT NOT NULL DEFAULT (date('now')),
    primary_emotion TEXT,
    modified_by     TEXT DEFAULT 'user' ${MODIFIED_BY_CHECK},
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now'))
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS commit_ai_analysis (
    id                TEXT PRIMARY KEY,
    entry_id          TEXT NOT NULL UNIQUE,
    emotions          TEXT DEFAULT '[]',
    patterns          TEXT DEFAULT '[]',
    coping_strategies TEXT DEFAULT '[]',
    primary_emotion   TEXT,
    created_at        TEXT DEFAULT (datetime('now')),
    analyzed_at       TEXT DEFAULT (datetime('now'))
  )`);

  // --- Agent suggestions ---

  db.exec(`CREATE TABLE IF NOT EXISTS commit_suggestions (
    id            TEXT PRIMARY KEY,
    type          TEXT NOT NULL,
    target_table  TEXT,
    target_id     TEXT,
    title         TEXT NOT NULL,
    suggestion    TEXT NOT NULL DEFAULT '{}',
    reasoning     TEXT,
    source        TEXT,
    status        TEXT DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected','expired')),
    created_at    TEXT DEFAULT (datetime('now')),
    resolved_at   TEXT
  )`);

  // --- Indexes ---

  db.exec("CREATE INDEX IF NOT EXISTS idx_cv_status ON commit_visions(status)");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_cg_vision ON commit_goals(vision_id)",
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_cg_status ON commit_goals(status)");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_co_goal ON commit_objectives(goal_id)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_co_status ON commit_objectives(status)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_ct_objective ON commit_tasks(objective_id)",
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_ct_status ON commit_tasks(status)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_ct_due ON commit_tasks(due_date)");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_cc_task ON commit_completions(task_id)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_cc_date ON commit_completions(completion_date DESC)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_cj_date ON commit_journal(entry_date DESC)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_cs_status ON commit_suggestions(status)",
  );
}
