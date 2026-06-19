/**
 * One triage tick: detect → (throttle) → analyze → persist.
 *
 * Pure orchestration over INJECTED deps, so it's fully unit-testable WITHOUT
 * Prometheus, the DB, or the LLM. The monitor is read-only: the result is
 * persisted and surfaced for the operator, NEVER acted on (no remediation path
 * exists — the hard-stop is structural).
 */

import type { Anomaly, TriageReport, TriageTickResult } from "./types.js";

export interface TriageTickDeps {
  detect: () => Promise<Anomaly[]>;
  /** true → an open report already covers this window; skip (throttle). */
  recentTriageExists: () => boolean;
  analyze: (
    anomalies: Anomaly[],
  ) => Promise<{ report: TriageReport; costUsd: number; model: string } | null>;
  persist: (
    report: TriageReport,
    anomalies: Anomaly[],
    meta: { model?: string; costUsd?: number },
  ) => string;
}

export interface TriageTickLog {
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
}
const NOOP_LOG: TriageTickLog = { info: () => {}, warn: () => {} };

export async function runTriageTick(
  deps: TriageTickDeps,
  log: TriageTickLog = NOOP_LOG,
): Promise<TriageTickResult> {
  const anomalies = await deps.detect();
  if (anomalies.length === 0) {
    log.info("[triage] no anomalies");
    return { triaged: false, anomalies: 0 };
  }

  if (deps.recentTriageExists()) {
    log.info(
      "[triage] anomalies present but a recent open report exists — skipping",
      {
        anomalies: anomalies.length,
      },
    );
    return { triaged: false, anomalies: anomalies.length, throttled: true };
  }

  const analysis = await deps.analyze(anomalies);
  if (!analysis) {
    log.warn(
      "[triage] sub-agent produced no report — writing nothing (conservative)",
      {
        anomalies: anomalies.length,
      },
    );
    return {
      triaged: false,
      anomalies: anomalies.length,
      analysisFailed: true,
    };
  }

  const reportId = deps.persist(analysis.report, anomalies, {
    model: analysis.model,
    costUsd: analysis.costUsd,
  });
  log.info(
    "[triage] report written (awaiting operator review — NOT auto-remediated)",
    {
      reportId,
      severity: analysis.report.severity,
      anomalies: anomalies.length,
    },
  );
  return {
    triaged: true,
    anomalies: anomalies.length,
    reportId,
    severity: analysis.report.severity,
  };
}
