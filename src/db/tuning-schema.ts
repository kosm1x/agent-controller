/**
 * Tables of the self-tuning system (test cases, experiments, eval results,
 * runs, variants, mined cases): DDL only, on the handle it is given.
 *
 * It lives under src/db/ so that opening the database creates these tables
 * without loading the tuning code, which reaches the tool registry and the
 * scope module.
 */

import type Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Table creation (idempotent)
// ---------------------------------------------------------------------------

export function ensureTuningTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tune_test_cases (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id     TEXT UNIQUE NOT NULL,
      category    TEXT NOT NULL,
      input       TEXT NOT NULL,
      expected    TEXT NOT NULL,
      weight      REAL DEFAULT 1.0,
      source      TEXT DEFAULT 'manual',
      active      INTEGER DEFAULT 1,
      created_at  TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tune_cases_category
      ON tune_test_cases(category);

    CREATE TABLE IF NOT EXISTS tune_experiments (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      experiment_id   TEXT UNIQUE NOT NULL,
      run_id          TEXT NOT NULL,
      surface         TEXT NOT NULL,
      target          TEXT NOT NULL,
      mutation_type   TEXT NOT NULL,
      original_value  TEXT NOT NULL,
      mutated_value   TEXT NOT NULL,
      hypothesis      TEXT,
      baseline_score  REAL,
      mutated_score   REAL,
      status          TEXT DEFAULT 'pending',
      created_at      TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tune_experiments_run
      ON tune_experiments(run_id);
    CREATE INDEX IF NOT EXISTS idx_tune_experiments_status
      ON tune_experiments(status);

    CREATE TABLE IF NOT EXISTS tune_eval_results (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      experiment_id   TEXT NOT NULL,
      case_id         TEXT NOT NULL,
      score           REAL NOT NULL,
      details         TEXT,
      tokens_used     INTEGER DEFAULT 0,
      created_at      TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tune_results_experiment
      ON tune_eval_results(experiment_id);

    CREATE TABLE IF NOT EXISTS tune_runs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id          TEXT UNIQUE NOT NULL,
      status          TEXT DEFAULT 'running',
      baseline_score  REAL,
      best_score      REAL,
      experiments_run INTEGER DEFAULT 0,
      experiments_won INTEGER DEFAULT 0,
      total_cost_usd  REAL DEFAULT 0,
      report          TEXT,
      started_at      TEXT DEFAULT (datetime('now')),
      completed_at    TEXT
    );

    CREATE TABLE IF NOT EXISTS tune_variants (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      variant_id      TEXT UNIQUE NOT NULL,
      parent_id       TEXT,
      run_id          TEXT NOT NULL,
      generation      INTEGER DEFAULT 0,
      config_json     TEXT NOT NULL,
      composite_score REAL NOT NULL,
      subscores_json  TEXT,
      valid           INTEGER DEFAULT 1,
      activated_at    TEXT,
      created_at      TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tune_variants_score
      ON tune_variants(composite_score DESC);
  `);

  // 2026-09-12: code fingerprint of the scope groups a variant overrides
  // (src/tuning/fingerprint.ts). NULL on rows generated before the column
  // existed — activation treats those as legacy (see activation.ts).
  const variantCols = db
    .prepare("PRAGMA table_info(tune_variants)")
    .all() as Array<{ name: string }>;
  if (!variantCols.some((c) => c.name === "code_fingerprint")) {
    db.exec("ALTER TABLE tune_variants ADD COLUMN code_fingerprint TEXT");
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tune_variants_valid
      ON tune_variants(valid);

    CREATE TABLE IF NOT EXISTS mined_test_cases (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id     TEXT UNIQUE NOT NULL,
      category    TEXT NOT NULL,
      input       TEXT NOT NULL,
      expected    TEXT NOT NULL,
      weight      REAL DEFAULT 0.8,
      source      TEXT DEFAULT 'mined',
      active      INTEGER DEFAULT 1,
      mined_from  TEXT,
      created_at  TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_mined_cases_category
      ON mined_test_cases(category);
  `);

  // v7.5 additive columns — safe to re-run: `addColumnIfMissing` probes the
  // schema first, since SQLite has no IF NOT EXISTS on ADD COLUMN.
  addColumnIfMissing(db, "tune_experiments", "failure_source", "TEXT");
  addColumnIfMissing(db, "tune_experiments", "confidence_avg", "REAL");
}

/**
 * Idempotent ALTER TABLE ADD COLUMN — SQLite lacks IF NOT EXISTS on ADD COLUMN,
 * so probe the schema first. Safe to call repeatedly.
 */
function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  typeDecl: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeDecl}`);
}
