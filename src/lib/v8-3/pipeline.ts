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
  ReversalStrategy,
} from "./types.js";
import type { DecisionContext } from "./odd-evaluator.js";
import { evaluateODD } from "./odd-evaluator.js";
import {
  appendDecisionEvent,
  getCapabilityRow,
  insertDecision,
  markReverted,
  updateDecisionStatus,
} from "./decisions-store.js";
import {
  applyReversal,
  buildReversalOp,
  captureSqlPreState,
  verifyRestored,
  type MutationTarget,
  type ReversalOp,
  type SqlPreState,
} from "./reversal.js";
import { reversalStrategyForCapability } from "./seed.js";
import {
  scanExternalContent,
  type ExternalContent,
} from "./external-content.js";

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
  /**
   * Pre-mutation state mock used when no SQL mutation is declared (Phase 2 path).
   * When `sqlMutation` is present, the pipeline captures the real snapshot and
   * this field is ignored.
   */
  preState?: unknown | null;
  /**
   * Phase 3 — declares that this decision performs a SQL mutation, enabling
   * reversibility: the pipeline snapshots the named rows BEFORE execute, derives
   * the inverse, stores it on the decision, and (for `sql_inverse`) auto-reverts
   * on execution failure. `allowedTables` is the capability's declared
   * blast-radius surface; an inverse touching anything outside it is rejected
   * (§7). Absent ⇒ Phase-2 mock pre-state, no reversal op.
   */
  sqlMutation?: {
    targets: MutationTarget[];
    strategy: ReversalStrategy;
    allowedTables: string[];
    compensatingProposal?: string;
  };
  /**
   * §8 — external (non-Jarvis) content this action consumes (operator message,
   * kb_entry, scraped web, API response). When present, the pipeline runs the
   * DETERMINISTIC injection heuristic before execute; a hit HALTS the decision as
   * `interrupted` (never executes) + logs `interrupted`/`prompt_injection_suspected`.
   * Absent ⇒ a purely internal action ⇒ no scan (dormant for the current canary,
   * whose trigger declares none).
   */
  externalContent?: ExternalContent[];
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
  status: "pending" | "committed" | "reverted" | "interrupted";
  /** Kind of the recorded reversal op, or null when none was declared. */
  reversal: ReversalOp["kind"] | null;
  /**
   * Auto-revert verification result: `true` = restored + marked reverted;
   * `false` = replay ran but state NOT restored (CRITICAL, left pending); `null`
   * = no auto-revert attempted (committed, or no replayable inverse).
   */
  restored: boolean | null;
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
  const demotions: Array<{
    from: AutonomyLevel;
    to: AutonomyLevel;
    reason: string;
  }> = [];
  let inODD: boolean | null = null;
  if (effectiveLevel >= 3) {
    inODD = evaluateODD(predicate, trigger.context, now);
    if (!inODD) {
      const from = effectiveLevel;
      effectiveLevel = clampLevel(effectiveLevel - 1);
      demotions.push({ from, to: effectiveLevel, reason: "out_of_odd" });
    }
  }

  // 2b. Phase 3 reversibility. When the trigger declares a SQL mutation, capture
  //     the real pre-state now (before execute) and derive the inverse. Then
  //     enforce §7: an autonomous (L≥3) action MUST be mechanically reversible,
  //     and `sql_inverse` is the only strategy v1 can replay — anything else
  //     (compensating / irreversible / deferred) demotes to confirm (L2). A
  //     trigger with no declared mutation keeps the Phase-2 mock pre-state.
  let reversalOp: ReversalOp | null = null;
  let capturedPreState: unknown = trigger.preState ?? null;
  if (trigger.sqlMutation) {
    const pre = captureSqlPreState(db, trigger.sqlMutation.targets, nowIso);
    capturedPreState = pre;
    // Seam (a): the capability's CANONICAL reversal strategy is authoritative — a
    // caller/trigger can NEVER override it. Bind the builder to the immutable seed,
    // not `trigger.sqlMutation.strategy`; else a compensating-only capability
    // (`northstar_sync`) could request `sql_inverse` and a local inverse would be
    // built + stored = the 2026-05-12 resurrection risk. A trigger that declares a
    // different strategy is a wiring bug — fail loud rather than build the wrong op.
    const capabilityStrategy = reversalStrategyForCapability(cap.capability);
    if (trigger.sqlMutation.strategy !== capabilityStrategy) {
      throw new Error(
        `V8.3 pipeline: trigger declared reversal strategy '${trigger.sqlMutation.strategy}' ` +
          `for '${cap.capability}', but its canonical strategy is '${capabilityStrategy}' (authoritative)`,
      );
    }
    reversalOp = buildReversalOp({
      strategy: capabilityStrategy,
      preState: pre,
      allowedTables: trigger.sqlMutation.allowedTables,
      level: effectiveLevel,
      reversibleRequired: gateConfig.reversible_required,
      compensatingProposal: trigger.sqlMutation.compensatingProposal,
    });
  }

  // Seam (b): §7 structural invariant — an autonomous (L≥3) action MUST carry a
  // proven, replayable inverse (`sql_inverse`). ANY other case demotes to confirm
  // (L2). This now fires GENERALLY, not just inside the `sqlMutation` branch:
  // previously an L≥3 trigger that declared NO sqlMutation reached the autonomous
  // route with `reversalOp === null` and `reversible_required` unenforced. Now a
  // missing/non-sql_inverse inverse always demotes — no autonomous path without a
  // proven undo. (Non-reversible capabilities are already max_level≤2 by the seed
  // invariant, so this only bites a mis-wired L≥3 trigger — the safe direction.)
  if (effectiveLevel >= 3 && reversalOp?.kind !== "sql_inverse") {
    const from = effectiveLevel;
    effectiveLevel = 2;
    demotions.push({ from, to: 2, reason: "not_reversible" });
  }
  const demoted = demotions.length > 0;

  // 3. Classify the gate route. `ux_confirm_flag` is an operator preference that
  //    forces the confirm path even when the level would be autonomous.
  const route: DecisionRoute =
    effectiveLevel <= 2 || cap.ux_confirm_flag !== 0 ? "confirm" : "autonomous";

  // 4. Write the decision (state) at status='pending' + emit `proposed`. The
  //    captured pre-state and (if any) reversal op are persisted at insert.
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
      preState: capturedPreState,
      reversalOp,
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
  for (const demotion of demotions) {
    emit("autonomy_demoted", demotion);
  }

  // 4b. §8 prompt-injection defense. Scan any external content this action
  //     consumes with the DETERMINISTIC heuristic (R2 #6 — no LLM). A hit HALTS
  //     the decision as `interrupted` BEFORE any confirm/execute. This is a
  //     TRIPWIRE in front of the real boundaries (the confirm gate / the ODD +
  //     reversibility gate), NOT itself a guarantee — the heuristic is best-effort.
  //     The interrupted row stays in the ledger (feeds the §8 metric).
  //     DEFERRED (§8 "escalate to stricter mode FOR THE SESSION"): this halts the
  //     individual decision only; session-level escalation state is not yet built.
  if (trigger.externalContent && trigger.externalContent.length > 0) {
    const flagged = scanExternalContent(trigger.externalContent);
    if (flagged.length > 0) {
      emit("interrupted", {
        reason: "prompt_injection_suspected",
        sources: flagged.map((f) => f.source),
        matches: [...new Set(flagged.flatMap((f) => f.matches))],
      });
      updateDecisionStatus(decisionId, "interrupted", nowIso, db);
      return {
        decisionId,
        capability: cap.capability,
        baseLevel,
        effectiveLevel,
        route,
        inODD,
        demoted,
        status: "interrupted",
        reversal: reversalOp?.kind ?? null,
        restored: null,
        events,
      };
    }
  }

  // 5. Confirm path: production hands off to the existing router confirm flow
  //    (parked op → operator reply). Phase 2 mocks that as an auto-approve so
  //    the traversal completes synchronously.
  if (route === "confirm") {
    emit("approved", { mock: true });
  }

  // 6. Execute. On success → committed + `executed`. On failure WITH a replayable
  //    inverse (§7): auto-revert from the captured pre-state, verify, and mark the
  //    decision reverted. On failure with NO replayable inverse, the row stays
  //    pending for the caller to reconcile (Phase-2 behaviour).
  const result = await execute(trigger);
  let status: "pending" | "committed" | "reverted" = "pending";
  let restored: boolean | null = null;
  if (result.ok) {
    emit("executed", { mock: true });
    updateDecisionStatus(decisionId, "committed", nowIso, db);
    status = "committed";
  } else if (
    reversalOp?.kind === "sql_inverse" &&
    (capturedPreState as SqlPreState | null)?.kind === "sql"
  ) {
    // Execution failed with a replayable inverse → attempt auto-revert.
    const applied = applyReversal(db, reversalOp);
    restored =
      applied.ok && verifyRestored(db, capturedPreState as SqlPreState);
    if (restored) {
      emit("reverted", {
        reason: "execution_failed",
        auto: true,
        restored: true,
      });
      markReverted(decisionId, nowIso, db);
      status = "reverted";
    }
    // else CRITICAL (spec §10): the replay ran but state was NOT restored — do
    // NOT mark the decision reverted (that would imply a clean rollback that did
    // not happen). Leave it `pending` with pre_state + reversal op intact for
    // investigation/freeze; `restored:false` is surfaced to the caller. (A
    // dedicated revert-failed event kind needs a decision_events CHECK migration —
    // deferred to activation; this mirrors revertDecision's not-restored path.)
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
    reversal: reversalOp?.kind ?? null,
    restored,
    events,
  };
}
