/**
 * Tuning system database schema and CRUD operations.
 *
 * Self-creating tables: called from ensureTuningTables() at startup.
 */

import { getDatabase } from "../db/index.js";
import { ensureTuningTables as ensureTuningTablesOn } from "../db/tuning-schema.js";
import type {
  TestCase,
  TestCaseCategory,
  TestCaseInput,
  TestCaseExpected,
  Experiment,
  ExperimentStatus,
  FailureSource,
  TuneRun,
  TuneVariant,
} from "./types.js";

// ---------------------------------------------------------------------------
// Table creation (idempotent)
// ---------------------------------------------------------------------------

/** Creates the tuning tables on the open database (the DDL lives in src/db/tuning-schema.ts). */
export function ensureTuningTables(): void {
  ensureTuningTablesOn(getDatabase());
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

type TestCaseRow = {
  case_id: string;
  category: string;
  input: string;
  expected: string;
  weight: number;
  source: string;
  active: number;
};

function parseTestCaseRow(r: TestCaseRow): TestCase {
  return {
    case_id: r.case_id,
    category: r.category as TestCaseCategory,
    input: JSON.parse(r.input) as TestCaseInput,
    expected: JSON.parse(r.expected) as TestCaseExpected,
    weight: r.weight,
    source: r.source as TestCase["source"],
    active: r.active === 1,
  };
}

export function getActiveTestCases(category?: TestCaseCategory): TestCase[] {
  const db = getDatabase();
  const where = category
    ? "WHERE active = 1 AND category = ?"
    : "WHERE active = 1";
  const params = category ? [category] : [];

  // Manual seed cases
  const manualRows = db
    .prepare(`SELECT * FROM tune_test_cases ${where} ORDER BY case_id`)
    .all(...params) as TestCaseRow[];

  // Mined cases from scope telemetry pipeline
  let minedRows: TestCaseRow[] = [];
  try {
    minedRows = db
      .prepare(`SELECT * FROM mined_test_cases ${where} ORDER BY case_id`)
      .all(...params) as TestCaseRow[];
  } catch {
    // mined_test_cases comes from ensureTuningTables (run by initDatabase); a failed
    // read is swallowed and only the manual cases are returned.
  }

  return [
    ...manualRows.map((r) => ({
      ...parseTestCaseRow(r),
      sourceGroup: "seed" as const,
    })),
    ...minedRows.map((r) => ({
      ...parseTestCaseRow(r),
      sourceGroup:
        r.source === "flywheel" ? ("flywheel" as const) : ("mined" as const),
    })),
  ];
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
        original_value, mutated_value, hypothesis, baseline_score, mutated_score,
        status, failure_source, confidence_avg)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    exp.failure_source ?? null,
    exp.confidence_avg ?? null,
  );
}

/**
 * Update failure-source classification after post-hoc analysis.
 * Null on success; one of `skill`|`agent`|`env` on regression.
 */
export function updateExperimentFailureSource(
  experimentId: string,
  failureSource: FailureSource | null,
): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE tune_experiments SET failure_source = ? WHERE experiment_id = ?`,
  ).run(failureSource, experimentId);
}

/**
 * Get the most recent regressed/rejected experiment for a (surface, target).
 * Used by the cooldown gate. Filters in SQL so `error` experiments (env
 * failures, not mutation failures) never trigger a cooldown — retrying
 * after a timeout should be allowed.
 */
export function getLastExperimentForTarget(
  surface: string,
  target: string,
): Experiment | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT * FROM tune_experiments
       WHERE surface = ? AND target = ?
         AND status IN ('regressed', 'rejected')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(surface, target) as Experiment | undefined;
  return row ?? null;
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

// ---------------------------------------------------------------------------
// Variant archive CRUD
// ---------------------------------------------------------------------------

export function insertVariant(v: TuneVariant): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO tune_variants
       (variant_id, parent_id, run_id, generation, config_json,
        composite_score, subscores_json, valid, activated_at, code_fingerprint)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    v.variant_id,
    v.parent_id,
    v.run_id,
    v.generation,
    v.config_json,
    v.composite_score,
    v.subscores_json,
    v.valid ? 1 : 0,
    v.activated_at,
    v.code_fingerprint ?? null,
  );
}

export function getLatestVariant(): TuneVariant | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT * FROM tune_variants WHERE valid = 1
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get() as (Omit<TuneVariant, "valid"> & { valid: number }) | undefined;
  if (!row) return null;
  return { ...row, valid: row.valid === 1 };
}

export function getValidVariants(limit = 50): TuneVariant[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT * FROM tune_variants WHERE valid = 1
       ORDER BY composite_score DESC LIMIT ?`,
    )
    .all(limit) as Array<Omit<TuneVariant, "valid"> & { valid: number }>;
  return rows.map((r) => ({ ...r, valid: r.valid === 1 }));
}

/** No variant is live this boot: drop any stale activation stamp. */
export function clearVariantActivation(): void {
  getDatabase().prepare(`UPDATE tune_variants SET activated_at = NULL`).run();
}

export function markVariantActivated(variantId: string): void {
  const db = getDatabase();
  // Clear any previous activation
  db.prepare(`UPDATE tune_variants SET activated_at = NULL`).run();
  db.prepare(
    `UPDATE tune_variants SET activated_at = datetime('now') WHERE variant_id = ?`,
  ).run(variantId);
}

export function getActiveVariant(): TuneVariant | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT * FROM tune_variants WHERE activated_at IS NOT NULL LIMIT 1`,
    )
    .get() as (Omit<TuneVariant, "valid"> & { valid: number }) | undefined;
  if (!row) return null;
  return { ...row, valid: row.valid === 1 };
}

export function invalidateVariant(variantId: string): void {
  const db = getDatabase();
  db.prepare(`UPDATE tune_variants SET valid = 0 WHERE variant_id = ?`).run(
    variantId,
  );
}
