/**
 * Persist + throttle helpers for the triage monitor.
 *
 * `persistTriageReport` writes the diagnosis to `triage_report`. The report is a
 * read-only artifact — `recommended_json` is stored for the operator to read, and
 * NOTHING reads it back to act. `hasOpenTriageWithin` throttles: while an open
 * (unacknowledged) report exists in the window, the monitor does not pile up
 * duplicate reports for the same ongoing issue.
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Anomaly, TriageReport } from "./types.js";

export function persistTriageReport(
  db: Database.Database,
  report: TriageReport,
  anomalies: Anomaly[],
  meta: { model?: string; costUsd?: number } = {},
): string {
  const reportId = randomUUID();
  db.prepare(
    `INSERT INTO triage_report
       (report_id, severity, anomalies_json, root_cause, affected_json,
        recommended_json, confidence, model, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    reportId,
    report.severity,
    JSON.stringify(anomalies),
    report.rootCause,
    JSON.stringify(report.affectedComponents),
    JSON.stringify(report.recommendedActions),
    report.confidence,
    meta.model ?? null,
    meta.costUsd ?? null,
  );
  return reportId;
}

/** True if an unacknowledged triage report was written within the last `hours`. */
export function hasOpenTriageWithin(
  db: Database.Database,
  hours: number,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS x FROM triage_report
        WHERE acknowledged_at IS NULL
          AND created_at >= datetime('now', '-' || ? || ' hours')
        LIMIT 1`,
    )
    .get(hours) as { x: number } | undefined;
  return row !== undefined;
}
