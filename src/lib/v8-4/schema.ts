/**
 * V8.4 "Honest Done" — completion-ledger schema.
 *
 * `task_gates` is the harness-owned acceptance ledger for a task: one row per
 * gate, written BEFORE the work (submission / ritual / plan) or BY the harness
 * (landing), never by the model. The model has no tool that touches this
 * table; the only writers are `declareGates` (additions only — there is no
 * update/delete API for criteria) and `recordGateResult` (evidence).
 *
 * States: `pending` (declared, not proven) · `met` (check passed, evidence
 * recorded) · `failed` (check ran and did not pass) · `abandoned` (honestly
 * surrendered with a reason — the ABANDON line). A `met` row without evidence
 * is impossible by construction (recordGateResult refuses it) and is counted
 * as pending by the verdict if it ever appears.
 */
import type Database from "better-sqlite3";

export function ensureV84Tables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_gates (
      task_id        TEXT NOT NULL,
      gate_id        TEXT NOT NULL,
      criterion      TEXT NOT NULL,
      check_kind     TEXT NOT NULL DEFAULT 'shell'
                       CHECK(check_kind IN ('shell','landing','manual')),
      check_cmd      TEXT,
      expect         TEXT,
      state          TEXT NOT NULL DEFAULT 'pending'
                       CHECK(state IN ('pending','met','failed','abandoned')),
      evidence       TEXT,
      abandon_reason TEXT,
      source         TEXT NOT NULL
                       CHECK(source IN ('submission','ritual','plan','harness')),
      frozen_at      TEXT,
      checked_at     TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (task_id, gate_id)
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_task_gates_state ON task_gates(task_id, state)`,
  );
}
