/**
 * Ritual delivery policy — decides whether a completed ritual's text is
 * broadcast to the operator or kept on disk/DB only.
 *
 * Phase 0.3 of docs/planning/jarvis-usability-plan-2026-08-22.md, operator
 * ruling 2 (2026-08-22):
 *   - `evolution-log` and `day-narrative` are never broadcast (they are
 *     committed/persisted by their own rituals; the evening message is the
 *     nightly close).
 *   - `pm-daily-rebalance` is change-only: 22 consecutive zero-order reports
 *     with the same 198 rejections were pushed at 04:00 MX. Deliver only when
 *     orders were planned/filled, the run reports an error, or the report's
 *     numeric fingerprint differs from the last DELIVERED one.
 *
 * Every decision is recorded in `ritual_deliveries` (delivered 0/1 + reason)
 * so the metrics script can count silences as successes and Phase 5 can
 * reuse the table as its sent-before ledger.
 */

import { getDatabase } from "../db/index.js";

export const SUPPRESSED_RITUALS: ReadonlySet<string> = new Set([
  "evolution-log",
  "day-narrative",
]);

export const CHANGE_ONLY_RITUALS: ReadonlySet<string> = new Set([
  "pm-daily-rebalance",
]);

export interface DeliveryDecision {
  deliver: boolean;
  reason:
    | "default"
    | "suppressed"
    | "orders"
    | "error"
    | "changed"
    | "unchanged"
    | "first";
  fingerprint: string | null;
}

/**
 * Error EVENTS only. "stale" is deliberately absent: the PM prompt instructs
 * the model to write "Alertas: (stale markets, …)" so every normal report
 * contains the word (R1 audit W1 — 3 of 6 real reports matched it). A
 * negated mention ("Sin stale-position abort", report 8473) is not an event.
 */
const ERROR_RE =
  /(?<!\b(?:sin|no hay|no hubo|ning[uú]n[ao]?)\s+(?:[\w-]+\s+){0,2})\b(?:error|abort\w*|fall[óo]|exception|no pude|timeout)\b|❌/i;

/**
 * `Órdenes: 0/0/0`, `Órdenes: 0 planned / 0 filled / 0 rejected`,
 * `**Órdenes:** 0 planeadas / 0 ejecutadas / 0 rechazadas` — the first two
 * numbers (planned, filled) decide "activity".
 */
const ORDERS_RE = /[ÓO]rdenes:?\**[^\d\n]*(\d+)[^\d\n]+(\d+)[^\d\n]+(\d+)/i;

/**
 * Numeric fingerprint of the report: the Universo / Pesos / Rechazos /
 * Órdenes figures, captured by field — not by line, because the real format
 * puts `Equity … | Cash … | Órdenes: …` on ONE line and the Alertas bullets
 * say "sin órdenes" (R1 audit W1). Prices, horizon years and dates are thus
 * never part of the comparison. A missing field fingerprints as "?".
 */
const FIELD_RES: ReadonlyArray<RegExp> = [
  /Universo:?\**\s*(\d+)/i,
  /Pesos:?\**\s*\+?(\d+)[^\d\n]+(\d+)/i,
  /Rechazos:?\**\s*(\d+)/i,
  ORDERS_RE,
];

export function fingerprintReport(text: string): string {
  const parts: string[] = [];
  for (const re of FIELD_RES) {
    const m = re.exec(text);
    parts.push(m ? m.slice(1).join("/") : "?");
  }
  return parts.join("|");
}

export function decideRitualDelivery(
  ritualId: string,
  text: string,
  lastDeliveredFingerprint: string | null,
): DeliveryDecision {
  if (SUPPRESSED_RITUALS.has(ritualId)) {
    return { deliver: false, reason: "suppressed", fingerprint: null };
  }
  if (!CHANGE_ONLY_RITUALS.has(ritualId)) {
    return { deliver: true, reason: "default", fingerprint: null };
  }
  const fingerprint = fingerprintReport(text);
  const m = ORDERS_RE.exec(text);
  if (m && (Number(m[1]) > 0 || Number(m[2]) > 0)) {
    return { deliver: true, reason: "orders", fingerprint };
  }
  if (ERROR_RE.test(text)) {
    return { deliver: true, reason: "error", fingerprint };
  }
  if (lastDeliveredFingerprint === null) {
    return { deliver: true, reason: "first", fingerprint };
  }
  if (fingerprint !== lastDeliveredFingerprint) {
    return { deliver: true, reason: "changed", fingerprint };
  }
  return { deliver: false, reason: "unchanged", fingerprint };
}

// --- ledger ----------------------------------------------------------------

export function ensureRitualDeliveriesTable(): void {
  getDatabase().exec(`
    CREATE TABLE IF NOT EXISTS ritual_deliveries (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ritual_id   TEXT NOT NULL,
      task_id     TEXT,
      fingerprint TEXT,
      delivered   INTEGER NOT NULL,
      reason      TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ritual_deliveries_ritual
      ON ritual_deliveries(ritual_id, created_at);
  `);
}

export function lastDeliveredFingerprint(ritualId: string): string | null {
  const row = getDatabase()
    .prepare(
      "SELECT fingerprint FROM ritual_deliveries WHERE ritual_id = ? AND delivered = 1 ORDER BY id DESC LIMIT 1",
    )
    .get(ritualId) as { fingerprint: string | null } | undefined;
  return row?.fingerprint ?? null;
}

export function recordRitualDelivery(
  ritualId: string,
  taskId: string,
  decision: DeliveryDecision,
): void {
  getDatabase()
    .prepare(
      "INSERT INTO ritual_deliveries (ritual_id, task_id, fingerprint, delivered, reason) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      ritualId,
      taskId,
      decision.fingerprint,
      decision.deliver ? 1 : 0,
      decision.reason,
    );
}

/**
 * One-call wrapper for the router: ensure table, look up the last delivered
 * fingerprint, decide, record. Any DB failure falls back to DELIVER (a broken
 * ledger must not silence the operator).
 */
export function applyRitualDeliveryPolicy(
  ritualId: string,
  taskId: string,
  text: string,
): DeliveryDecision {
  try {
    ensureRitualDeliveriesTable();
    const last = CHANGE_ONLY_RITUALS.has(ritualId)
      ? lastDeliveredFingerprint(ritualId)
      : null;
    const decision = decideRitualDelivery(ritualId, text, last);
    recordRitualDelivery(ritualId, taskId, decision);
    return decision;
  } catch (err) {
    console.error(`[rituals] delivery-policy failed (delivering):`, err);
    return { deliver: true, reason: "default", fingerprint: null };
  }
}
