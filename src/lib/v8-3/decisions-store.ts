/**
 * V8.3 Phase 2 — decision-ledger writers.
 *
 * Insert/update helpers for the `decisions` (state) and `decision_events`
 * (append-only history) tables, plus the resolver's capability lookup. Mirrors
 * the V8.2 store convention (`src/lib/v8-2/judgments-store.ts`): an injected
 * `db = getDatabase()` default, prepared statements, `lastInsertRowid` read-back.
 * The pipeline owns orchestration; all raw SQL writes live here.
 */

import type Database from "better-sqlite3";
import { getDatabase } from "../../db/index.js";
import type {
  AutonomyLevel,
  CapabilityAutonomyRow,
  DecisionEventKind,
  DecisionStatus,
  PheropathSignal,
} from "./types.js";

/** Resolver lookup — fetch a capability's autonomy row (or undefined if unseeded). */
export function getCapabilityRow(
  capability: string,
  db: Database.Database = getDatabase(),
): CapabilityAutonomyRow | undefined {
  return db
    .prepare(`SELECT * FROM capability_autonomy WHERE capability = ?`)
    .get(capability) as CapabilityAutonomyRow | undefined;
}

function toJsonOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

export interface NewDecision {
  capability: string;
  judgmentId: number | null;
  autonomyLevel: AutonomyLevel;
  status: DecisionStatus;
  capabilityToken: unknown;
  payload: unknown;
  preState?: unknown | null;
  reversalOp?: unknown | null;
  pheropathSignal?: PheropathSignal | null;
  threadId: string;
  proposedAt?: string;
}

/** Insert a `decisions` row; returns its autoincrement id. */
export function insertDecision(
  input: NewDecision,
  db: Database.Database = getDatabase(),
): number {
  const info = db
    .prepare(
      `INSERT INTO decisions
         (capability, judgment_id, autonomy_level, status, capability_token_json,
          payload_json, pre_state_json, reversal_op_json, pheropath_signal,
          proposed_at, thread_id)
       VALUES
         (@capability, @judgmentId, @autonomyLevel, @status, @capabilityTokenJson,
          @payloadJson, @preStateJson, @reversalOpJson, @pheropathSignal,
          @proposedAt, @threadId)`,
    )
    .run({
      capability: input.capability,
      judgmentId: input.judgmentId,
      autonomyLevel: input.autonomyLevel,
      status: input.status,
      capabilityTokenJson: JSON.stringify(input.capabilityToken),
      payloadJson: JSON.stringify(input.payload),
      preStateJson: toJsonOrNull(input.preState),
      reversalOpJson: toJsonOrNull(input.reversalOp),
      pheropathSignal: input.pheropathSignal ?? null,
      proposedAt: input.proposedAt ?? new Date().toISOString(),
      threadId: input.threadId,
    });
  return Number(info.lastInsertRowid);
}

export interface NewDecisionEvent {
  decisionId: number;
  sequenceNo: number;
  eventKind: DecisionEventKind;
  payload?: unknown | null;
  occurredAt?: string;
  parentEventSeq?: number | null;
}

/** Append one event to a decision's append-only history; returns the event id. */
export function appendDecisionEvent(
  input: NewDecisionEvent,
  db: Database.Database = getDatabase(),
): number {
  const info = db
    .prepare(
      `INSERT INTO decision_events
         (decision_id, sequence_no, event_kind, payload_json, occurred_at, parent_event_seq)
       VALUES
         (@decisionId, @sequenceNo, @eventKind, @payloadJson, @occurredAt, @parentEventSeq)`,
    )
    .run({
      decisionId: input.decisionId,
      sequenceNo: input.sequenceNo,
      eventKind: input.eventKind,
      payloadJson: toJsonOrNull(input.payload),
      occurredAt: input.occurredAt ?? new Date().toISOString(),
      parentEventSeq: input.parentEventSeq ?? null,
    });
  return Number(info.lastInsertRowid);
}

/** Set the captured pre-mutation state on a decision (real snapshot = Phase 3). */
export function setDecisionPreState(
  decisionId: number,
  preState: unknown,
  db: Database.Database = getDatabase(),
): void {
  db.prepare(`UPDATE decisions SET pre_state_json = ? WHERE id = ?`).run(
    toJsonOrNull(preState),
    decisionId,
  );
}

/** Advance a decision's status (e.g. pending → committed) + stamp decided_at. */
export function updateDecisionStatus(
  decisionId: number,
  status: DecisionStatus,
  decidedAt: string | null = null,
  db: Database.Database = getDatabase(),
): void {
  db.prepare(
    `UPDATE decisions SET status = ?, decided_at = COALESCE(?, decided_at) WHERE id = ?`,
  ).run(status, decidedAt, decisionId);
}

/** Columns needed to revert a decision (Phase 3). */
export interface DecisionRevertRow {
  id: number;
  capability: string;
  status: DecisionStatus;
  autonomy_level: AutonomyLevel;
  reversal_op_json: string | null;
  pre_state_json: string | null;
}

/** Fetch the revert-relevant columns of a decision (or undefined if absent). */
export function getDecisionForRevert(
  decisionId: number,
  db: Database.Database = getDatabase(),
): DecisionRevertRow | undefined {
  return db
    .prepare(
      `SELECT id, capability, status, autonomy_level, reversal_op_json, pre_state_json
       FROM decisions WHERE id = ?`,
    )
    .get(decisionId) as DecisionRevertRow | undefined;
}

/** Mark a decision reverted and stamp `reverted_at` (terminal revert state). */
export function markReverted(
  decisionId: number,
  revertedAt: string,
  db: Database.Database = getDatabase(),
): void {
  db.prepare(
    `UPDATE decisions SET status = 'reverted', reverted_at = ? WHERE id = ?`,
  ).run(revertedAt, decisionId);
}

/** Next 1-based sequence_no for a decision's append-only event stream. */
export function nextSequenceNo(
  decisionId: number,
  db: Database.Database = getDatabase(),
): number {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(sequence_no), 0) + 1 AS n FROM decision_events WHERE decision_id = ?`,
    )
    .get(decisionId) as { n: number };
  return row.n;
}
