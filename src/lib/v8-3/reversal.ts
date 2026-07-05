/**
 * V8.3 Phase 3 — reversibility primitive (the heart of v1).
 *
 * Mechanically enforced undo for gated writes (spec §7). The v1 workhorse is
 * SQL inverse DML: snapshot the exact rows a mutation will touch BEFORE it runs
 * (`pre_state_json`), derive the inverse procedure (`reversal_op_json`), and on
 * demand — or on execution failure — replay it to restore state, verifying the
 * restoration by content fingerprint.
 *
 * Strategy coverage in v1 (spec §7), keyed off `ReversalStrategy`:
 *  - sql_inverse  — IMPLEMENTED: capture → build → validate blast-radius →
 *                   apply (UPDATE / INSERT / DELETE inverse) → verify restored.
 *  - compensating — recorded as a PROPOSED reversal; never auto-executed
 *                   (a sent email, a NorthStar LWW write) — the operator confirms.
 *  - none         — explicit irreversible marker; buildable ONLY at L≤2 with
 *                   `reversible_required=false` (§7.4); else it throws.
 *  - delete_inverse / tri_restore — forward-modeled as `deferred`; replay needs
 *                   the tool / FS layer (later phases), so they are NOT auto-
 *                   revertible in v1 and cannot back an autonomous (L≥3) action.
 *
 * Dormant: no production call site. The pipeline gains the wiring but still
 * ships ungated (`V83_ENABLED` off).
 */

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { getDatabase } from "../../db/index.js";
import type { AutonomyLevel, ReversalStrategy } from "./types.js";
import {
  appendDecisionEvent,
  getDecisionForRevert,
  markReverted,
  nextSequenceNo,
} from "./decisions-store.js";
import { errMsg } from "../err-msg.js";

// ── SQL identifier poka-yoke ────────────────────────────────────────────────
// Table/column names flow into DDL-position SQL (better-sqlite3 cannot bind
// identifiers). They originate from the live schema (captured via SELECT *), but
// we still hard-reject anything that isn't a plain identifier before quoting.
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
function ident(name: string): string {
  if (!SAFE_IDENT.test(name)) {
    throw new Error(`V8.3 reversal: unsafe SQL identifier '${name}'`);
  }
  return `"${name}"`;
}

// ── Content fingerprint (SHA256 over a canonical, key-sorted serialization) ──
function canonical(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonical);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) out[key] = canonical(obj[key]);
  return out;
}

/** Stable SHA256 of a value, independent of object key order. */
export function fingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

// ── Types (per spec §5/§7; the JSON column shapes "arrive with the code") ────

/** One row a mutation will touch, identified by table + primary-key columns. */
export interface MutationTarget {
  table: string;
  /** Primary-key column → value (the WHERE that uniquely selects the row). */
  pk: Record<string, unknown>;
}

/** A row snapshotted before a mutation; `before === null` ⇒ the row did not exist. */
export interface CapturedRow {
  table: string;
  pk: Record<string, unknown>;
  before: Record<string, unknown> | null;
}

/** Pre-mutation snapshot stored in `decisions.pre_state_json`. */
export interface SqlPreState {
  kind: "sql";
  rows: CapturedRow[];
  /** Fingerprint of `rows` — the target for verify-restored. */
  fingerprint: string;
  capturedAt: string;
}

/** One inverse instruction; restore = re-establish the captured `before` row. */
export type ReversalStep =
  | { action: "delete"; table: string; pk: Record<string, unknown> }
  | {
      action: "restore";
      table: string;
      pk: Record<string, unknown>;
      row: Record<string, unknown>;
    };

/** The inverse procedure stored in `decisions.reversal_op_json`. */
export type ReversalOp =
  | {
      kind: "sql_inverse";
      tables: string[];
      steps: ReversalStep[];
      fingerprint: string;
    }
  | { kind: "compensating"; proposal: string; autoExecutable: false }
  | { kind: "irreversible"; reason: string }
  | {
      kind: "deferred";
      strategy: "delete_inverse" | "tri_restore";
      note: string;
    };

export interface ReversalResult {
  ok: boolean;
  /** True for compensating ops — reversal is PROPOSED, not auto-executed. */
  requiresOperator?: boolean;
  reason?: string;
}

// ── Capture ─────────────────────────────────────────────────────────────────

/**
 * Snapshot the current state of each target row BEFORE a mutation runs. Rows
 * that do not yet exist (a planned INSERT) capture `before: null`, so their
 * inverse is a DELETE.
 */
export function captureSqlPreState(
  db: Database.Database,
  targets: MutationTarget[],
  capturedAtIso: string = new Date().toISOString(),
): SqlPreState {
  const rows: CapturedRow[] = targets.map((target) => {
    const pkCols = Object.keys(target.pk);
    if (pkCols.length === 0) {
      throw new Error(
        `V8.3 reversal: empty primary key for table '${target.table}'`,
      );
    }
    const where = pkCols.map((c) => `${ident(c)} = @${c}`).join(" AND ");
    const before = db
      .prepare(`SELECT * FROM ${ident(target.table)} WHERE ${where}`)
      .get(target.pk) as Record<string, unknown> | undefined;
    return { table: target.table, pk: target.pk, before: before ?? null };
  });
  return {
    kind: "sql",
    rows,
    fingerprint: fingerprint(rows),
    capturedAt: capturedAtIso,
  };
}

// ── Build ─────────────────────────────────────────────────────────────────

export interface BuildReversalInput {
  strategy: ReversalStrategy;
  /** Required for `sql_inverse`. */
  preState?: SqlPreState;
  /** Capability's declared blast-radius surface; inverse must stay within it. */
  allowedTables?: string[];
  /** Effective autonomy level — gates whether an irreversible op is permitted. */
  level: AutonomyLevel;
  reversibleRequired: boolean;
  compensatingProposal?: string;
}

/**
 * Derive the inverse procedure for a mutation from its strategy + captured
 * pre-state. Throws if an irreversible action is requested where it cannot be
 * permitted (§7.4), or if `sql_inverse` is requested without a pre-state.
 */
export function buildReversalOp(input: BuildReversalInput): ReversalOp {
  switch (input.strategy) {
    case "sql_inverse": {
      if (!input.preState) {
        throw new Error(
          "V8.3 reversal: sql_inverse requires a captured pre-state",
        );
      }
      const steps: ReversalStep[] = input.preState.rows.map((r) =>
        r.before === null
          ? { action: "delete", table: r.table, pk: r.pk }
          : { action: "restore", table: r.table, pk: r.pk, row: r.before },
      );
      const tables = [...new Set(steps.map((s) => s.table))];
      const op: ReversalOp = {
        kind: "sql_inverse",
        tables,
        steps,
        fingerprint: input.preState.fingerprint,
      };
      if (input.allowedTables) validateBlastRadius(op, input.allowedTables);
      return op;
    }
    case "compensating":
      return {
        kind: "compensating",
        proposal:
          input.compensatingProposal ??
          "Operator-confirmed compensating action required (no clean inverse).",
        autoExecutable: false,
      };
    case "delete_inverse":
    case "tri_restore":
      return {
        kind: "deferred",
        strategy: input.strategy,
        note: "replay requires the tool/FS layer (later phase); not auto-revertible in v1",
      };
    case "none": {
      // Explicit irreversible — permitted ONLY at L≤2 AND reversible_required=false (§7.4).
      if (input.level >= 3 || input.reversibleRequired) {
        throw new Error(
          `V8.3 reversal: irreversible action not permitted at level ${input.level} ` +
            `(reversible_required=${input.reversibleRequired}); §7.4 allows it only at L≤2 with reversible_required=false`,
        );
      }
      return {
        kind: "irreversible",
        reason: "no programmatic inverse for this capability",
      };
    }
    default:
      return ((_x: never) => {
        throw new Error(`V8.3 reversal: unknown reversal strategy`);
      })(input.strategy);
  }
}

/** Reject an inverse that touches tables outside the declared blast-radius (§7.1). */
export function validateBlastRadius(
  op: ReversalOp,
  allowedTables: string[],
): void {
  if (op.kind !== "sql_inverse") return;
  const allowed = new Set(allowedTables);
  const outOfScope = op.tables.filter((t) => !allowed.has(t));
  if (outOfScope.length > 0) {
    throw new Error(
      `V8.3 reversal: inverse touches out-of-blast-radius tables [${outOfScope.join(
        ", ",
      )}]; declared blast-radius = [${allowedTables.join(", ")}]`,
    );
  }
}

// ── Apply (replay) ──────────────────────────────────────────────────────────

/**
 * Replay an inverse procedure. `sql_inverse` runs in a single transaction
 * (atomic). `compensating` is NEVER auto-executed (operator confirms);
 * `irreversible` / `deferred` cannot replay in v1.
 */
export function applyReversal(
  db: Database.Database,
  op: ReversalOp,
): ReversalResult {
  switch (op.kind) {
    case "sql_inverse": {
      const tx = db.transaction((steps: ReversalStep[]) => {
        for (const step of steps) {
          const pkCols = Object.keys(step.pk);
          const where = pkCols
            .map((c) => `${ident(c)} = @pk_${c}`)
            .join(" AND ");
          const pkParams = Object.fromEntries(
            pkCols.map((c) => [`pk_${c}`, step.pk[c]]),
          );
          if (step.action === "delete") {
            db.prepare(`DELETE FROM ${ident(step.table)} WHERE ${where}`).run(
              pkParams,
            );
            continue;
          }
          // restore: UPDATE the row back to `before` if it still exists, else INSERT it.
          const cols = Object.keys(step.row);
          const rowParams = Object.fromEntries(
            cols.map((c) => [`col_${c}`, step.row[c]]),
          );
          const exists = db
            .prepare(`SELECT 1 FROM ${ident(step.table)} WHERE ${where}`)
            .get(pkParams);
          if (exists) {
            const setClause = cols
              .map((c) => `${ident(c)} = @col_${c}`)
              .join(", ");
            db.prepare(
              `UPDATE ${ident(step.table)} SET ${setClause} WHERE ${where}`,
            ).run({ ...rowParams, ...pkParams });
          } else {
            const colList = cols.map((c) => ident(c)).join(", ");
            const valList = cols.map((c) => `@col_${c}`).join(", ");
            db.prepare(
              `INSERT INTO ${ident(step.table)} (${colList}) VALUES (${valList})`,
            ).run(rowParams);
          }
        }
      });
      try {
        tx(op.steps);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          reason: errMsg(err),
        };
      }
    }
    case "compensating":
      return { ok: false, requiresOperator: true, reason: op.proposal };
    case "irreversible":
      return { ok: false, reason: `irreversible: ${op.reason}` };
    case "deferred":
      return {
        ok: false,
        reason: `deferred strategy '${op.strategy}' not replayable in v1`,
      };
  }
}

/**
 * After a replay, re-read the targeted rows and confirm they match the captured
 * `before` snapshot (fingerprint equality). A false result means the replay ran
 * but state was NOT restored — a CRITICAL condition (§10): freeze the capability.
 */
export function verifyRestored(
  db: Database.Database,
  preState: SqlPreState,
): boolean {
  const current = captureSqlPreState(
    db,
    preState.rows.map((r) => ({ table: r.table, pk: r.pk })),
  );
  return current.fingerprint === preState.fingerprint;
}

// ── Ledger-integrated operator revert ────────────────────────────────────────

export interface RevertOutcome {
  ok: boolean;
  status: "reverted" | "unchanged";
  /** True when reversal is a compensating action the operator must confirm. */
  requiresOperator?: boolean;
  /** Result of the post-replay verification (sql_inverse only). */
  restored?: boolean;
  reason?: string;
}

/**
 * Revert a committed decision: load its inverse, validate blast-radius, replay,
 * verify, and on success append a `reverted` event + mark the decision reverted.
 *
 * Only `committed` decisions revert. Compensating ops return `requiresOperator`
 * without changing state. A replay that runs but fails verification leaves the
 * decision UNCHANGED (CRITICAL — the row is inconsistent and must be investigated).
 */
export function revertDecision(
  decisionId: number,
  db: Database.Database = getDatabase(),
  opts: { allowedTables?: string[]; nowIso?: string } = {},
): RevertOutcome {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const row = getDecisionForRevert(decisionId, db);
  if (!row) {
    throw new Error(`V8.3 reversal: unknown decision ${decisionId}`);
  }
  if (row.status !== "committed") {
    return {
      ok: false,
      status: "unchanged",
      reason: `cannot revert a decision in status '${row.status}' (only committed decisions revert)`,
    };
  }
  if (!row.reversal_op_json) {
    return {
      ok: false,
      status: "unchanged",
      reason: "no reversal op recorded (irreversible / unknown)",
    };
  }
  const op = JSON.parse(row.reversal_op_json) as ReversalOp;

  if (op.kind === "compensating") {
    return {
      ok: false,
      status: "unchanged",
      requiresOperator: true,
      reason: op.proposal,
    };
  }
  if (op.kind === "irreversible") {
    return {
      ok: false,
      status: "unchanged",
      reason: `irreversible: ${op.reason}`,
    };
  }
  if (op.kind === "deferred") {
    return { ok: false, status: "unchanged", reason: `deferred: ${op.note}` };
  }

  // sql_inverse
  if (opts.allowedTables) validateBlastRadius(op, opts.allowedTables);
  const applied = applyReversal(db, op);
  if (!applied.ok) {
    return {
      ok: false,
      status: "unchanged",
      restored: false,
      reason: applied.reason,
    };
  }
  let restored = true;
  if (row.pre_state_json) {
    const pre = JSON.parse(row.pre_state_json) as SqlPreState;
    if (pre && pre.kind === "sql") restored = verifyRestored(db, pre);
  }
  if (!restored) {
    // CRITICAL: replay ran but state not restored — do NOT mark reverted.
    return {
      ok: false,
      status: "unchanged",
      restored: false,
      reason: "reversal_failed_state_not_restored",
    };
  }
  appendDecisionEvent(
    {
      decisionId,
      sequenceNo: nextSequenceNo(decisionId, db),
      eventKind: "reverted",
      payload: { reason: "operator_revert", restored: true },
      occurredAt: nowIso,
    },
    db,
  );
  markReverted(decisionId, nowIso, db);
  return { ok: true, status: "reverted", restored: true };
}
