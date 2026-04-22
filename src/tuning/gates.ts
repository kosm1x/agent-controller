/**
 * 5-gate monotonic validator for v7.5 evolution.
 *
 * Extends the v6.4 `validateMutation` anti-overfitting + simplicity gate
 * with explicit per-gate logging and two new gates:
 *   - Safety:   mutation must preserve designated safety keywords
 *   - Cooldown: same (surface, target) cannot be re-mutated within
 *               TUNING_COOLDOWN_HOURS of the last regression
 *
 * Every gate is additive: the three legacy gates retain their exact
 * behavior. Safety passes by default (empty keyword list). Cooldown always
 * runs but requires a regression record to block anything.
 */

import type { Mutation } from "./types.js";
import { getLastExperimentForTarget } from "./schema.js";

export type GateName =
  | "constitution"
  | "regex_sanity"
  | "size"
  | "worthiness"
  | "safety"
  | "cooldown";

export interface GateResult {
  passed: boolean;
  /** Which gate rejected the mutation. Undefined when `passed` is true. */
  failedGate?: GateName;
  /** Human-readable reason on failure. Undefined when `passed` is true. */
  reason?: string;
}

export interface GateConfig {
  /**
   * Comma-separated safety keywords from env. Empty string disables the
   * safety gate. When populated, the original value must contain at least
   * one of these keywords for the gate to engage; if it does, the mutated
   * value must preserve all originally-present keywords.
   */
  safetyKeywords: string;
  /** Hours to block re-mutation of (surface, target) after a regression. */
  cooldownHours: number;
}

export const DEFAULT_GATE_CONFIG: GateConfig = {
  safetyKeywords: "",
  cooldownHours: 24,
};

/**
 * Run all 5 gates. Returns the first failure (short-circuit) or a pass.
 *
 * @param mutation          proposed mutation
 * @param affectedCaseCount count of cases the mutation touches (for worthiness)
 * @param originalValue     current value of the target
 * @param config            gate configuration (safety keywords, cooldown hours)
 * @param nowMs             injectable clock for tests (defaults to Date.now())
 */
export function runGates(
  mutation: Mutation,
  affectedCaseCount: number,
  originalValue: string,
  config: GateConfig = DEFAULT_GATE_CONFIG,
  nowMs: number = Date.now(),
): GateResult {
  // Gate 1: Constitution (anti-overfitting — hypothesis must not reference case ID)
  const caseIdMatch = mutation.hypothesis.match(/\bcase[-_]?\d+\b/i);
  if (caseIdMatch) {
    return {
      passed: false,
      failedGate: "constitution",
      reason: `hypothesis references specific case ID "${caseIdMatch[0]}"`,
    };
  }

  // Gate 2: regex_sanity — syntax check fires BEFORE size so operators see
  // "invalid regex" instead of "mutation too long" when both are true. An
  // invalid regex silently no-ops in applySandbox otherwise, producing a
  // falsely-passing experiment.
  if (mutation.surface === "scope_rule") {
    try {
      new RegExp(mutation.mutated_value, "i");
    } catch (err) {
      return {
        passed: false,
        failedGate: "regex_sanity",
        reason: `invalid regex: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Gate 3: Size (mutation <= 2x original length)
  const mutatedLen = mutation.mutated_value.length;
  const originalLen = originalValue.length;
  const lengthRatio = originalLen > 0 ? mutatedLen / originalLen : 1;
  if (lengthRatio > 2.0) {
    return {
      passed: false,
      failedGate: "size",
      reason: `mutated value is ${lengthRatio.toFixed(1)}x longer than original (${mutatedLen} vs ${originalLen} chars)`,
    };
  }

  // Gate 3: Worthiness (single-case fix can't add >20% length)
  if (affectedCaseCount <= 1 && lengthRatio > 1.2) {
    return {
      passed: false,
      failedGate: "worthiness",
      reason: `only affects ${affectedCaseCount} case(s) but adds ${((lengthRatio - 1) * 100).toFixed(0)}% length`,
    };
  }

  // Gate 4: Safety (preserves originally-present safety keywords)
  const keywords = parseSafetyKeywords(config.safetyKeywords);
  if (keywords.length > 0) {
    const presentInOriginal = keywords.filter((kw) =>
      originalValue.includes(kw),
    );
    const missingInMutation = presentInOriginal.filter(
      (kw) => !mutation.mutated_value.includes(kw),
    );
    if (missingInMutation.length > 0) {
      return {
        passed: false,
        failedGate: "safety",
        reason: `strips safety keyword(s): ${missingInMutation.join(", ")}`,
      };
    }
  }

  // Gate 5: Cooldown (block re-mutation of recently-regressed target)
  // `getLastExperimentForTarget` already filters status at the SQL layer
  // (schema.ts getLastExperimentForTarget). The TS guard below is a
  // belt-and-suspenders check — if either list is extended, extend BOTH to
  // keep them in sync.
  if (config.cooldownHours > 0) {
    const last = getLastExperimentForTarget(mutation.surface, mutation.target);
    if (
      last &&
      (last.status === "regressed" || last.status === "rejected") &&
      typeof last.created_at === "string"
    ) {
      const lastMs = parseTimestampMs(last.created_at);
      if (lastMs !== null) {
        const elapsedHours = (nowMs - lastMs) / (1000 * 60 * 60);
        if (elapsedHours < config.cooldownHours) {
          return {
            passed: false,
            failedGate: "cooldown",
            reason: `target regressed ${elapsedHours.toFixed(1)}h ago; cooldown is ${config.cooldownHours}h`,
          };
        }
      }
    }
  }

  return { passed: true };
}

function parseSafetyKeywords(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Parse a SQLite timestamp (`YYYY-MM-DD HH:MM:SS` UTC) to ms since epoch.
 * Returns null on unparseable input.
 */
function parseTimestampMs(ts: string): number | null {
  // SQLite's datetime('now') returns UTC without timezone suffix. Append 'Z'
  // so Date() parses it as UTC rather than local-tz.
  const isoish = ts.includes("T") ? ts : ts.replace(" ", "T") + "Z";
  const ms = new Date(isoish).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Load gate config from process env. Used by overnight-loop to pick up
 * user-set safety keywords and cooldown hours.
 */
export function loadGateConfigFromEnv(): GateConfig {
  const hoursRaw = process.env.TUNING_COOLDOWN_HOURS;
  const parsedHours = hoursRaw ? Number.parseInt(hoursRaw, 10) : NaN;
  const cooldownHours = Number.isFinite(parsedHours)
    ? Math.max(0, parsedHours) // negative → 0 (gate disabled), per audit W3
    : DEFAULT_GATE_CONFIG.cooldownHours;
  return {
    safetyKeywords: process.env.TUNING_SAFETY_KEYWORDS ?? "",
    cooldownHours,
  };
}
