/**
 * V8.3 — the operator's L1→L2 promotion ("a small guarded command", deferred at
 * Phase 7, pulled forward by the V8.5 plan §7.1).
 *
 * Spec §11: promote always requires explicit operator signoff → `level++`,
 * `promoted_at = now`, `override_integral = 0` (integral reset, §10), ADR
 * rendered. This module implements exactly the FIRST promotion — L1→L2 — as an
 * allow-list: the only transition it can express is 1→2, and the UPDATE's WHERE
 * clause repeats `level = 1` so a concurrent state change can't widen it
 * (feedback_allow_list_state_gating). L≥3 has NO code path here by design —
 * it is pinned behind §17 (mc-ctl briefing-gate), judgment→action relevance
 * binding, and per-capability operator signoff (structural-safety-gate: a
 * must-hold property is a resolver that refuses, not a runtime boolean).
 *
 * Guards, in order:
 *   1. capability is seeded in `capability_autonomy`
 *   2. current level is exactly 1 (already-promoted → refuse, idempotent-safe)
 *   3. `gate_config.max_level` admits L2
 *   4. §14 v1 activation gate (`evaluateV83Gate`) verdict is `pass`
 *   5. explicit confirm — without it the call is a dry run and writes nothing
 *
 * Guard 4 is the GLOBAL §14 readiness gate, not per-capability history: the
 * shadow-volume check counts all decisions in the 7-day window regardless of
 * which capability produced them. The spec §11 per-capability signal
 * ({30-day metrics, ODD comparison}) belongs to the v2 controller — at v1 the
 * operator's explicit --confirm IS the signoff, and L2 is still sync-confirm
 * (the pipeline's sole autonomous branch is L≥3), so a promotion here moves a
 * capability one notch inside the confirm band and grants no autonomy.
 */

import type Database from "better-sqlite3";
import { getDatabase } from "../../db/index.js";
import { evaluateV83Gate, type V83GateResult } from "./activation-gate.js";
import { getCapabilityRow } from "./decisions-store.js";
import type { CapabilityAutonomyRow } from "./types.js";

export interface PromotionRefusal {
  ok: false;
  /** Which guard refused — stable identifiers for the CLI's exit-code mapping. */
  refusedBy: "unseeded" | "level" | "max_level" | "gate" | "concurrent_update";
  reason: string;
  gate?: V83GateResult;
}

interface PromotionOutcomeBase {
  ok: true;
  capability: string;
  fromLevel: 1;
  toLevel: 2;
  gate: V83GateResult;
}

/** All guards green, nothing written (no `--confirm`). */
export interface PromotionDryRun extends PromotionOutcomeBase {
  executed: false;
  promotedAt: null;
}

export interface PromotionDone extends PromotionOutcomeBase {
  executed: true;
  promotedAt: string;
}

export type PromotionOutcome = PromotionDryRun | PromotionDone;
export type PromotionResult = PromotionRefusal | PromotionOutcome;

function listSeeded(db: Database.Database): string[] {
  return (
    db
      .prepare(`SELECT capability FROM capability_autonomy ORDER BY capability`)
      .all() as Array<{ capability: string }>
  ).map((r) => r.capability);
}

function maxLevelOf(row: CapabilityAutonomyRow): number {
  try {
    const cfg = JSON.parse(row.gate_config_json) as { max_level?: unknown };
    return typeof cfg.max_level === "number" ? cfg.max_level : 0;
  } catch {
    return 0; // unparseable gate_config = refuse, never assume permissive
  }
}

export function promoteCapabilityL1toL2(
  capability: string,
  opts: { confirm: boolean },
  db: Database.Database = getDatabase(),
): PromotionResult {
  const row = getCapabilityRow(capability, db);
  if (!row) {
    return {
      ok: false,
      refusedBy: "unseeded",
      reason: `capability "${capability}" is not in the ledger. Seeded: ${listSeeded(db).join(", ") || "(none)"}`,
    };
  }

  if (row.level !== 1) {
    return {
      ok: false,
      refusedBy: "level",
      reason: `only the L1→L2 transition is supported; "${capability}" is at L${row.level}${
        row.level >= 2 ? " (already promoted)" : ""
      }. L≥3 promotion is not implemented by this command — it additionally requires V8.2 §17 (mc-ctl briefing-gate) and per-capability operator signoff.`,
    };
  }

  const maxLevel = maxLevelOf(row);
  if (maxLevel < 2) {
    return {
      ok: false,
      refusedBy: "max_level",
      reason: `gate_config caps "${capability}" at max_level=${maxLevel}; L2 is not admissible.`,
    };
  }

  const gate = evaluateV83Gate(db);
  if (gate.verdict !== "pass") {
    const failing = Object.entries(gate.checks)
      .filter(([, c]) => !c.pass)
      .map(([name, c]) => `${name}: ${c.detail}`)
      .join("; ");
    return {
      ok: false,
      refusedBy: "gate",
      reason: `§14 activation gate verdict is "${gate.verdict}" — promotion requires "pass". ${failing}`,
      gate,
    };
  }

  if (!opts.confirm) {
    return {
      ok: true,
      executed: false,
      capability,
      fromLevel: 1,
      toLevel: 2,
      promotedAt: null,
      gate,
    };
  }

  const now = new Date().toISOString();
  const info = db
    .prepare(
      `UPDATE capability_autonomy
          SET level = 2,
              promoted_at = @now,
              override_integral = 0.0,
              override_window_start_at = @now
        WHERE capability = @capability AND level = 1`,
    )
    .run({ capability, now });
  if (info.changes !== 1) {
    return {
      ok: false,
      refusedBy: "concurrent_update",
      reason: `no row updated — "${capability}" changed level between the guard check and the write. Re-run to re-evaluate.`,
    };
  }

  return {
    ok: true,
    executed: true,
    capability,
    fromLevel: 1,
    toLevel: 2,
    promotedAt: now,
    gate,
  };
}

/**
 * MADR-style promotion record (spec §11 "ADR rendered"). Pure — the CLI writes
 * it to `logs/decisions/`; keeping FS out of this module keeps it unit-testable.
 */
export function renderPromotionAdr(outcome: PromotionDone): string {
  const c = outcome.gate.checks;
  const checkLines = Object.entries(c)
    .map(([name, chk]) => `- ${chk.pass ? "✓" : "✗"} ${name}: ${chk.detail}`)
    .join("\n");
  return `# Capability promotion: ${outcome.capability} L1 → L2

- **Status:** accepted
- **Date:** ${outcome.promotedAt}
- **Decider:** operator (explicit \`--confirm\` on \`mc-ctl v83-promote\`)

## Context

V8.3 §11 first promotion. The §14 v1 activation gate returned \`pass\` at the
moment of promotion:

${checkLines}

## Decision

\`${outcome.capability}\` moves from L1 (sync-confirm) to L2. \`override_integral\`
reset to 0 and the override window restarted (§10 integral reset). L≥3 remains
gated on V8.2 §17 + judgment linkage + per-capability operator signoff.
`;
}
