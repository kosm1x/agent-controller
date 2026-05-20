/**
 * Briefing schema — V8.1 Phase 6 (spec §9).
 *
 * A briefing is a typed JSON object, never prose: a set of forward-looking
 * `judgments`, each citing evidence. It carries the S2 contract fields
 * (`verified_against` / `sample_n` / `concerns` / `critic_verdict`) populated
 * from the S2 critic pass — see `src/briefing/construct.ts`.
 */

import { z } from "zod";
import {
  DataSourceCitationSchema,
  CONCERN_TYPES,
  CriticVerdictSchema,
} from "../audit/report-schema.js";

const isoDatetime = z.iso.datetime({ offset: true });

/**
 * Signal kinds — the four Phase 5 detectors plus two judgment-only kinds the
 * reflector may raise from general-events/cohort state (spec §9).
 */
export const SignalKindSchema = z.enum([
  "stalled_task",
  "dormant_objective",
  "implicit_deadline",
  "recurring_blocker",
  "momentum", // a recently-completed objective milestone
  "self_defining_progress", // movement on a Conway Pattern 2 cohort entry
]);
export type SignalKind = z.infer<typeof SignalKindSchema>;

/** A briefing concern — same shape as the S2 `ReportDraft.concerns` element. */
export const ConcernSchema = z.object({
  type: z.enum(CONCERN_TYPES),
  detail: z.string().min(1),
});

/** One forward-looking judgment about a signal (spec §9 / §10). */
export const JudgmentSchema = z.object({
  signal_id: z.uuid(),
  kind: SignalKindSchema,
  /** task_id, objective path, blocker signature, etc. */
  subject: z.string().min(1),
  posture: z.enum(["at_risk", "has_momentum", "highest_leverage", "noted"]),
  /** Devin port — confidence as control-flow. */
  confidence: z.enum(["green", "yellow", "red"]),
  confidence_reason: z.string().min(10),
  /** One-paragraph reasoning — must reference evidence. */
  why: z.string().min(20),
  /** Indices into the briefing's `verified_against` array. */
  evidence_indices: z.array(z.number().int().nonnegative()).min(1),
  proposed_action: z
    .object({
      surface: z.enum(["ask_operator", "auto_propose_skill", "log_only"]),
      // LangChain ambient port — capability-flagged interrupt cards.
      capability_flags: z.object({
        allow_ignore: z.boolean(),
        allow_respond: z.boolean(),
        allow_edit: z.boolean(),
        allow_accept: z.boolean(),
      }),
      detail: z.string(),
    })
    .optional(),
});
export type Judgment = z.infer<typeof JudgmentSchema>;

/** A constructed briefing (spec §9). */
export const BriefingSchema = z.object({
  briefing_id: z.uuid(),
  surface: z.enum(["morning", "idle_alert", "pattern_alert", "weekly"]),
  generated_at: isoDatetime,
  source_window: z.object({
    cursor_start_event_id: z.number().int(),
    cursor_end_event_id: z.number().int(),
    wall_start: isoDatetime,
    wall_end: isoDatetime,
  }),
  /** Working-self snapshot — objective ids active at generation. */
  active_objective_ids: z.array(z.string()),
  /** Conway Pattern 2 cohort entry ids the judgments leaned on. */
  self_defining_grounding: z.array(z.string()),
  /** general_events event_ids feeding this brief. */
  general_events_used: z.array(z.string()),
  judgments: z.array(JudgmentSchema).min(1).max(15),
  /** signal_id of THE single highest-leverage judgment, if one rises. */
  highest_leverage_pick: z.uuid().optional(),
  // S2 contract fields (populated from the critic pass).
  verified_against: z.array(DataSourceCitationSchema).min(1),
  sample_n: z.number().int().nonnegative(),
  concerns: z.array(ConcernSchema),
  critic_verdict: CriticVerdictSchema,
});
export type Briefing = z.infer<typeof BriefingSchema>;

/**
 * Cross-field invariants Zod cannot express ergonomically. Returns the list
 * of issue strings; an empty array means the briefing is internally consistent.
 *
 * Invariants:
 *   1. source_window.cursor_end_event_id >= cursor_start_event_id
 *   2. every judgment.evidence_indices entry points within verified_against
 *   3. at most ONE judgment with posture 'highest_leverage' (spec §10 rule 3)
 *   4. highest_leverage_pick, if set, matches a judgment whose posture is
 *      'highest_leverage'
 *   5. judgment signal_ids are unique
 */
export function validateBriefingInvariants(briefing: Briefing): string[] {
  const issues: string[] = [];
  const w = briefing.source_window;
  if (w.cursor_end_event_id < w.cursor_start_event_id) {
    issues.push(
      `source_window: cursor_end_event_id (${w.cursor_end_event_id}) < cursor_start_event_id (${w.cursor_start_event_id})`,
    );
  }

  const citationCount = briefing.verified_against.length;
  briefing.judgments.forEach((j, idx) => {
    for (const ei of j.evidence_indices) {
      // `ei < 0` is normally caught by the Zod `.nonnegative()` on the field;
      // checked here too so the invariant holds for any caller that builds a
      // Briefing object without the schema parse.
      if (ei < 0 || ei >= citationCount) {
        issues.push(
          `judgments[${idx}].evidence_indices: ${ei} out of range (verified_against has ${citationCount})`,
        );
      }
    }
  });

  const hlJudgments = briefing.judgments.filter(
    (j) => j.posture === "highest_leverage",
  );
  if (hlJudgments.length > 1) {
    issues.push(
      `at most one judgment may have posture 'highest_leverage' — found ${hlJudgments.length}`,
    );
  }

  if (briefing.highest_leverage_pick !== undefined) {
    const picked = briefing.judgments.find(
      (j) => j.signal_id === briefing.highest_leverage_pick,
    );
    if (!picked) {
      issues.push(
        `highest_leverage_pick '${briefing.highest_leverage_pick}' matches no judgment signal_id`,
      );
    } else if (picked.posture !== "highest_leverage") {
      issues.push(
        `highest_leverage_pick judgment has posture '${picked.posture}', expected 'highest_leverage'`,
      );
    }
  }

  const ids = briefing.judgments.map((j) => j.signal_id);
  if (new Set(ids).size !== ids.length) {
    issues.push("judgment signal_ids are not unique");
  }

  return issues;
}
