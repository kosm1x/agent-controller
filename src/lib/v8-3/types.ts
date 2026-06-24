/**
 * V8.3 — Autonomous Execution Gates: domain types (Phase 0 + Phase 1).
 *
 * Mirrors the 4-table decision data model in `docs/planning/v8-capability-3-spec.md`
 * §5. Scope of THIS increment is the substrate (schema + types + capability seed) —
 * the decision pipeline (resolver/ODD-evaluator/reversal/ADR) lands in Phase 2+, so
 * the per-decision JSON column shapes (`capability_token_json`, `reversal_op_json`,
 * `pre_state_json`, `payload_json`) are deliberately NOT modeled here yet — they
 * arrive with the code that reads/writes them, to avoid speculative types.
 *
 * Reconciliation note (verified against the live registry 2026-06-24): the spec's
 * R2 #2 frames `blast_radius`/`reversible_default` as "derived from the tool's
 * hints". In reality all five tool-backed capabilities are `destructiveHint:true`
 * + `openWorldHint:true`, so the four MCP hints cannot distinguish self/session/
 * persistent. `blast_radius` is therefore a DECLARED scope-axis (the §6 table is
 * the design decision); the hints instead enforce the structural-safety invariant
 * (`reversible_default=false ⇒ gate_config.max_level ≤ 2`). See `seed.ts`.
 */

/** SAE 0-5 fused with Knight L1-L5 (§6). L0 = disabled; L1 = existing sync-confirm. */
export type AutonomyLevel = 0 | 1 | 2 | 3 | 4 | 5;

/** Scope of a capability's effect — declared per capability (§6), not hint-derived. */
export type BlastRadius = "self" | "session" | "persistent";

/** Decision lifecycle status (§5 `decisions.status` CHECK). */
export type DecisionStatus =
  | "pending"
  | "committed"
  | "reverted"
  | "vetoed"
  | "interrupted";

/** Append-only event-source kinds (§5 `decision_events.event_kind` CHECK). */
export type DecisionEventKind =
  | "proposed"
  | "approved"
  | "executed"
  | "reverted"
  | "superseded"
  | "operator_override"
  | "autonomy_demoted"
  | "autonomy_promoted"
  | "interrupted";

/** PheroPath closed signal taxonomy (§3 / §5 `decisions.pheropath_signal`). */
export type PheropathSignal = "DANGER" | "TODO" | "SAFE" | "INSIGHT";

/** How the operator reacted to a proposed/executed decision (§5). */
export type OperatorOverrideKind =
  | "vetoed"
  | "accepted_with_modification"
  | "accepted"
  | "none";

/**
 * Named reversal mechanism for a capability (§7). `reversible_default` is DERIVED
 * from this — a capability is auto-reversible only when it names a concrete
 * programmatic inverse:
 *   - `sql_inverse`    — SQL inverse DML from `pre_state_json` (the v1 workhorse).
 *   - `delete_inverse` — a paired delete tool undoes the create (e.g. delete_schedule).
 *   - `tri_restore`    — FS-mirror + pgvector + Drive tri-restore (jarvis_file_delete).
 *   - `compensating`   — no clean inverse; reversal is PROPOSED, operator confirms
 *                        (a sent email, a NorthStar LWW write). NOT auto-reversible.
 *   - `none`           — reversibility unknown / depends on runtime (e.g. skill_run).
 */
export type ReversalStrategy =
  | "sql_inverse"
  | "delete_inverse"
  | "tri_restore"
  | "compensating"
  | "none";

/** `compensating`/`none` are operator-confirmed or unknown ⇒ NOT auto-reversible. */
export function deriveReversibleDefault(strategy: ReversalStrategy): boolean {
  return (
    strategy === "sql_inverse" ||
    strategy === "delete_inverse" ||
    strategy === "tri_restore"
  );
}

/**
 * ODD predicate grammar (§6) — a deterministic JSON expression evaluated against
 * a constructed decision-context object (NOT raw table columns). Forward-looking
 * in this increment: at L1 the ODD is never evaluated (L1 always sync-confirms),
 * so seeds carry it as metadata for when a capability is considered for promotion.
 */
export type ODDPredicate =
  | { op: "eq" | "neq"; field: string; value: unknown }
  | { op: "lt" | "gt" | "lte" | "gte"; field: string; value: number }
  | { op: "in"; field: string; values: unknown[] }
  | { op: "and" | "or"; clauses: ODDPredicate[] }
  | { op: "not"; clause: ODDPredicate }
  | { op: "time_window"; start_hour: number; end_hour: number; tz: string };

/**
 * Immutable per-capability gate rules (§6 `gate_config_json`). Changing these
 * requires a config migration + ADR — distinct from `ux_confirm_flag` (a freely
 * toggled operator preference). `max_level` is the structural autonomy ceiling:
 * the cap that makes irreversible/file-mutating capabilities unable to ever reach
 * the autonomous (L≥3) path.
 */
export interface GateConfig {
  /** When true, a decision with no reversal_op cannot execute at this capability. */
  readonly reversible_required: boolean;
  /** Hard ceiling on this capability's autonomy level (≤2 = never autonomous). */
  readonly max_level: AutonomyLevel;
}

// ── Row types (mirror the §5 DDL exactly; *_json columns are TEXT at rest) ──

/** `capability_autonomy` row — per-capability autonomy state (§5). */
export interface CapabilityAutonomyRow {
  capability: string;
  level: AutonomyLevel;
  odd_predicate_json: string;
  gate_config_json: string;
  ux_confirm_flag: 0 | 1;
  blast_radius: BlastRadius;
  reversible_default: 0 | 1;
  override_window_start_at: string;
  override_count: number;
  total_executions: number;
  override_integral: number;
  last_pi_evaluation_at: string | null;
  promoted_at: string | null;
  demoted_at: string | null;
  description: string;
}

/** `capability_trust_signals` row — Lee & See 3-D trust (§5, v2; empty until L≥3). */
export interface CapabilityTrustSignalsRow {
  capability: string;
  override_rate: number;
  pull_to_push_ratio: number;
  weeks_at_current_level: number;
  median_time_to_promote_weeks: number | null;
  last_computed_at: string;
}

/** `decisions` row — one per autonomous-or-confirmed write (§5; none written in v1). */
export interface DecisionRow {
  id: number;
  capability: string;
  judgment_id: number | null;
  autonomy_level: AutonomyLevel;
  status: DecisionStatus;
  capability_token_json: string;
  payload_json: string;
  pre_state_json: string | null;
  reversal_op_json: string | null;
  pheropath_signal: PheropathSignal | null;
  proposed_at: string;
  decided_at: string | null;
  reverted_at: string | null;
  superseded_by: number | null;
  supersedes: number | null;
  operator_override_kind: OperatorOverrideKind | null;
  thread_id: string;
}

/** `decision_events` row — append-only event-source (§5). */
export interface DecisionEventRow {
  id: number;
  decision_id: number;
  sequence_no: number;
  event_kind: DecisionEventKind;
  payload_json: string | null;
  occurred_at: string;
  parent_event_seq: number | null;
}

/**
 * Seed definition for one capability (consumed by `seedV83Capabilities`). The
 * capability key is either a registered tool name (`{kind:'tool'}`, resolved +
 * hint-cross-checked at seed time) or a named internal mutation with no LLM tool
 * (`{kind:'internal'}`, e.g. `task_edit`). `reversible_default` is computed from
 * `reversal_strategy`; `blast_radius` and `gate_config` are declared (§6/§7).
 */
export interface CapabilitySeed {
  readonly capability: string;
  readonly backing:
    | { readonly kind: "tool"; readonly tool_name: string }
    | { readonly kind: "internal" };
  readonly level: AutonomyLevel;
  readonly blast_radius: BlastRadius;
  readonly reversal_strategy: ReversalStrategy;
  readonly gate_config: GateConfig;
  readonly odd_predicate: ODDPredicate;
  readonly ux_confirm_flag: boolean;
  /** True for capabilities that mutate files — held at L≤2 until shadow-Git (§7.2). */
  readonly file_mutating: boolean;
  readonly description: string;
}
