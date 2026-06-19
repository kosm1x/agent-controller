/**
 * Self-healing triage monitor — shared types.
 *
 * The monitor is READ-ONLY: it detects health anomalies, has a sub-agent
 * root-cause them, and persists a triage REPORT. It NEVER remediates — there is
 * no code path that executes `recommendedActions`; the hard-stop is structural
 * (absence of a remediation path), not a runtime boolean.
 */

export type Severity = "critical" | "high" | "medium" | "low";

export type AnomalyKind =
  | "stuck_tasks"
  | "inference_degraded"
  | "tool_error_spike"
  | "budget_overrun"
  | "kb_drift"
  | "messaging_flap";

/** One detected health anomaly (a metric breached its threshold). */
export interface Anomaly {
  kind: AnomalyKind;
  /** human-readable description, e.g. "inference success rate 68% < 80%". */
  detail: string;
  /** the metric / query name that produced `observed`. */
  metric: string;
  observed: number;
  threshold: number;
  severity: Severity;
}

/** The sub-agent's structured diagnosis. `recommendedActions` are OPERATOR-facing
 *  only — nothing here is ever auto-executed. */
export interface TriageReport {
  severity: Severity;
  rootCause: string;
  affectedComponents: string[];
  recommendedActions: string[];
  confidence: "high" | "medium" | "low";
}

export interface TriageTickResult {
  triaged: boolean;
  anomalies: number;
  throttled?: boolean;
  analysisFailed?: boolean;
  reportId?: string;
  severity?: Severity;
}
