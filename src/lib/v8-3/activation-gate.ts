/**
 * V8.3 Phase 7 — §14 v1 activation gate.
 *
 * The deterministic readiness gate for V8.3, mirroring the V8.1 §13 / V8.2 §17
 * gates: `evaluateV83Gate` runs the six §14 v1 queries over the decision ledger
 * and returns a single `pass | fail | insufficient_data` verdict. It measures
 * whether the substrate + a 7-day shadow run are healthy enough to consider the
 * operator's first L1→L2 promotion — it does NOT itself promote anything (that is
 * a deliberate operator action).
 *
 * Cadence trap ([[gate-target-must-match-cadence]]): a quiet week (fewer than the
 * shadow-volume floor of decision records) yields `insufficient_data`, NOT `fail`
 * — the same discipline as §13/§17. `fail` is reserved for a real invariant
 * breach (an L≥3 decision with no linked judgment, or an L≥3 decision with no
 * reversal op) — both of which the Phase-6 linkage gate + Phase-3 reversibility
 * gate are supposed to make structurally impossible, so a `fail` here means one of
 * those gates regressed.
 */

import type Database from "better-sqlite3";
import { getDatabase } from "../../db/index.js";

/** Minimum decision records over the 7-day shadow window before the gate can
 *  render a verdict (below this → insufficient_data). Spec §14: `>= 7`. */
export const GATE_V83_MIN_SHADOW_DECISIONS = 7;

/** The 5 V8.3 schema objects (4 tables + the audit view). */
const V83_SCHEMA_OBJECTS = [
  "capability_autonomy",
  "capability_trust_signals",
  "decisions",
  "decision_events",
  "audit_decisions",
] as const;

/** The V8.2 substrate V8.3 hard-depends on (§12/Phase-0 gate). */
const V82_DEP_TABLES = ["judgments", "reflection_followups"] as const;

/** Expected seeded capability count (§6). */
const EXPECTED_CAPABILITY_COUNT = 6;

export interface V83GateCheck {
  pass: boolean;
  detail: string;
  /**
   * True when the check passed WITHOUT EXAMINING ANYTHING — its population was
   * empty, so `pass` records "no breach found", not "the property holds".
   *
   * Checks 5 and 6 are regression detectors over L≥3 decisions, and that
   * population is empty by construction until an L3 promotion exists (only
   * L1→L2 is implemented; all capabilities seed at L1). A bare `✓` over zero
   * rows is indistinguishable from a `✓` over real coverage, and
   * `renderPromotionAdr` writes these lines into a PERMANENT record as the
   * evidence for a promotion — so the distinction has to survive into the
   * rendering. Consumers must mark a vacuous pass differently from a verified
   * one (see `promotion.ts` and `scripts/v83-gate.ts`).
   *
   * NOT a failure and NOT `insufficient_data`: demanding a non-empty L≥3
   * population before §14 can pass would deadlock the gate permanently, since
   * L≥3 decisions cannot exist until a promotion that §14 itself gates.
   */
  vacuous?: boolean;
}

/** Which seam/run produced a shadow decision (see `GatedExecutionSource`). */
export type ShadowSource = "interactive" | "operator" | "background";

export interface V83GateResult {
  /** Decision records in the 7-day shadow window. */
  shadowDecisions: number;
  /**
   * The same window stratified by source (deferred R2 of the 08-08 seam ship,
   * shipped 2026-08-17). INFORMATIONAL — no verdict keys on it. A promotion
   * decision must not cite a fill that is 100% background / single-capability
   * ([[gate-pass-must-have-a-consumer]] + spec R2 "stratify before citing").
   * Source is read from the `proposed` event payload; rows ledgered before the
   * payload carried it fall back to `thread_id` (`"background"` literal ⇒
   * background, anything else ⇒ interactive — the only two seams then).
   */
  shadowBySource: Record<ShadowSource, number>;
  checks: {
    schema: V83GateCheck;
    v82Dependency: V83GateCheck;
    seeded: V83GateCheck;
    shadowVolume: V83GateCheck;
    /** No L≥3 decision lacks a linked judgment (§14 / R2 #9). */
    linkageIntegrity: V83GateCheck;
    /** Every L≥3 decision carries a reversal op (§7). */
    reversibilityCoverage: V83GateCheck;
  };
  verdict: "pass" | "fail" | "insufficient_data";
}

function countObjects(db: Database.Database, names: readonly string[]): number {
  const placeholders = names.map(() => "?").join(",");
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN (${placeholders})`,
    )
    .get(...names) as { n: number };
  return row.n;
}

/**
 * Evaluate the §14 v1 activation gate. Deterministic, read-only. `insufficient_data`
 * (not `fail`) on a thin shadow window; `fail` only on a real invariant breach.
 */
export function evaluateV83Gate(
  db: Database.Database = getDatabase(),
): V83GateResult {
  // 1. schema present (4 tables + view).
  const schemaCount = countObjects(db, V83_SCHEMA_OBJECTS);
  const schemaPass = schemaCount === V83_SCHEMA_OBJECTS.length;

  // 2. V8.2 dependency present.
  const depCount = countObjects(db, V82_DEP_TABLES);
  const depPass = depCount === V82_DEP_TABLES.length;

  // 3. default capabilities seeded.
  const seededCount = (
    db.prepare(`SELECT COUNT(*) AS n FROM capability_autonomy`).get() as {
      n: number;
    }
  ).n;
  const seededPass = seededCount === EXPECTED_CAPABILITY_COUNT;

  // 4. 7-day shadow produced decision records.
  const shadowDecisions = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM decisions WHERE datetime(proposed_at) > datetime('now','-7 days')`,
      )
      .get() as { n: number }
  ).n;
  const shadowPass = shadowDecisions >= GATE_V83_MIN_SHADOW_DECISIONS;

  // 4b. Stratify the same window by source (informational). One row per
  //     decision: the `proposed` event's payload `source`, else the legacy
  //     thread_id fallback. COALESCE keeps rows whose proposed event predates
  //     the payload field (or is missing) inside the count, never dropped.
  const shadowBySource: Record<ShadowSource, number> = {
    interactive: 0,
    operator: 0,
    background: 0,
  };
  const bySourceRows = db
    .prepare(
      `SELECT COALESCE(
                (SELECT json_extract(e.payload_json, '$.source')
                   FROM decision_events e
                  WHERE e.decision_id = d.id AND e.event_kind = 'proposed'
                  ORDER BY e.sequence_no LIMIT 1),
                CASE WHEN d.thread_id = 'background' THEN 'background' ELSE 'interactive' END
              ) AS source,
              COUNT(*) AS n
         FROM decisions d
        WHERE datetime(d.proposed_at) > datetime('now','-7 days')
        GROUP BY source`,
    )
    .all() as Array<{ source: string; n: number }>;
  for (const row of bySourceRows) {
    // Object.hasOwn, not `in`: a label named like a prototype key
    // ("constructor", "toString") must fall to the else-branch (qa W3).
    if (Object.hasOwn(shadowBySource, row.source)) {
      shadowBySource[row.source as ShadowSource] += row.n;
    } else {
      // Unknown label = a seam this reader doesn't know; count it as
      // background so the buckets still sum to `shadowDecisions`.
      shadowBySource.background += row.n;
    }
  }

  // The DENOMINATOR for checks 5 and 6. Both are regression detectors phrased as
  // violation counts, so both pass trivially when this is 0 — which it is by
  // construction until an L3 promotion exists. Measuring it lets the checks
  // report what they actually examined instead of implying coverage they don't
  // have (audit R2-A1, 2026-08-02).
  const autonomousDecisions = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM decisions
          WHERE autonomy_level >= 3
            AND datetime(proposed_at) > datetime('now','-7 days')`,
      )
      .get() as { n: number }
  ).n;

  // 5. judgment-linkage integrity — no L≥3 decision with judgment_id NULL (R2 #9).
  const unlinkedAutonomous = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM decisions
          WHERE judgment_id IS NULL AND autonomy_level >= 3
            AND datetime(proposed_at) > datetime('now','-7 days')`,
      )
      .get() as { n: number }
  ).n;
  const linkagePass = unlinkedAutonomous === 0;

  // 6. reversibility coverage — every L≥3 decision has a reversal op (§7).
  const irreversibleAutonomous = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM decisions
          WHERE autonomy_level >= 3 AND reversal_op_json IS NULL
            AND datetime(proposed_at) > datetime('now','-7 days')`,
      )
      .get() as { n: number }
  ).n;
  const reversibilityPass = irreversibleAutonomous === 0;

  // Verdict, in precedence order:
  //  - a structural breach (checks 5/6) is a real FAIL regardless of volume — an
  //    L≥3 decision without a linked judgment or without a reversal op must NEVER
  //    hold (the Phase-6 / Phase-3 gates make them impossible; this catches a
  //    regression);
  //  - a missing substrate (schema / dep / seed) is a real FAIL (misconfiguration);
  //  - otherwise a thin shadow window is insufficient_data (cadence trap), not fail.
  let verdict: V83GateResult["verdict"];
  if (!linkagePass || !reversibilityPass) {
    verdict = "fail";
  } else if (!schemaPass || !depPass || !seededPass) {
    verdict = "fail";
  } else if (shadowDecisions < GATE_V83_MIN_SHADOW_DECISIONS) {
    verdict = "insufficient_data";
  } else {
    verdict = "pass";
  }

  return {
    shadowDecisions,
    shadowBySource,
    checks: {
      schema: {
        pass: schemaPass,
        detail: `${schemaCount}/${V83_SCHEMA_OBJECTS.length} V8.3 schema objects present`,
      },
      v82Dependency: {
        pass: depPass,
        detail: `${depCount}/${V82_DEP_TABLES.length} V8.2 dependency tables present`,
      },
      seeded: {
        pass: seededPass,
        detail: `${seededCount}/${EXPECTED_CAPABILITY_COUNT} capabilities seeded`,
      },
      shadowVolume: {
        pass: shadowPass,
        detail:
          `${shadowDecisions} decision(s) in the 7d shadow (need ≥${GATE_V83_MIN_SHADOW_DECISIONS})` +
          ` — by source: interactive ${shadowBySource.interactive} · operator ${shadowBySource.operator} · background ${shadowBySource.background}`,
      },
      linkageIntegrity: {
        pass: linkagePass,
        vacuous: autonomousDecisions === 0,
        detail:
          autonomousDecisions === 0
            ? "no L≥3 decision exists in the 7d window — nothing to verify (vacuous)"
            : unlinkedAutonomous === 0
              ? `all ${autonomousDecisions} L≥3 decision(s) carry a linked judgment`
              : `${unlinkedAutonomous}/${autonomousDecisions} L≥3 decision(s) with judgment_id NULL — §12 linkage BREACH`,
      },
      reversibilityCoverage: {
        pass: reversibilityPass,
        vacuous: autonomousDecisions === 0,
        detail:
          autonomousDecisions === 0
            ? "no L≥3 decision exists in the 7d window — nothing to verify (vacuous)"
            : irreversibleAutonomous === 0
              ? `all ${autonomousDecisions} L≥3 decision(s) carry a reversal op`
              : `${irreversibleAutonomous}/${autonomousDecisions} L≥3 decision(s) with no reversal_op — §7 BREACH`,
      },
    },
    verdict,
  };
}
