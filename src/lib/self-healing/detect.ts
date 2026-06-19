/**
 * Anomaly detection — the read-only health signals the triage monitor watches.
 *
 * `detectAnomalies` is pure orchestration over INJECTED deps (no network / DB
 * coupling), so it unit-tests with canned values. A check whose metric is
 * unavailable (queryPrometheus → null) is SKIPPED, never treated as anomalous —
 * "unknown" must not manufacture a false alarm (fail-closed against false
 * positives, the opposite of the audit-gate verify bug).
 */

import type Database from "better-sqlite3";
import type { Anomaly } from "./types.js";

const PROM_URL = (): string =>
  process.env.ALERT_NOTIFY_PROM_URL ?? "http://127.0.0.1:9090";
const QUERY_TIMEOUT_MS = 5000;
const STUCK_TASK_THRESHOLD = 3;
const STUCK_TASK_MINUTES = 30;

/**
 * One instant-vector Prometheus query → the first sample's value, or `null` if
 * the query failed / returned nothing. NEVER throws — a dead Prometheus must not
 * crash the cron tick (mirrors `prometheus-alert-poller.ts`).
 */
export async function queryPrometheus(expr: string): Promise<number | null> {
  try {
    const url = new URL(`${PROM_URL()}/api/v1/query`);
    url.searchParams.set("query", expr);
    const res = await fetch(url, {
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: { result?: Array<{ value?: [number, string] }> };
    };
    const raw = json.data?.result?.[0]?.value?.[1];
    if (raw === undefined) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Count tasks stuck in 'running' beyond `minutes` — a real stall signal (a
 *  SIGTERM'd deploy or a hung runner leaves these). Defensive: 0 on any error. */
export function getStuckTaskCount(
  db: Database.Database,
  minutes = STUCK_TASK_MINUTES,
): number {
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM tasks
          WHERE status = 'running'
            AND started_at IS NOT NULL
            AND started_at <= datetime('now', '-' || ? || ' minutes')`,
      )
      .get(minutes) as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

/** Recent failed-task error strings to give the analyst grounding. Defensive.
 *  Each error is truncated — it's untrusted grounding interpolated into the
 *  sub-agent prompt, and a runaway error string shouldn't bloat the context (the
 *  hard-stop means even an injected error can't trigger an action — worst case is
 *  a skewed read-only report). */
export function recentTaskErrors(db: Database.Database, limit = 8): string[] {
  try {
    const rows = db
      .prepare(
        `SELECT error FROM tasks
          WHERE status = 'failed' AND error IS NOT NULL AND error <> ''
          ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(limit) as Array<{ error: string }>;
    return rows.map((r) => r.error.slice(0, 500));
  } catch {
    return [];
  }
}

export interface DetectDeps {
  queryPrometheus: (expr: string) => Promise<number | null>;
  getStuckTaskCount: () => number;
}

interface PromCheck {
  kind: Anomaly["kind"];
  metric: string;
  expr: string;
  threshold: number;
  severity: Anomaly["severity"];
  breach: (observed: number, threshold: number) => boolean;
  detail: (observed: number) => string;
}

const PROM_CHECKS: PromCheck[] = [
  {
    kind: "inference_degraded",
    metric: "mc_provider_success_rate",
    expr: "min(mc_provider_success_rate)",
    threshold: 0.8,
    severity: "high",
    breach: (o, t) => o < t,
    detail: (o) => `inference success rate ${(o * 100).toFixed(0)}% < 80%`,
  },
  {
    kind: "tool_error_spike",
    metric: "mc_tool_errors_total",
    expr: "sum(increase(mc_tool_errors_total[10m]))",
    threshold: 10,
    severity: "medium",
    breach: (o, t) => o > t,
    detail: (o) => `${o.toFixed(0)} tool errors in the last 10m (> 10)`,
  },
  {
    kind: "kb_drift",
    metric: "mc_kb_reindex_drift",
    expr: "max(mc_kb_reindex_drift)",
    threshold: 10,
    severity: "low",
    breach: (o, t) => o > t,
    detail: (o) =>
      `${o.toFixed(0)} FS-only files not yet in jarvis_files (> 10)`,
  },
  {
    kind: "messaging_flap",
    metric: "mc_whatsapp_disconnects_total",
    expr: "sum(increase(mc_whatsapp_disconnects_total[15m]))",
    threshold: 3,
    severity: "medium",
    breach: (o, t) => o > t,
    detail: (o) => `${o.toFixed(0)} WhatsApp disconnects in 15m (> 3)`,
  },
];

/**
 * Detect current anomalies across Prometheus metrics + the DB stuck-task signal.
 * Skips any metric Prometheus can't answer (null) rather than flagging it.
 */
export async function detectAnomalies(deps: DetectDeps): Promise<Anomaly[]> {
  const anomalies: Anomaly[] = [];

  for (const c of PROM_CHECKS) {
    const observed = await deps.queryPrometheus(c.expr);
    if (observed === null) continue; // metric unavailable → cannot assert anomaly
    if (c.breach(observed, c.threshold)) {
      anomalies.push({
        kind: c.kind,
        metric: c.metric,
        observed,
        threshold: c.threshold,
        severity: c.severity,
        detail: c.detail(observed),
      });
    }
  }

  // Budget: daily spend over the configured limit.
  const limit = Number(process.env.BUDGET_DAILY_LIMIT_USD ?? "10");
  const spend = await deps.queryPrometheus("max(mc_budget_daily_spend_usd)");
  if (spend !== null && spend > limit) {
    anomalies.push({
      kind: "budget_overrun",
      metric: "mc_budget_daily_spend_usd",
      observed: spend,
      threshold: limit,
      severity: "high",
      detail: `daily spend $${spend.toFixed(2)} over the $${limit.toFixed(2)} limit`,
    });
  }

  // Stuck tasks: a DB signal, not Prometheus.
  const stuck = deps.getStuckTaskCount();
  if (stuck > STUCK_TASK_THRESHOLD) {
    anomalies.push({
      kind: "stuck_tasks",
      metric: "tasks.status=running",
      observed: stuck,
      threshold: STUCK_TASK_THRESHOLD,
      severity: "high",
      detail: `${stuck} tasks stuck in 'running' > ${STUCK_TASK_MINUTES}m (> ${STUCK_TASK_THRESHOLD})`,
    });
  }

  return anomalies;
}
