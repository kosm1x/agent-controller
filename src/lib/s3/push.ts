/**
 * v7.7 Spine 2 Bundle 3 — P0 push notification dispatcher.
 *
 * Per spec §8: P0 alerts ALSO surface via push notification (not waiting
 * for next morning brief). This module:
 *
 *   1. Composes push messages from the set of (P0 alerts, bundles) emitted
 *      during a cadence tick.
 *   2. Dispatches them via the existing `messageRouter.broadcastToAll()`
 *      (non-email channels: Telegram + WhatsApp).
 *
 * Design choice: dispatch from `runCadenceTick` AFTER burst detection,
 * NOT from `evaluateSignal` directly. A 5-P0-alert burst would otherwise
 * emit 5 separate pushes; post-burst dispatch consolidates by bundle and
 * sends ONE message per bundle + one per un-bundled P0. Bounded notification
 * volume.
 *
 * Failure semantics: push failures log + increment `mc_s3_push_errors_total`
 * but NEVER block the cron tick or the morning brief. Operator can always
 * query `drift_alerts` directly. The morning brief delivery path (Bundle 2)
 * is the durable channel; push is the fast channel.
 */

import { getDatabase } from "../../db/index.js";
import { formatRelativeTime } from "./delivery.js";

export interface PushAlertRow {
  id: number;
  signal_name: string;
  source_substrate: string;
  triggered_at: string;
  observed_value_json: string;
  deviation_kind: string;
  severity: "P0" | "P1" | "P2";
  bundle_id: number | null;
}

export interface PushMessage {
  /** Concrete text to broadcast. */
  text: string;
  /** drift_alerts.id of the source row (single alert) or bundle anchor. */
  alertId: number;
  /** Whether this message represents a correlated burst bundle. */
  isBundle: boolean;
}

/**
 * Load P0 alerts newly emitted in the current tick window. The scheduler
 * passes the list of `alertId`s it just inserted; we look them up + filter
 * by severity=P0 + status=pending. This avoids re-pushing already-delivered
 * alerts on every cron tick.
 */
export function loadNewlyEmittedP0Alerts(alertIds: number[]): PushAlertRow[] {
  if (alertIds.length === 0) return [];
  const db = getDatabase();
  const placeholders = alertIds.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT a.id, s.signal_name AS signal_name, s.source_substrate AS source_substrate,
              a.triggered_at, a.observed_value_json, a.deviation_kind, a.severity,
              a.bundle_id
       FROM drift_alerts a
       LEFT JOIN drift_signals s ON s.id = a.signal_id
       WHERE a.id IN (${placeholders})
         AND a.severity = 'P0'
         AND a.delivery_status = 'pending'
         AND a.resolution_at IS NULL
       ORDER BY a.triggered_at ASC`,
    )
    .all(...alertIds) as PushAlertRow[];
}

/**
 * Compose push messages from a set of P0 alerts. Burst dedup:
 *   - Alerts with bundle_id != null → grouped under the bundle anchor (ONE
 *     message per bundle, regardless of member count).
 *   - Alerts with bundle_id == null → ONE message per alert.
 *
 * The bundle case shows the consolidated count + first 3 member signal names
 * so the operator gets quick triage context.
 */
export function composePushMessages(alerts: PushAlertRow[]): PushMessage[] {
  const messages: PushMessage[] = [];
  const seenBundles = new Set<number>();
  const bundleMembers = new Map<number, PushAlertRow[]>();

  // First pass: group by bundle
  for (const a of alerts) {
    if (a.bundle_id !== null) {
      const arr = bundleMembers.get(a.bundle_id) ?? [];
      arr.push(a);
      bundleMembers.set(a.bundle_id, arr);
    }
  }

  // Second pass: emit messages in original order
  for (const a of alerts) {
    if (a.bundle_id !== null) {
      if (seenBundles.has(a.bundle_id)) continue;
      seenBundles.add(a.bundle_id);
      const members = bundleMembers.get(a.bundle_id) ?? [a];
      messages.push(composeBundleMessage(a.bundle_id, members));
    } else {
      messages.push(composeSingleMessage(a));
    }
  }
  return messages;
}

function composeSingleMessage(a: PushAlertRow): PushMessage {
  const observed = extractObserved(a.observed_value_json);
  const signal = a.signal_name ?? `<deleted signal ${a.id}>`;
  const substrate = a.source_substrate ?? "<unknown>";
  return {
    text: `[S3 P0] ${signal} (${substrate}) — ${a.deviation_kind}, observado: ${observed}\n  disparado ${formatRelativeTime(a.triggered_at)}\n  ack: POST /api/admin/alerts/${a.id}/suppress`,
    alertId: a.id,
    isBundle: false,
  };
}

function composeBundleMessage(
  bundleId: number,
  members: PushAlertRow[],
): PushMessage {
  const sorted = [...members].sort((x, y) =>
    x.triggered_at.localeCompare(y.triggered_at),
  );
  // R1-W2 fold: map orphan rows to their per-id placeholder BEFORE the Set
  // dedup. Otherwise multiple orphans (signal_name=null) collapse into a
  // single Set entry and the "across N signals" count under-reports.
  const placeholderForRow = (m: PushAlertRow) =>
    m.signal_name ?? `<signal ${m.id}>`;
  const sample = sorted.slice(0, 3).map(placeholderForRow).join(", ");
  const extra = members.length > 3 ? ` (+${members.length - 3} más)` : "";
  const distinctSignals = new Set(members.map(placeholderForRow)).size;
  return {
    text: `[S3 P0 BURST] correlated burst — ${members.length} P0 alerts across ${distinctSignals} signals\n  signals: ${sample}${extra}\n  ack the bundle: POST /api/admin/alerts/${bundleId}/suppress`,
    alertId: bundleId,
    isBundle: true,
  };
}

function extractObserved(json: string): string {
  try {
    const parsed = JSON.parse(json) as {
      value?: unknown;
      error?: string;
    };
    if (typeof parsed.error === "string" && parsed.error.length > 0) {
      return `error (${parsed.error.slice(0, 80)})`;
    }
    if (parsed.value === null || parsed.value === undefined) return "null";
    if (typeof parsed.value === "number") {
      return Math.round(parsed.value * 10000) / 10000 + "";
    }
    return String(parsed.value).slice(0, 80);
  } catch {
    return json.slice(0, 80);
  }
}

/**
 * Fire-and-forget push dispatch. `router` is the MessageRouter from
 * `getRouter()` — may be null when messaging is disabled (test env / no
 * channels configured). Failures log + bump the prom counter; never throw.
 *
 * Returns the number of messages successfully dispatched (best-effort
 * count — broadcastToAll itself swallows per-channel failures).
 */
/**
 * Type the relevant slice of MessageRouter that dispatchPushAlerts uses.
 * `broadcastToAll` takes an optional onChannelFailure callback (R1-C1 fold)
 * so we can observe per-channel failures even though `broadcastToAll`
 * itself never rejects (it swallows + logs in `Promise.all`).
 */
type PushRouter = {
  broadcastToAll: (
    text: string,
    onChannelFailure?: (channelName: string, err: unknown) => void,
  ) => Promise<void>;
};

export async function dispatchPushAlerts(
  router: PushRouter | null,
  messages: PushMessage[],
): Promise<number> {
  if (!router) {
    if (messages.length > 0) {
      console.warn(
        `[s3-push] router unavailable; ${messages.length} P0 push(es) NOT sent. Alerts still persisted in drift_alerts.`,
      );
      // R1-W1 fold: bump the counter on permanent unavailability so the
      // `router_unavailable` label is actually exercised (was declared but
      // unused before this fold).
      try {
        const { recordS3PushError } =
          await import("../../observability/prometheus.js");
        recordS3PushError("router_unavailable");
      } catch {
        /* counter shouldn't block delivery */
      }
    }
    return 0;
  }
  // R1-C1 fold: track per-channel failures via callback. Without this, the
  // mc_s3_push_errors_total counter never fires in production because
  // broadcastToAll swallows per-channel rejections via inner .catch BEFORE
  // its outer await resolves. Same class as feedback_prometheus_counter_recovery_path.
  let perBroadcastFailures = 0;
  const onChannelFailure = (_channel: string, _err: unknown): void => {
    perBroadcastFailures += 1;
  };

  let sent = 0;
  for (const msg of messages) {
    const failuresBefore = perBroadcastFailures;
    try {
      await router.broadcastToAll(msg.text, onChannelFailure);
      // If any channel-level failure landed during this broadcast, surface
      // it via the counter. We don't know exactly which channel without
      // a more invasive API; bucket as "broadcast" matches the spec.
      if (perBroadcastFailures > failuresBefore) {
        try {
          const { recordS3PushError } =
            await import("../../observability/prometheus.js");
          for (let i = 0; i < perBroadcastFailures - failuresBefore; i++) {
            recordS3PushError("broadcast");
          }
        } catch {
          /* counter shouldn't block delivery */
        }
      } else {
        sent += 1;
      }
    } catch (err) {
      // broadcastToAll itself almost never rejects (Promise.all of
      // .catch-wrapped sends), but if it does, route through the same path.
      console.error(
        `[s3-push] broadcast threw for alert ${msg.alertId}:`,
        err instanceof Error ? err.message : err,
      );
      try {
        const { recordS3PushError } =
          await import("../../observability/prometheus.js");
        recordS3PushError("broadcast");
      } catch {
        /* counter shouldn't block delivery */
      }
    }
  }
  return sent;
}
