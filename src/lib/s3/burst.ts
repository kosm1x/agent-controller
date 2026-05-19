/**
 * v7.7 Spine 2 (S3 substrate) — correlated-burst detection.
 *
 * Per spec §8: "If 3+ alerts trigger within a 5-minute window across
 * different signals, S3 creates a `bundle_id` linking them and emits ONE
 * consolidated alert." Handles the cascading-bug pattern from
 * `feedback_layered_bug_chains.md` — one root cause manifests as multiple
 * downstream signals.
 *
 * Pure detection — no I/O. Caller (cron tick handler) is responsible for
 * writing the bundle row + updating constituent alerts' `bundle_id`.
 */

import { getDatabase } from "../../db/index.js";
import type { DriftAlertRecord } from "./evaluator.js";

export const BURST_WINDOW_MS = 5 * 60_000; // 5 minutes per spec §8
export const BURST_THRESHOLD = 3; // 3+ alerts → bundle

export interface BurstBundle {
  /** Bundle anchor: the most recent alert in the burst (drives bundle_id). */
  anchor: DriftAlertRecord;
  /** All alerts in the window, including the anchor. */
  members: DriftAlertRecord[];
}

/**
 * Detect bursts in a recent-alerts list. Returns ALL distinct bursts found;
 * caller is responsible for de-duping against already-bundled rows.
 *
 * Algorithm: sort by triggered_at desc; sliding window — for each alert,
 * count alerts within the BURST_WINDOW_MS span AFTER it. If ≥ BURST_THRESHOLD
 * distinct signal_ids, that's a burst. The most-recent alert is the anchor.
 *
 * Bursts only count alerts from DIFFERENT signals — repeated alerts from the
 * same signal in 5min don't constitute a "correlated" pattern, they're just
 * a chronically-tripping signal.
 */
export function detectBursts(alerts: DriftAlertRecord[]): BurstBundle[] {
  if (alerts.length < BURST_THRESHOLD) return [];

  // Sort newest first. ISO-8601 strings sort lexicographically ===
  // chronologically (timezone-uniform UTC suffix), so localeCompare is
  // equivalent to numeric date compare without the Date.parse overhead.
  const sorted = [...alerts].sort((a, b) =>
    b.triggered_at.localeCompare(a.triggered_at),
  );

  const bundles: BurstBundle[] = [];
  const claimedAlertIds = new Set<number>();

  for (let i = 0; i < sorted.length; i++) {
    const anchor = sorted[i];
    if (claimedAlertIds.has(anchor.id)) continue;
    if (anchor.deviation_kind === "correlated_burst") continue; // already-emitted bundles don't re-bundle

    const anchorTime = Date.parse(anchor.triggered_at);
    if (Number.isNaN(anchorTime)) continue;
    const windowStart = anchorTime - BURST_WINDOW_MS;

    const members: DriftAlertRecord[] = [];
    const signalsInBurst = new Set<number>();
    for (let j = i; j < sorted.length; j++) {
      const candidate = sorted[j];
      if (claimedAlertIds.has(candidate.id)) continue;
      if (candidate.deviation_kind === "correlated_burst") continue;
      const t = Date.parse(candidate.triggered_at);
      if (Number.isNaN(t)) continue;
      if (t < windowStart) break; // sorted desc → can stop scanning
      members.push(candidate);
      signalsInBurst.add(candidate.signal_id);
    }

    if (signalsInBurst.size >= BURST_THRESHOLD) {
      bundles.push({ anchor, members });
      for (const m of members) claimedAlertIds.add(m.id);
    }
  }

  return bundles;
}

/**
 * Load all alerts from the last `windowMs` milliseconds that are not yet
 * bundled (bundle_id IS NULL) — the candidate set for burst detection.
 * Excludes already-resolved alerts.
 */
export function loadRecentUnbundledAlerts(
  windowMs: number = BURST_WINDOW_MS,
): DriftAlertRecord[] {
  const sinceIso = new Date(Date.now() - windowMs).toISOString();
  return getDatabase()
    .prepare(
      `SELECT id, signal_id, triggered_at, observed_value_json,
              baseline_value_json, deviation_kind, severity
       FROM drift_alerts
       WHERE triggered_at >= ?
         AND bundle_id IS NULL
         AND resolution_at IS NULL
         AND deviation_kind != 'correlated_burst'
       ORDER BY triggered_at DESC`,
    )
    .all(sinceIso) as DriftAlertRecord[];
}

/**
 * Persist a burst bundle. Inserts a new drift_alerts row with
 * deviation_kind='correlated_burst' as the bundle anchor, then updates each
 * member alert's bundle_id to point at the new anchor row.
 *
 * Severity inherits from the highest-severity member (P0 > P1 > P2).
 */
export function persistBurstBundle(bundle: BurstBundle): number {
  const db = getDatabase();
  const severity = highestSeverity(bundle.members);
  const observedJson = JSON.stringify({
    members: bundle.members.map((m) => ({
      alert_id: m.id,
      signal_id: m.signal_id,
      deviation_kind: m.deviation_kind,
      triggered_at: m.triggered_at,
    })),
    detail: `${bundle.members.length} alerts across ${
      new Set(bundle.members.map((m) => m.signal_id)).size
    } signals within ${BURST_WINDOW_MS / 1000}s window`,
  });

  const tx = db.transaction(() => {
    const result = db
      .prepare(
        `INSERT INTO drift_alerts
           (signal_id, triggered_at, observed_value_json, baseline_value_json,
            deviation_kind, severity, delivery_status)
         VALUES (?, datetime('now'), ?, '{}', 'correlated_burst', ?, 'pending')`,
      )
      .run(bundle.anchor.signal_id, observedJson, severity);
    const bundleId = Number(result.lastInsertRowid);
    const update = db.prepare(
      "UPDATE drift_alerts SET bundle_id = ? WHERE id = ?",
    );
    for (const m of bundle.members) {
      update.run(bundleId, m.id);
    }
    return bundleId;
  });
  return tx();
}

function highestSeverity(alerts: DriftAlertRecord[]): "P0" | "P1" | "P2" {
  for (const a of alerts) if (a.severity === "P0") return "P0";
  for (const a of alerts) if (a.severity === "P1") return "P1";
  return "P2";
}
