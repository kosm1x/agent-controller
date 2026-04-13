/**
 * Reflector gap telemetry — logs divergence between the LLM judge score and
 * the heuristic goal-completion ratio for each Prometheus reflection call.
 *
 * Motivation (autoreason paper, Section 7.10-7.11): the value of structured
 * self-refinement depends on the generation-evaluation gap — how much better
 * a model can generate than it can evaluate its own output. If the gap is
 * narrow, external judges add nothing; if wide, they add significant lift.
 *
 * We can't decide whether to invest in tournament judging or fresh-agent
 * evaluation without knowing where our production traffic sits on this
 * curve. This log is the observable signal. Phase 2 decision (adopt full
 * tournament or not) reads from this table after ~1 week of data.
 *
 * Write-only from the reflector. Non-fatal — failures are swallowed.
 */

import { getDatabase } from "./index.js";

export interface ReflectorGapRecord {
  taskId: string;
  llmScore: number;
  heuristicScore: number;
  llmAvailable: boolean;
  goalsTotal: number;
  goalsCompleted: number;
  goalsFailed: number;
}

export function logReflectorGap(record: ReflectorGapRecord): void {
  try {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO reflector_gap_log
        (task_id, llm_score, heuristic_score, abs_diff, llm_available,
         goals_total, goals_completed, goals_failed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      record.taskId,
      record.llmScore,
      record.heuristicScore,
      Math.abs(record.llmScore - record.heuristicScore),
      record.llmAvailable ? 1 : 0,
      record.goalsTotal,
      record.goalsCompleted,
      record.goalsFailed,
    );
  } catch {
    // Telemetry must never block execution.
  }
}
