/**
 * Tuning system database schema and CRUD operations.
 *
 * Self-creating tables: called from ensureTuningTables() at startup.
 */

import { getDatabase } from "../db/index.js";
import type {
  TestCase,
  TestCaseCategory,
  TestCaseInput,
  TestCaseExpected,
  Experiment,
  ExperimentStatus,
  TuneRun,
} from "./types.js";

// ---------------------------------------------------------------------------
// Table creation (idempotent)
// ---------------------------------------------------------------------------

export function ensureTuningTables(): void {
  const db = getDatabase();

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
  `);
}

// ---------------------------------------------------------------------------
// Test case CRUD
// ---------------------------------------------------------------------------

export function insertTestCase(tc: TestCase): void {
  const db = getDatabase();
  db.prepare(
    `INSERT OR REPLACE INTO tune_test_cases
       (case_id, category, input, expected, weight, source, active)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    tc.case_id,
    tc.category,
    JSON.stringify(tc.input),
    JSON.stringify(tc.expected),
    tc.weight,
    tc.source,
    tc.active ? 1 : 0,
  );
}

export function getActiveTestCases(category?: TestCaseCategory): TestCase[] {
  const db = getDatabase();
  const where = category
    ? "WHERE active = 1 AND category = ?"
    : "WHERE active = 1";
  const params = category ? [category] : [];

  const rows = db
    .prepare(`SELECT * FROM tune_test_cases ${where} ORDER BY case_id`)
    .all(...params) as Array<{
    case_id: string;
    category: string;
    input: string;
    expected: string;
    weight: number;
    source: string;
    active: number;
  }>;

  return rows.map((r) => ({
    case_id: r.case_id,
    category: r.category as TestCaseCategory,
    input: JSON.parse(r.input) as TestCaseInput,
    expected: JSON.parse(r.expected) as TestCaseExpected,
    weight: r.weight,
    source: r.source as TestCase["source"],
    active: r.active === 1,
  }));
}

export function countTestCases(): number {
  const db = getDatabase();
  const row = db
    .prepare("SELECT COUNT(*) as cnt FROM tune_test_cases WHERE active = 1")
    .get() as { cnt: number };
  return row.cnt;
}

// ---------------------------------------------------------------------------
// Experiment CRUD
// ---------------------------------------------------------------------------

export function insertExperiment(exp: Experiment): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO tune_experiments
       (experiment_id, run_id, surface, target, mutation_type,
        original_value, mutated_value, hypothesis, baseline_score, mutated_score, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    exp.experiment_id,
    exp.run_id,
    exp.surface,
    exp.target,
    exp.mutation_type,
    exp.original_value,
    exp.mutated_value,
    exp.hypothesis,
    exp.baseline_score,
    exp.mutated_score,
    exp.status,
  );
}

export function updateExperimentResult(
  experimentId: string,
  mutatedScore: number,
  status: ExperimentStatus,
): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE tune_experiments
     SET mutated_score = ?, status = ?
     WHERE experiment_id = ?`,
  ).run(mutatedScore, status, experimentId);
}

export function getExperimentsByRun(runId: string): Experiment[] {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT * FROM tune_experiments WHERE run_id = ? ORDER BY created_at`,
    )
    .all(runId) as Experiment[];
}

export function getRecentExperiments(limit: number): Experiment[] {
  const db = getDatabase();
  return db
    .prepare(`SELECT * FROM tune_experiments ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as Experiment[];
}

// ---------------------------------------------------------------------------
// Eval result CRUD
// ---------------------------------------------------------------------------

export function insertEvalResult(
  experimentId: string,
  caseId: string,
  score: number,
  details: Record<string, unknown>,
  tokensUsed: number,
): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO tune_eval_results
       (experiment_id, case_id, score, details, tokens_used)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(experimentId, caseId, score, JSON.stringify(details), tokensUsed);
}

// ---------------------------------------------------------------------------
// Run CRUD
// ---------------------------------------------------------------------------

export function insertRun(run: TuneRun): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO tune_runs
       (run_id, status, baseline_score, best_score,
        experiments_run, experiments_won, total_cost_usd, report)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    run.run_id,
    run.status,
    run.baseline_score,
    run.best_score,
    run.experiments_run,
    run.experiments_won,
    run.total_cost_usd,
    run.report,
  );
}

export function updateRun(
  runId: string,
  updates: Partial<
    Pick<
      TuneRun,
      | "status"
      | "baseline_score"
      | "best_score"
      | "experiments_run"
      | "experiments_won"
      | "total_cost_usd"
      | "report"
      | "completed_at"
    >
  >,
): void {
  const db = getDatabase();
  const fields: string[] = [];
  const values: unknown[] = [];

  for (const [key, val] of Object.entries(updates)) {
    if (val !== undefined) {
      fields.push(`${key} = ?`);
      values.push(val);
    }
  }

  if (fields.length === 0) return;
  values.push(runId);

  db.prepare(`UPDATE tune_runs SET ${fields.join(", ")} WHERE run_id = ?`).run(
    ...values,
  );
}

export function getLatestRun(): TuneRun | null {
  const db = getDatabase();
  const row = db
    .prepare("SELECT * FROM tune_runs ORDER BY started_at DESC LIMIT 1")
    .get() as TuneRun | undefined;
  return row ?? null;
}

export function getRunById(runId: string): TuneRun | null {
  const db = getDatabase();
  const row = db
    .prepare("SELECT * FROM tune_runs WHERE run_id = ?")
    .get(runId) as TuneRun | undefined;
  return row ?? null;
}
