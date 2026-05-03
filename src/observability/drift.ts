/**
 * V8 substrate S3 — out-of-band drift detector.
 *
 * Compares the running process environment against declarative invariants
 * tracked in source. Catches silent drift like the qwen3.6 model swap that
 * lives in `.env` but not in git, scheduled tasks that fall off, env vars
 * that revert during incident response, etc.
 *
 * Usage:
 *   const drifts = checkDrift();          // scan default invariants
 *   const drifts = checkDrift([], envOverride);  // injectable for tests
 *
 * Exposed via `GET /api/admin/drift` and `mc-ctl drift`. The CLI exits
 * non-zero on any drift, suitable for cron-based alerting.
 *
 * Source-of-truth note: this detector reads `process.env`, which reflects
 * what systemd actually launched the service with. If the systemd unit's
 * Environment= directive overrides `.env`, the detector reports the systemd
 * value, not the `.env` value. That's the right semantic — we care about
 * running config, not what the operator thinks should be running. If a drift
 * confuses you, check `cat /proc/$(pgrep -f mission-control)/environ`.
 */

export type DriftSeverity = "critical" | "warning" | "info";

export type DriftStatus =
  | "missing" // env var required but not set
  | "different" // value present but != expected
  | "pattern-mismatch"; // value present but doesn't match pattern

export interface Invariant {
  /** Env var or config key being checked. */
  key: string;
  /** What the operator expects. Used in drift report human output. */
  description: string;
  /** Equality check — actual must equal this string. */
  expected?: string;
  /** Presence check — actual must be set (any non-empty value). */
  required?: boolean;
  /** Pattern check — actual must match this regex. */
  pattern?: RegExp;
  /** Severity classifier for the drift report. */
  severity: DriftSeverity;
}

export interface DriftRecord {
  key: string;
  description: string;
  expected: string;
  actual: string;
  status: DriftStatus;
  severity: DriftSeverity;
}

/**
 * Default invariants — current operator expectations as of 2026-04-29.
 * Update this list as production config evolves; the goal is to catch
 * UNINTENDED changes, not block intentional ones.
 *
 * Severity guide:
 *   critical = breaks core functionality (inference primary, DB path)
 *   warning  = degrades quality but service runs (model swap, recall config)
 *   info     = observability nicety (logging level, etc.)
 */
export const DEFAULT_INVARIANTS: readonly Invariant[] = [
  // --- Inference ---
  {
    key: "INFERENCE_PRIMARY_PROVIDER",
    description: "Primary LLM provider for tool-calling fast/heavy/swarm",
    expected: "claude-sdk",
    severity: "critical",
  },
  {
    key: "INFERENCE_PRIMARY_MODEL",
    description:
      "Direct-inference aux model (classifier, enhancer, ritual extractors)",
    expected: "qwen3.6-plus",
    severity: "warning",
  },
  // --- Hindsight ---
  {
    key: "HINDSIGHT_URL",
    description: "Hindsight memory service URL",
    pattern: /^https?:\/\/.+/,
    severity: "critical",
  },
  {
    key: "HINDSIGHT_RECALL_ENABLED",
    description: "Hindsight recall path (re-enabled session 112 after rehab)",
    expected: "true",
    severity: "warning",
  },
  {
    key: "HINDSIGHT_RECALL_TIMEOUT_MS",
    description:
      "Recall client timeout (session 123 Path-1 tune: 5000→8000ms to reduce abort rate on the 1,637-mem mc-jarvis bank)",
    // qa-auditor C1 (2026-04-29): exact match — pattern was too permissive.
    // The whole point of this invariant is catching drift back to the
    // pre-rehab 1500ms or operator-typo'd 50000ms. If we want to tune this
    // intentionally, update the expected value here in source so the change
    // is git-tracked.
    //
    // 2026-05-03 Session 124 audit caught this — Path-1 tune raised actual
    // to 8000 but the declared invariant still said 5000. Updated to match.
    expected: "8000",
    severity: "warning",
  },
  // --- Locale / TZ ---
  {
    key: "TZ",
    description: "All scheduled tasks + day-log timestamps assume MX time",
    expected: "America/Mexico_City",
    severity: "warning",
  },
] as const;

/**
 * Compare a single env value against an invariant.
 * Returns null if no drift detected; otherwise a DriftRecord.
 */
export function checkInvariant(
  inv: Invariant,
  actual: string | undefined,
): DriftRecord | null {
  // Presence check (treat empty string as missing)
  const isSet = typeof actual === "string" && actual.length > 0;

  if (inv.required && !isSet) {
    return {
      key: inv.key,
      description: inv.description,
      expected: "(any value)",
      actual: "",
      status: "missing",
      severity: inv.severity,
    };
  }

  if (inv.expected !== undefined) {
    if (!isSet) {
      return {
        key: inv.key,
        description: inv.description,
        expected: inv.expected,
        actual: "",
        status: "missing",
        severity: inv.severity,
      };
    }
    if (actual !== inv.expected) {
      return {
        key: inv.key,
        description: inv.description,
        expected: inv.expected,
        actual: actual!,
        status: "different",
        severity: inv.severity,
      };
    }
  }

  if (inv.pattern !== undefined) {
    if (!isSet) {
      return {
        key: inv.key,
        description: inv.description,
        expected: `match ${inv.pattern}`,
        actual: "",
        status: "missing",
        severity: inv.severity,
      };
    }
    if (!inv.pattern.test(actual!)) {
      return {
        key: inv.key,
        description: inv.description,
        expected: `match ${inv.pattern}`,
        actual: actual!,
        status: "pattern-mismatch",
        severity: inv.severity,
      };
    }
  }

  return null;
}

/**
 * Run drift detection across the supplied invariants list (defaults to
 * DEFAULT_INVARIANTS). Returns only the items that drifted, in invariant
 * order. Empty array = no drift.
 */
export function checkDrift(
  invariants: readonly Invariant[] = DEFAULT_INVARIANTS,
  env: NodeJS.ProcessEnv = process.env,
): DriftRecord[] {
  const drifts: DriftRecord[] = [];
  for (const inv of invariants) {
    const result = checkInvariant(inv, env[inv.key]);
    if (result) drifts.push(result);
  }
  return drifts;
}

/**
 * Summary counts for quick exit-code / alert decisions.
 */
export function summarizeDrift(drifts: DriftRecord[]): {
  total: number;
  critical: number;
  warning: number;
  info: number;
} {
  const summary = { total: drifts.length, critical: 0, warning: 0, info: 0 };
  for (const d of drifts) {
    if (d.severity === "critical") summary.critical++;
    else if (d.severity === "warning") summary.warning++;
    else summary.info++;
  }
  return summary;
}
