/**
 * V8.2 Phase 1 — strategic-judgment domain types (spec §6/§7).
 *
 * The canonical TypeScript + Zod contract for the Strategic Initiative Layer.
 * Phase 0 reconciled the enums in `reconciliation.ts`; this module re-exports
 * them so a consumer imports the whole V8.2 type set from one place, then adds
 * the composite object types the later phases produce and persist:
 *
 *   - `EvidenceRef` / `AttributedClaim`  → the citation ledger (§6, table
 *     `attributed_claims`). Phase 4 `cite.ts` populates these.
 *   - `ProposedOption`                   → one RAPID-D option (§8). Phase 3.
 *   - `ConfidenceBasis`                  → distinct-source / contradiction /
 *     stale counts driving the confidence color (§6). Phase 8.
 *   - `StrategicJudgment`                → the V8.1 `Judgment` (imported, single
 *     source of truth) intersected with the V8.2 fields (§6).
 *   - `Decomposition` / `DecompositionAngle` / `AngleBoundaries` → the angles,
 *     not answers, artifact (§7). Phase 2 `decompose.ts`.
 *
 * POSTURE DIVERGENCE (deliberate, see [[feedback_stale_spec_reconciliation]]):
 * `StrategicJudgment` extends the V8.1 `JudgmentSchema`, whose posture enum is
 * 'has_momentum'. The persisted `judgments.posture` CHECK (Phase 0 DDL) is the
 * V8.2 vocabulary 'momentum' (`POSTURES`). The Phase 2 judgment pass normalizes
 * 'has_momentum' → 'momentum' on the way to the row. Both vocabularies are
 * pinned by a test so a future edit can't "fix" one without the other.
 */

import { z } from "zod";
import { JudgmentSchema } from "../../briefing/schema.js";

// Re-export the Phase 0 reconciled enums so the V8.2 type set has one import
// surface. reconciliation.ts stays the single home for the enum literals.
export {
  EVIDENCE_KINDS,
  EvidenceKindSchema,
  TOOL_GUIDANCE,
  ToolGuidanceSchema,
  POSTURES,
  PostureSchema,
  CONCESSION_KINDS,
  ConcessionKindSchema,
} from "./reconciliation.js";
export type {
  EvidenceKind,
  ToolGuidance,
  Posture,
  ConcessionKind,
} from "./reconciliation.js";

import { EvidenceKindSchema, ToolGuidanceSchema } from "./reconciliation.js";

// ── resolver_status (§6 attributed_claims) ───────────────────────────────────
export const RESOLVER_STATUSES = [
  "unresolved",
  "resolved",
  "stale",
  "contradicted",
] as const;
export type ResolverStatus = (typeof RESOLVER_STATUSES)[number];
export const ResolverStatusSchema = z.enum(RESOLVER_STATUSES);

// ── RAPID-D roles (§8 multi-option) ──────────────────────────────────────────
export const RAPID_D_ROLES = [
  "analyst",
  "seeker",
  "devils_advocate",
  "synthesizer",
] as const;
export type RapidDRole = (typeof RAPID_D_ROLES)[number];
export const RapidDRoleSchema = z.enum(RAPID_D_ROLES);

// ── option labels (§6 ProposedOption) ────────────────────────────────────────
export const OPTION_LABELS = ["A", "B", "C"] as const;
export type OptionLabel = (typeof OPTION_LABELS)[number];
export const OptionLabelSchema = z.enum(OPTION_LABELS);

// ── EvidenceRef (§6) ─────────────────────────────────────────────────────────
export const EvidenceRefSchema = z.object({
  kind: EvidenceKindSchema,
  id: z.string().min(1),
  excerpt: z.string(),
  /** ISO-8601 retrieval timestamp — feeds the staleness window (§18 Q3). */
  retrieved_at: z.string().min(1),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

// ── AttributedClaim (§6) — one sentence + its 1+ supporting evidence rows ─────
export const AttributedClaimSchema = z.object({
  /** Per-judgment counter grouping the multi-source rows of ONE sentence. */
  claim_id: z.number().int().nonnegative(),
  claim_text: z.string().min(1),
  /** 1+ ; a multi-source `[1][3]` sentence carries two refs. */
  evidence_refs: z.array(EvidenceRefSchema).min(1),
  resolver_status: ResolverStatusSchema,
});
export type AttributedClaim = z.infer<typeof AttributedClaimSchema>;

/**
 * The persisted `attributed_claims` row (one evidence ref per row; the logical
 * `AttributedClaim` above is the grouped view). Mirrors the Phase 1 DDL so
 * Phase 4 `cite.ts` can type its INSERT/SELECT without restating column shapes.
 */
export const AttributedClaimRowSchema = z.object({
  id: z.number().int(),
  judgment_id: z.number().int(),
  claim_id: z.number().int().nonnegative(),
  claim_text: z.string().min(1),
  prose_offset: z.number().int().nullable(),
  evidence_kind: EvidenceKindSchema,
  evidence_id: z.string().min(1),
  evidence_excerpt: z.string(),
  retrieved_at: z.string().min(1),
  resolver_status: ResolverStatusSchema,
});
export type AttributedClaimRow = z.infer<typeof AttributedClaimRowSchema>;

// ── ProposedOption (§6/§8) ───────────────────────────────────────────────────
export const ProposedOptionSchema = z.object({
  label: OptionLabelSchema,
  summary: z.string().min(1),
  tradeoffs: z.array(z.string()),
  /** 1 = best per the Synthesizer's ranking. */
  rank: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  generated_by_role: RapidDRoleSchema,
});
export type ProposedOption = z.infer<typeof ProposedOptionSchema>;

// ── ConfidenceBasis (§6) — the inputs to the confidence color (§8) ───────────
export const ConfidenceBasisSchema = z.object({
  distinct_sources: z.number().int().nonnegative(),
  contradiction_count: z.number().int().nonnegative(),
  stale_count: z.number().int().nonnegative(),
});
export type ConfidenceBasis = z.infer<typeof ConfidenceBasisSchema>;

// ── StrategicJudgment (§6) = V8.1 base ∪ V8.2 fields ─────────────────────────
// NOTE: inherits the V8.1 'has_momentum' posture vocabulary (see header). The
// `proposed_options` array is length 3 (A/B/C) OR length 0 (graceful degrade
// when the diversity gate can't yield 3 distinct options) — never 1 or 2; §8
// "Do not fake A/B/C". The refine pins that invariant.
export const StrategicJudgmentSchema = JudgmentSchema.extend({
  evidence_refs: z.array(EvidenceRefSchema),
  proposed_options: z.array(ProposedOptionSchema),
  strategic_voice_principle_id: z.string().optional(),
  concession_kind: z
    .enum([
      "held_position",
      "updated_with_evidence",
      "conceded_without_evidence",
    ])
    .optional(),
  triggering_evidence_text: z.string().optional(),
  confidence_basis: ConfidenceBasisSchema,
}).refine(
  (j) => j.proposed_options.length === 0 || j.proposed_options.length === 3,
  {
    message:
      "proposed_options must be length 3 (A/B/C) or 0 (graceful degrade)",
    path: ["proposed_options"],
  },
);
export type StrategicJudgment = z.infer<typeof StrategicJudgmentSchema>;

// ── Decomposition (§7) — angles, not answers ─────────────────────────────────
export const AngleBoundariesSchema = z.object({
  /** ISO date lower bound. */
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  status_in: z.array(z.string()).optional(),
  exclude_completed: z.boolean().optional(),
  limit: z.number().int().positive().optional(),
});
export type AngleBoundaries = z.infer<typeof AngleBoundariesSchema>;

export const DecompositionAngleSchema = z.object({
  /** The specific question this angle retrieves against (≤120 chars). */
  objective: z.string().min(1).max(120),
  /** Real tools; empty = let retrieval choose (§7). */
  tool_guidance: z.array(ToolGuidanceSchema),
  boundaries: AngleBoundariesSchema,
});
export type DecompositionAngle = z.infer<typeof DecompositionAngleSchema>;

export const DecompositionSchema = z.object({
  question: z.string().min(1),
  /** ≤3 angles (§7): more angles = cost without proportional quality. */
  angles: z.array(DecompositionAngleSchema).max(3),
  generated_at: z.string().min(1),
});
export type Decomposition = z.infer<typeof DecompositionSchema>;
