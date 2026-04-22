/**
 * Trajectory miner (SkillClaw pattern, arXiv:2604.08377).
 *
 * After a run activates a winning variant, scan the experiment history for
 * stable-failing test cases — cases that scored below PASSING_THRESHOLD in
 * the baseline of at least MIN_FAILING_EXPERIMENTS distinct experiments —
 * and promote them to `mined_test_cases` as regression-suite entries.
 *
 * Opt-in via TUNING_TRAJECTORY_MINE=true. Default off. The miner only
 * harvests failures that persist across multiple mutations — a one-off
 * bad experiment never pollutes the golden suite.
 *
 * Safe to call repeatedly: upsert by case_id, no duplicates.
 */

import { getDatabase } from "../db/index.js";
import type { TestCase, TestCaseCategory } from "./types.js";

const PASSING_THRESHOLD = 0.5;
const MIN_FAILING_EXPERIMENTS = 3;

export interface MineOptions {
  runId: string;
  /** Dry-run: compute candidates but skip inserts. */
  dryRun?: boolean;
}

export interface MineResult {
  candidateCount: number;
  promotedCount: number;
  candidates: Array<{ caseId: string; category: string; failCount: number }>;
}

/**
 * Scan `tune_eval_results` for cases that failed in >= MIN_FAILING_EXPERIMENTS
 * experiments of this run, promote to `mined_test_cases`.
 */
export function mineTrajectory(opts: MineOptions): MineResult {
  if (process.env.TUNING_TRAJECTORY_MINE !== "true") {
    return { candidateCount: 0, promotedCount: 0, candidates: [] };
  }

  const db = getDatabase();

  // Count distinct experiments where each case scored below the threshold.
  const rows = db
    .prepare(
      `SELECT case_id, COUNT(DISTINCT experiment_id) AS fail_count
       FROM tune_eval_results
       WHERE experiment_id IN (
         SELECT experiment_id FROM tune_experiments WHERE run_id = ?
       )
       AND score < ?
       GROUP BY case_id
       HAVING fail_count >= ?`,
    )
    .all(opts.runId, PASSING_THRESHOLD, MIN_FAILING_EXPERIMENTS) as Array<{
    case_id: string;
    fail_count: number;
  }>;

  const candidates: MineResult["candidates"] = [];
  let promotedCount = 0;

  for (const row of rows) {
    const source = db
      .prepare(
        `SELECT case_id, category, input, expected FROM tune_test_cases
         WHERE case_id = ? AND active = 1
         UNION ALL
         SELECT case_id, category, input, expected FROM mined_test_cases
         WHERE case_id = ? AND active = 1
         LIMIT 1`,
      )
      .get(row.case_id, row.case_id) as
      | {
          case_id: string;
          category: string;
          input: string;
          expected: string;
        }
      | undefined;
    if (!source) continue;

    candidates.push({
      caseId: row.case_id,
      category: source.category,
      failCount: row.fail_count,
    });

    if (opts.dryRun) continue;

    // Upsert into mined_test_cases. Skip if already present from an earlier
    // run or from manual seeding.
    const existing = db
      .prepare(`SELECT 1 FROM mined_test_cases WHERE case_id = ?`)
      .get(`${row.case_id}-traj`);
    if (existing) continue;

    db.prepare(
      `INSERT INTO mined_test_cases
         (case_id, category, input, expected, weight, source, active, mined_from)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `${row.case_id}-traj`,
      source.category,
      source.input,
      source.expected,
      0.8,
      "trajectory",
      1,
      opts.runId,
    );
    promotedCount++;
  }

  return { candidateCount: candidates.length, promotedCount, candidates };
}

/**
 * Enumerate candidate failing cases without persisting — used by the
 * overnight report to log what *would* be promoted when the flag flips on.
 */
export function enumerateCandidates(runId: string): MineResult["candidates"] {
  return mineTrajectory({ runId, dryRun: true }).candidates;
}

/** Get the full TestCase shape for a given mined trajectory case. */
export function getMinedCase(caseId: string): TestCase | null {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT * FROM mined_test_cases WHERE case_id = ?`)
    .get(caseId) as
    | {
        case_id: string;
        category: string;
        input: string;
        expected: string;
        weight: number;
        source: string;
        active: number;
      }
    | undefined;
  if (!row) return null;
  return {
    case_id: row.case_id,
    category: row.category as TestCaseCategory,
    input: JSON.parse(row.input) as TestCase["input"],
    expected: JSON.parse(row.expected) as TestCase["expected"],
    weight: row.weight,
    source: row.source as TestCase["source"],
    active: row.active === 1,
  };
}
