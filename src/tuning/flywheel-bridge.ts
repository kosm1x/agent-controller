/**
 * Excelente→flywheel auto-bridge — V8.5 Phase 4.7 (extends 4.3).
 *
 * "excelente" is the operator's SINGLE eval word (contract in
 * src/intelligence/feedback.ts). When it lands inside a feedback window, the
 * praised task's scope_telemetry becomes a pinned flywheel eval case
 * automatically — the same pin `scripts/add-eval-case.ts --from-task` does by
 * hand. Negative-feedback mining already exists in the case-miner; this
 * closes the positive half without new infrastructure.
 *
 * Quality gates mirror minePositiveSelections (case-miner.ts): a >3-distinct-
 * tool run has ambiguous ground truth for "which tool should this message
 * select", and a <5-word message selects on thread context the eval can't
 * reproduce. The operator praised the WORK, not specifically the tool
 * selection — unlike the manual CLI (where a human chose to pin), the
 * automatic path keeps the miner's filters so weight-1.0 cases stay clean.
 * Skips are logged by the caller, never silent.
 *
 * Ceiling accounting: auto-bridged cases count against POSITIVE_CASE_CEILING
 * on BOTH sides — they consume miner room in minePositiveSelections, and the
 * bridge itself refuses to insert past the ceiling (flywheel cases are
 * retention-exempt, so nothing else bounds them). The counted set is
 * POSITIVE_CEILING_PREDICATE in case-miner.ts, keyed on the bridge's
 * exclusive `flywheel:excelente:` mined_from marker.
 */

import { getDatabase } from "../db/index.js";
import {
  countActivePositiveCases,
  ensureMinedTestCasesTable,
  POSITIVE_CASE_CEILING,
} from "./case-miner.js";

export interface BridgeResult {
  created: boolean;
  caseId?: string;
  reason?:
    | "no_telemetry"
    | "malformed_tools"
    | "no_tools"
    | "unfocused_run"
    | "message_too_short"
    | "ceiling_reached"
    | "already_pinned";
}

/**
 * Pin the praised task's latest scope_telemetry row as a flywheel eval case.
 * case_id is deterministic per task (`flywheel-auto-<task_id>`) + INSERT OR
 * IGNORE, so a repeated "excelente" on the same task is a no-op. Synchronous
 * (better-sqlite3); callers treat any throw as non-fatal.
 */
export function bridgePraisedTaskToEvalCase(taskId: string): BridgeResult {
  const db = getDatabase();

  const row = db
    .prepare(
      `SELECT message, tools_called FROM scope_telemetry
       WHERE task_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(taskId) as { message: string; tools_called: string } | undefined;
  if (!row) return { created: false, reason: "no_telemetry" };

  let tools: string[];
  try {
    tools = [...new Set(JSON.parse(row.tools_called) as string[])];
  } catch {
    return { created: false, reason: "malformed_tools" };
  }
  if (tools.length === 0) return { created: false, reason: "no_tools" };
  if (tools.length > 3) return { created: false, reason: "unfocused_run" };

  const message = row.message.trim();
  if (message.split(/\s+/).length < 5) {
    return { created: false, reason: "message_too_short" };
  }

  // The nightly miner normally creates the table, but the bridge can be the
  // first writer on a fresh DB (router hook fires on any excelente).
  ensureMinedTestCasesTable(db);

  // Audit W1 (R1, 2026-07-14): flywheel cases are retention-EXEMPT, so
  // without this check the auto-bridge grows the corpus unboundedly — it
  // would first displace mined positives to zero, then keep adding gate cost
  // forever. Same hard bound the miner honors; the counted set is defined by
  // POSITIVE_CEILING_PREDICATE (miner positives + auto-bridged pins).
  // Deliberate ordering (I-R2.1): checked BEFORE the INSERT OR IGNORE, so at
  // a full ceiling a re-praised already-pinned task reads "ceiling_reached"
  // instead of "already_pinned" — misleading log label, but checking after
  // the insert would let a genuinely new case slip past the bound.
  if (countActivePositiveCases(db) >= POSITIVE_CASE_CEILING) {
    return { created: false, reason: "ceiling_reached" };
  }

  const caseId = `flywheel-auto-${taskId}`;
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO mined_test_cases
         (case_id, category, input, expected, weight, source, mined_from)
       VALUES (?, 'tool_selection', ?, ?, 1.0, 'flywheel', ?)`,
    )
    .run(
      caseId,
      JSON.stringify({ message }),
      JSON.stringify({ tools }),
      `flywheel:excelente:${taskId}`,
    );

  if (result.changes === 0) {
    return { created: false, caseId, reason: "already_pinned" };
  }
  return { created: true, caseId };
}
