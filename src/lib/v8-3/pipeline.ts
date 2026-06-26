/**
 * V8.3 Phase 2 — decision-pipeline skeleton.
 *
 * resolver → ODD evaluator → gate classifier → (L1-L2 confirm | L≥3 autonomous)
 * → pre-state capture → execute (no-op mock) → events. Writes the decision
 * ledger; runs a mock executor (no real side effect). Ships DORMANT: this module
 * has no call site yet — the eventual trigger seam gates on `isV83Enabled()`.
 *
 * Deliberately deferred to later phases (per spec §13):
 *  - real router-confirm hand-off for L1-L2 (seam: task-executor.ts:93 /
 *    registry.ts:203) — Phase 2 mocks it as a synchronous auto-approve;
 *  - SQL-inverse reversibility + real pre-state snapshot — Phase 3;
 *  - L≥3 CRITIC judgment-linkage rejection — Phase 6;
 *  - prompt-injection `interrupted` — Phase 5.
 */

import type Database from "better-sqlite3";
import { getDatabase } from "../../db/index.js";
import type {
  AutonomyLevel,
  DecisionEventKind,
  GateConfig,
  ODDPredicate,
} from "./types.js";
import type { DecisionContext } from "./odd-evaluator.js";
import { evaluateODD } from "./odd-evaluator.js";
import {
  appendDecisionEvent,
  getCapabilityRow,
  insertDecision,
  setDecisionPreState,
  updateDecisionStatus,
} from "./decisions-store.js";

export type DecisionRoute = "confirm" | "autonomous";

export interface DecisionTrigger {
  /** Capability key — must resolve to a seeded `capability_autonomy` row. */
  capability: string;
  /** The action to perform (serialized into `payload_json`). */
  payload: Record<string, unknown>;
  /** Assembled decision-context the ODD predicate is evaluated against. */
  context: DecisionContext;
  /** Materialized capability token (serialized into `capability_token_json`). */
  capabilityToken?: Record<string, unknown>;
  /** Linked V8.2 judgment id (L≥3 linkage is enforced in Phase 6, not here). */
  judgmentId?: number | null;
  /** Conversation thread this decision belongs to. */
  threadId: string;
  /** Pre-mutation state (Phase 2 mock; real snapshot is Phase 3). */
  preState?: unknown | null;
}

export interface RunPipelineOptions {
  db?: Database.Database;
  /** Injected clock (ISO) for deterministic tests. */
  nowIso?: string;
  /** Mock executor (Phase 2). Default = no-op success; real exec is later. */
  execute?: (
    trigger: DecisionTrigger,
  ) => Promise<{ ok: boolean }> | { ok: boolean };
}

export interface PipelineResult {
  decisionId: number;
  capability: string;
  baseLevel: AutonomyLevel;
  effectiveLevel: AutonomyLevel;
  route: DecisionRoute;
  /** ODD verdict, or null when not evaluated (L1-L2 always sync-confirm). */
  inODD: boolean | null;
  demoted: boolean;
  status: "pending" | "committed";
  events: DecisionEventKind[];
}

const CADENCE_BY_LEVEL: Record<AutonomyLevel, string> = {
  0: "disabled",
  1: "sync",
  2: "preview",
  3: "notify-after",
  4: "eod-summary",
  5: "silent",
};

function clampLevel(n: number): AutonomyLevel {
  return Math.max(0, Math.min(5, n)) as AutonomyLevel;
}

/**
 * Run one decision through the Phase 2 pipeline. Writes a `decisions` row plus
 * its `decision_events` history and returns the traversal outcome.
 *
 * @throws if the capability is unseeded, disabled (effective level 0), or has a
 *   malformed `gate_config.max_level`.
 */
export async function runDecisionPipeline(
  trigger: DecisionTrigger,
  options: RunPipelineOptions = {},
): Promise<PipelineResult> {
  const db = options.db ?? getDatabase();
  const nowIso = options.nowIso ?? new Date().toISOString();
  const now = new Date(nowIso);
  const execute = options.execute ?? (() => ({ ok: true }));

  // 1. Resolve the capability (deterministic lookup).
  const cap = getCapabilityRow(trigger.capability, db);
  if (!cap) {
    throw new Error(
      `V8.3 pipeline: unknown capability '${trigger.capability}' (not seeded in capability_autonomy)`,
    );
  }
  const gateConfig = JSON.parse(cap.gate_config_json) as GateConfig;
  const predicate = JSON.parse(cap.odd_predicate_json) as ODDPredicate;
  const baseLevel = cap.level;

  // Fail loud on a corrupted gate_config — never let a malformed max_level slip
  // the classifier into the autonomous branch (structural-safety: refuse rather
  // than degrade silently). A bad odd_predicate stays safe via evaluateODD's
  // fail-safe (out-of-ODD), so only max_level needs guarding here.
  if (
    !Number.isInteger(gateConfig.max_level) ||
    gateConfig.max_level < 0 ||
    gateConfig.max_level > 5
  ) {
    throw new Error(
      `V8.3 pipeline: malformed gate_config.max_level for '${cap.capability}'`,
    );
  }

  // 2. Structural max_level cap, then ODD evaluation + single-decision
  //    out-of-ODD demote. L1-L2 never evaluate the ODD — they always
  //    sync-confirm (spec §6), so `inODD` stays null for them.
  let effectiveLevel = clampLevel(Math.min(baseLevel, gateConfig.max_level));

  // L0 = disabled (spec §6: "capability disabled for Jarvis"). A disabled
  // capability must never propose or execute — refuse before writing anything.
  if (effectiveLevel === 0) {
    throw new Error(
      `V8.3 pipeline: capability '${cap.capability}' is disabled (effective level 0)`,
    );
  }
  let inODD: boolean | null = null;
  let demoted = false;
  if (effectiveLevel >= 3) {
    inODD = evaluateODD(predicate, trigger.context, now);
    if (!inODD) {
      effectiveLevel = clampLevel(effectiveLevel - 1);
      demoted = true;
    }
  }

  // 3. Classify the gate route. `ux_confirm_flag` is an operator preference that
  //    forces the confirm path even when the level would be autonomous.
  const route: DecisionRoute =
    effectiveLevel <= 2 || cap.ux_confirm_flag !== 0 ? "confirm" : "autonomous";

  // 4. Write the decision (state) at status='pending' + emit `proposed`.
  const decisionId = insertDecision(
    {
      capability: cap.capability,
      judgmentId: trigger.judgmentId ?? null,
      autonomyLevel: effectiveLevel,
      status: "pending",
      capabilityToken: trigger.capabilityToken ?? {
        capability: cap.capability,
      },
      payload: trigger.payload,
      threadId: trigger.threadId,
      proposedAt: nowIso,
    },
    db,
  );

  const events: DecisionEventKind[] = [];
  let seq = 1;
  const emit = (kind: DecisionEventKind, payload?: unknown): void => {
    appendDecisionEvent(
      {
        decisionId,
        sequenceNo: seq++,
        eventKind: kind,
        payload,
        occurredAt: nowIso,
      },
      db,
    );
    events.push(kind);
  };

  emit("proposed", {
    route,
    baseLevel,
    effectiveLevel,
    cadence: CADENCE_BY_LEVEL[effectiveLevel],
  });
  if (demoted) {
    emit("autonomy_demoted", {
      from: clampLevel(effectiveLevel + 1),
      to: effectiveLevel,
      reason: "out_of_odd",
    });
  }

  // 5. Confirm path: production hands off to the existing router confirm flow
  //    (parked op → operator reply). Phase 2 mocks that as an auto-approve so
  //    the traversal completes synchronously.
  if (route === "confirm") {
    emit("approved", { mock: true });
  }

  // 6. Capture pre-state (Phase 2 takes it from the trigger; real snapshot Ph3).
  setDecisionPreState(decisionId, trigger.preState ?? null, db);

  // 7. Mock execute → commit. A mock failure ({ok:false}) intentionally leaves
  //    the decision at status='pending' with no terminal event — execution-
  //    failure handling + auto-revert is Phase 3 (spec §7); Phase 2's status
  //    vocabulary has no "failed" terminal, so the row stays pending for the
  //    caller to reconcile rather than being mislabeled.
  const result = await execute(trigger);
  let status: "pending" | "committed" = "pending";
  if (result.ok) {
    emit("executed", { mock: true });
    updateDecisionStatus(decisionId, "committed", nowIso, db);
    status = "committed";
  }

  return {
    decisionId,
    capability: cap.capability,
    baseLevel,
    effectiveLevel,
    route,
    inODD,
    demoted,
    status,
    events,
  };
}
