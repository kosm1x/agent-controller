/**
 * v7.7 Spine 2 (S3 substrate) — tolerance evaluator.
 *
 * Pure module: given an observed value, a baseline, and a tolerance rule,
 * return {tripped, deviationKind}. No I/O, no DB.
 *
 * The 5 tolerance kinds (spec §5):
 *   - absolute_threshold: numeric compare against a literal (gt/gte/lt/lte/eq/neq)
 *   - pct_drift_from_baseline: observed deviates from baseline by ≥ pct
 *   - enum_match: observed must be one of expected[]
 *   - absent: signal didn't fire in the past window_minutes
 *   - window_breach: observed must be within [min, max]
 *
 * Deviation kinds (spec §8 drift_alerts.deviation_kind enum):
 *   above | below | absent | changed | query_failure | correlated_burst
 */

export type ToleranceRule =
  | {
      kind: "absolute_threshold";
      op: "gt" | "gte" | "lt" | "lte" | "eq" | "neq";
      value: number;
    }
  | { kind: "pct_drift_from_baseline"; pct: number }
  | { kind: "enum_match"; expected: string[] }
  | { kind: "absent"; window_minutes: number }
  | { kind: "window_breach"; min?: number; max?: number };

/** Same enum as drift_alerts.deviation_kind (spec §8). */
export type DeviationKind =
  | "above"
  | "below"
  | "absent"
  | "changed"
  | "query_failure"
  | "correlated_burst";

export interface ToleranceResult {
  /** True when the observed value exceeds tolerance — caller should emit alert. */
  tripped: boolean;
  /** When tripped, classify the deviation for the drift_alerts row. */
  deviationKind: DeviationKind | null;
  /** Optional human-readable explanation for logs / alert details. */
  detail?: string;
}

/**
 * Baseline payload shape — flexible JSON. For numeric signals the convention
 * is {"value": N}; for enum signals {"expected": ["..."]}; for absent
 * signals {"last_seen_at": "..."} or {}. The evaluator extracts what each
 * tolerance kind needs.
 */
export interface BaselinePayload {
  value?: number;
  expected?: string[];
  last_seen_at?: string;
  // Open shape — additional fields allowed for signal-specific context.
  [k: string]: unknown;
}

/**
 * Evaluate one observation against the baseline + tolerance rule.
 *
 * Defensive: returns `tripped:false` on undefined/null observed when the
 * tolerance kind isn't `absent`. Signal-side query failures are handled
 * separately by the evaluator (they become deviation_kind='query_failure'),
 * not by this function.
 */
export function evaluateTolerance(
  observed: number | string | null | undefined,
  baseline: BaselinePayload,
  tolerance: ToleranceRule,
): ToleranceResult {
  switch (tolerance.kind) {
    case "absolute_threshold":
      return evalAbsoluteThreshold(observed, tolerance);
    case "pct_drift_from_baseline":
      return evalPctDrift(observed, baseline, tolerance);
    case "enum_match":
      return evalEnumMatch(observed, tolerance);
    case "absent":
      return evalAbsent(observed, baseline, tolerance);
    case "window_breach":
      return evalWindowBreach(observed, tolerance);
  }
}

function evalAbsoluteThreshold(
  observed: number | string | null | undefined,
  rule: Extract<ToleranceRule, { kind: "absolute_threshold" }>,
): ToleranceResult {
  if (typeof observed !== "number" || !Number.isFinite(observed)) {
    return { tripped: false, deviationKind: null };
  }
  const v = rule.value;
  let tripped = false;
  switch (rule.op) {
    case "gt":
      tripped = observed > v;
      break;
    case "gte":
      tripped = observed >= v;
      break;
    case "lt":
      tripped = observed < v;
      break;
    case "lte":
      tripped = observed <= v;
      break;
    case "eq":
      tripped = observed === v;
      break;
    case "neq":
      tripped = observed !== v;
      break;
  }
  if (!tripped) return { tripped: false, deviationKind: null };
  const kind: DeviationKind =
    observed > v ? "above" : observed < v ? "below" : "changed";
  return {
    tripped: true,
    deviationKind: kind,
    detail: `observed ${observed} ${rule.op} ${v}`,
  };
}

function evalPctDrift(
  observed: number | string | null | undefined,
  baseline: BaselinePayload,
  rule: Extract<ToleranceRule, { kind: "pct_drift_from_baseline" }>,
): ToleranceResult {
  if (typeof observed !== "number" || !Number.isFinite(observed)) {
    return { tripped: false, deviationKind: null };
  }
  const base = baseline.value;
  if (typeof base !== "number" || !Number.isFinite(base) || base === 0) {
    // No usable baseline. NOT tripped (better to bias toward silence than noise).
    return { tripped: false, deviationKind: null };
  }
  const drift = Math.abs(observed - base) / Math.abs(base);
  if (drift < rule.pct) return { tripped: false, deviationKind: null };
  const kind: DeviationKind = observed > base ? "above" : "below";
  return {
    tripped: true,
    deviationKind: kind,
    detail: `observed ${observed} drifts ${(drift * 100).toFixed(1)}% from baseline ${base} (threshold ${(rule.pct * 100).toFixed(1)}%)`,
  };
}

function evalEnumMatch(
  observed: number | string | null | undefined,
  rule: Extract<ToleranceRule, { kind: "enum_match" }>,
): ToleranceResult {
  const obsStr = typeof observed === "string" ? observed : String(observed);
  if (obsStr === "" || observed === null || observed === undefined) {
    return { tripped: false, deviationKind: null };
  }
  if (rule.expected.includes(obsStr)) {
    return { tripped: false, deviationKind: null };
  }
  return {
    tripped: true,
    deviationKind: "changed",
    detail: `observed "${obsStr}" not in expected [${rule.expected.join(", ")}]`,
  };
}

function evalAbsent(
  observed: number | string | null | undefined,
  baseline: BaselinePayload,
  rule: Extract<ToleranceRule, { kind: "absent" }>,
): ToleranceResult {
  // observed for the `absent` kind is conventionally the timestamp of the
  // last-seen event (numeric ms or ISO string), OR null if no events yet.
  // Trips when (now - last_seen) > window_minutes.
  let lastSeenMs: number | null = null;
  if (typeof observed === "number" && Number.isFinite(observed)) {
    lastSeenMs = observed;
  } else if (typeof observed === "string" && observed.length > 0) {
    const t = Date.parse(observed);
    if (!Number.isNaN(t)) lastSeenMs = t;
  } else if (
    typeof baseline.last_seen_at === "string" &&
    baseline.last_seen_at.length > 0
  ) {
    // Fall back to baseline-side last_seen_at if observed didn't supply
    const t = Date.parse(baseline.last_seen_at);
    if (!Number.isNaN(t)) lastSeenMs = t;
  }
  if (lastSeenMs === null) {
    // No record of last-seen at all → can't decide; bias toward silence.
    return { tripped: false, deviationKind: null };
  }
  const ageMs = Date.now() - lastSeenMs;
  const windowMs = rule.window_minutes * 60_000;
  if (ageMs <= windowMs) return { tripped: false, deviationKind: null };
  return {
    tripped: true,
    deviationKind: "absent",
    detail: `last_seen ${Math.round(ageMs / 60_000)}min ago (window ${rule.window_minutes}min)`,
  };
}

function evalWindowBreach(
  observed: number | string | null | undefined,
  rule: Extract<ToleranceRule, { kind: "window_breach" }>,
): ToleranceResult {
  if (typeof observed !== "number" || !Number.isFinite(observed)) {
    return { tripped: false, deviationKind: null };
  }
  if (rule.min !== undefined && observed < rule.min) {
    return {
      tripped: true,
      deviationKind: "below",
      detail: `observed ${observed} below min ${rule.min}`,
    };
  }
  if (rule.max !== undefined && observed > rule.max) {
    return {
      tripped: true,
      deviationKind: "above",
      detail: `observed ${observed} above max ${rule.max}`,
    };
  }
  return { tripped: false, deviationKind: null };
}
