/**
 * Excelente→flywheel auto-bridge — V8.5 Phase 4.7 (extends 4.3).
 *
 * "excelente" is the operator's SINGLE eval word (contract in
 * src/intelligence/feedback.ts). When it lands inside a feedback window — or,
 * with no window open, right after the operator's chat last showed a task
 * reply (router `lastTaskReply` marker, confirmed by the thread's latest
 * outcome row) — the
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
 * bridge never grows the counted set past the ceiling (flywheel cases are
 * retention-exempt, so nothing else bounds them). At a full ceiling a new pin
 * DISPLACES one active miner positive (earliest batch, then lowest id;
 * soft-retire, active = 0) —
 * the operator's explicit signal outranks automatic mining — and refuses
 * only when every slot is already an excelente pin. The counted set is
 * POSITIVE_CEILING_PREDICATE in case-miner.ts, keyed on the bridge's
 * exclusive `flywheel:excelente:` mined_from marker.
 */

import { getDatabase } from "../db/index.js";
import {
  countActivePositiveCases,
  ensureMinedTestCasesTable,
  POSITIVE_CASE_CEILING,
  selectionExpectation,
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
  /** case_id of the miner positive this pin retired to stay at the ceiling. */
  displaced?: string;
}

/**
 * Rows a new excelente pin may displace: ACTIVE nightly-miner positives only.
 * `source = 'mined'` and the marker exclusion keep every operator pin
 * (auto-bridged or manual CLI, whatever its case_id) out of reach.
 */
const DISPLACEABLE_PREDICATE = `case_id LIKE 'mined-positive-%'
    AND source = 'mined'
    AND mined_from NOT LIKE 'flywheel:excelente:%'
    AND active = 1`;

/** Thrown inside the pin transaction to roll the insert back. */
class CeilingFullOfPins extends Error {}

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

  let expectation: { tools: string[]; first_tools: string[] };
  try {
    expectation = selectionExpectation(
      JSON.parse(row.tools_called) as string[],
    );
  } catch {
    return { created: false, reason: "malformed_tools" };
  }
  const { tools } = expectation;
  if (tools.length === 0) return { created: false, reason: "no_tools" };
  if (tools.length > 3) return { created: false, reason: "unfocused_run" };

  const message = row.message.trim();
  if (message.split(/\s+/).length < 5) {
    return { created: false, reason: "message_too_short" };
  }

  // The nightly miner normally creates the table, but the bridge can be the
  // first writer on a fresh DB (router hook fires on any excelente).
  ensureMinedTestCasesTable(db);

  // Audit W1 (R1, 2026-07-14): flywheel cases are retention-EXEMPT, so the
  // bridge must never grow the counted set (POSITIVE_CEILING_PREDICATE:
  // miner positives + auto-bridged pins) past the ceiling, or gate cost grows
  // forever. 2026-10-04: at a full ceiling the pin displaces one active
  // miner positive instead of being refused — the miner had filled
  // every slot, so every excelente was refused. One transaction: insert,
  // then retire one miner positive if the count went over; nothing to
  // retire (all slots are excelente pins) → roll the insert back.
  // Ordering (I-R2.1, revised): INSERT OR IGNORE runs FIRST, so a re-praised
  // already-pinned task reads "already_pinned" and never displaces anything.
  const caseId = `flywheel-auto-${taskId}`;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO mined_test_cases
       (case_id, category, input, expected, weight, source, mined_from)
     VALUES (?, 'tool_selection', ?, ?, 1.0, 'flywheel', ?)`,
  );
  // Victim order: earliest created_at, then lowest id. The miner inserts in
  // batches that share one created_at (second resolution), so this is
  // "earliest batch, then lowest id" — deterministic, but arbitrary within
  // a batch; not a true per-case age.
  const oldestDisplaceable = db.prepare(
    `SELECT id, case_id FROM mined_test_cases
     WHERE ${DISPLACEABLE_PREDICATE}
     ORDER BY created_at ASC, id ASC LIMIT 1`,
  );
  const retire = db.prepare(
    `UPDATE mined_test_cases SET active = 0 WHERE id = ?`,
  );

  try {
    return db.transaction((): BridgeResult => {
      const result = insert.run(
        caseId,
        JSON.stringify({ message }),
        JSON.stringify(expectation),
        `flywheel:excelente:${taskId}`,
      );
      if (result.changes === 0) {
        return { created: false, caseId, reason: "already_pinned" };
      }
      if (countActivePositiveCases(db) <= POSITIVE_CASE_CEILING) {
        return { created: true, caseId };
      }
      const victim = oldestDisplaceable.get() as
        { id: number; case_id: string } | undefined;
      if (!victim) throw new CeilingFullOfPins();
      retire.run(victim.id);
      return { created: true, caseId, displaced: victim.case_id };
    })();
  } catch (err) {
    if (err instanceof CeilingFullOfPins) {
      return { created: false, reason: "ceiling_reached" };
    }
    throw err;
  }
}
