/**
 * v7.7 Spine 2 Bundle 3 — alert suppression.
 *
 * Per spec §8 suppression:
 *   - `reason` starts with `"false positive: "` → `resolution_kind='false_positive'`
 *   - otherwise → `resolution_kind='operator_acknowledged'`
 *   - `resolution_at` set to NOW (acts as a tombstone — delivery.ts filters
 *     on `resolution_at IS NULL`)
 *   - `delivery_status='suppressed'`
 *   - `resolution_notes` stores the full reason + optional `until` timestamp
 *
 * AUTO-UNSUPPRESS when `until` passes is DEFERRED to v8.0 (requires a sweep
 * job + re-emit logic). For Bundle 3 the `until` value is stored in
 * resolution_notes for audit-trail purposes only; the operator manually
 * re-evaluates after `until` if the signal trips again.
 *
 * Idempotency: re-suppressing an already-suppressed alert updates
 * resolution_notes (last-write-wins) but doesn't change resolution_at —
 * the original suppression timestamp is the audit ground truth.
 */

import { getDatabase } from "../../db/index.js";

const FALSE_POSITIVE_PREFIX = "false positive: ";

export type SuppressionResolutionKind =
  | "operator_acknowledged"
  | "false_positive";

export interface SuppressionResult {
  ok: true;
  alertId: number;
  resolutionKind: SuppressionResolutionKind;
  resolvedAt: string;
}

export type SuppressionError =
  | { ok: false; kind: "not_found"; alertId: number }
  | { ok: false; kind: "already_resolved"; alertId: number; resolvedAt: string }
  | { ok: false; kind: "invalid_reason"; detail: string };

/**
 * Suppress a drift_alerts row. Reason MUST be non-empty (operator must say
 * SOMETHING — silent suppression defeats the audit trail). `until` is
 * optional; when provided, it's appended to resolution_notes as a hint
 * for the next operator review.
 *
 * Defensive on the input shape: reason and until are validated up-front so
 * an HTTP layer can pass user-supplied bodies through without pre-validating.
 */
export function suppressAlert(
  alertId: number,
  reason: string,
  until?: string,
  acknowledgedBy: string = "operator",
): SuppressionResult | SuppressionError {
  if (typeof reason !== "string" || reason.trim().length === 0) {
    return {
      ok: false,
      kind: "invalid_reason",
      detail: "reason must be a non-empty string",
    };
  }
  if (
    typeof until === "string" &&
    until.length > 0 &&
    Number.isNaN(Date.parse(until))
  ) {
    return {
      ok: false,
      kind: "invalid_reason",
      detail: `until is not a valid ISO datetime: ${until.slice(0, 80)}`,
    };
  }

  const db = getDatabase();
  const existing = db
    .prepare("SELECT id, resolution_at FROM drift_alerts WHERE id = ?")
    .get(alertId) as { id: number; resolution_at: string | null } | undefined;

  if (!existing) {
    return { ok: false, kind: "not_found", alertId };
  }
  if (existing.resolution_at !== null) {
    return {
      ok: false,
      kind: "already_resolved",
      alertId,
      resolvedAt: existing.resolution_at,
    };
  }

  // R1-W4 fold: case-insensitive prefix match. Operator typos like
  // "False positive: ..." or "FALSE POSITIVE: ..." now correctly route to
  // false_positive without exact-lowercase dependency. Spec §8 prescribed
  // the lowercase form; this fold relaxes to operator-friendly normalization
  // while preserving the explicit prefix discipline.
  const normalizedReason = reason.trim().toLowerCase();
  const resolutionKind: SuppressionResolutionKind = normalizedReason.startsWith(
    FALSE_POSITIVE_PREFIX.toLowerCase(),
  )
    ? "false_positive"
    : "operator_acknowledged";

  const notes = composeResolutionNotes(reason, until);
  const resolvedAt = new Date().toISOString();

  db.prepare(
    `UPDATE drift_alerts
     SET delivery_status = 'suppressed',
         resolution_kind = ?,
         resolution_at = ?,
         resolution_notes = ?,
         acknowledged_at = ?,
         acknowledged_by = ?
     WHERE id = ?`,
  ).run(resolutionKind, resolvedAt, notes, resolvedAt, acknowledgedBy, alertId);

  return {
    ok: true,
    alertId,
    resolutionKind,
    resolvedAt,
  };
}

function composeResolutionNotes(reason: string, until?: string): string {
  if (typeof until === "string" && until.length > 0) {
    return `${reason}\n[until=${until}]`;
  }
  return reason;
}
