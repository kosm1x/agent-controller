/**
 * V8.3 Phase 6 — §12/§14 consent linkage.
 *
 * The bilateral-consent gate at the DECISION level: an autonomous (L≥3) decision
 * may only execute without operator confirmation if it is backed by a V8.2
 * strategic judgment the operator has already seen and the system has vetted.
 * Spec §12 (line 387) requires all three:
 *   (a) a linked V8.2 judgment with confidence ∈ {green, yellow} — a red judgment
 *       can NEVER autonomous-execute;
 *   (b) that judgment passed the S2 CRITIC with verdict = 'approved';
 *   (c) it was surfaced to the operator in a PRIOR cycle (not same-cycle) —
 *       either via a delivered brief (`proposed_briefings.delivered_at`, the
 *       original path, retired as a live surface 2026-08-03) or via the Morning
 *       Sync strategic line (`judgments.surfaced_at`, sync-surfacing.ts — the
 *       stamp is written only after a verified ≥1-channel delivery, so it is a
 *       consent record of the same strength).
 *
 * L≤2 decisions do NOT consult this — they are operator-confirmed (or a direct
 * operator-pull, which legitimately carries `judgment_id = NULL`, R2 #9). So the
 * pipeline only calls this on a still-autonomous (L≥3) decision; a failure demotes
 * it to confirm (L2) rather than blocking the action outright.
 */

import type Database from "better-sqlite3";
import { getDatabase } from "../../db/index.js";
import { criticVerdict } from "../v8-2/judgment-format.js";

export type LinkageReason =
  | "ok"
  | "no_linked_judgment"
  | "judgment_not_found"
  | "judgment_confidence_not_green_yellow"
  | "judgment_not_critic_approved"
  | "judgment_not_prior_brief";

export interface LinkageResult {
  ok: boolean;
  reason: LinkageReason;
}

interface LinkageRow {
  confidence: string | null;
  critic_trail_json: string | null;
  /** 1 when the judgment reached the operator strictly before `nowIso` —
   *  via its briefing's `delivered_at` OR its own `surfaced_at`. */
  is_prior: number | null;
}

/**
 * Evaluate §12 consent linkage for a would-be autonomous decision. Deterministic
 * (no LLM — the judgment was already CRITIC-vetted in V8.2; this only READS that
 * verdict). Returns the FIRST failing condition so the demote event names a
 * specific cause.
 *
 * The prior-surface check compares `pb.delivered_at < datetime(?)` (and the
 * same for `j.surfaced_at`). Correctness rests on both columns ALREADY being
 * SQLite-datetime (`'YYYY-MM-DD HH:MM:SS'` — `delivered_at` written by
 * `datetime('now')` in `briefing/storage.ts`, `surfaced_at` by `datetime('now')`
 * in `sync-surfacing.ts`); `datetime(?)` normalizes the ISO-8601 `nowIso` param
 * (`…T…Z`) to that same shape so the `<` is chronological. A raw lexical compare
 * of a space-format column against an ISO `T`-format now would be always-true
 * (`' '`0x20 < `'T'`0x54) — this avoids it. (Even if a column were ever ISO, the
 * mismatch fails SAFE: it sorts AFTER a space-format now → `is_prior=0` →
 * over-demote, never a wrong autonomous pass.)
 */
export function checkJudgmentLinkage(
  judgmentId: number | null | undefined,
  nowIso: string,
  db: Database.Database = getDatabase(),
): LinkageResult {
  if (judgmentId == null) return { ok: false, reason: "no_linked_judgment" };

  const row = db
    .prepare(
      `SELECT j.confidence               AS confidence,
              j.critic_trail_json        AS critic_trail_json,
              ((pb.delivered_at IS NOT NULL AND pb.delivered_at < datetime(?))
               OR (j.surfaced_at IS NOT NULL AND j.surfaced_at < datetime(?))) AS is_prior
         FROM judgments j
         LEFT JOIN proposed_briefings pb ON pb.briefing_id = j.briefing_id
        WHERE j.id = ?`,
    )
    .get(nowIso, nowIso, judgmentId) as LinkageRow | undefined;

  if (!row) return { ok: false, reason: "judgment_not_found" };
  if (row.confidence !== "green" && row.confidence !== "yellow") {
    return { ok: false, reason: "judgment_confidence_not_green_yellow" };
  }
  if (criticVerdict(row.critic_trail_json) !== "approved") {
    return { ok: false, reason: "judgment_not_critic_approved" };
  }
  if (row.is_prior !== 1) {
    return { ok: false, reason: "judgment_not_prior_brief" };
  }
  return { ok: true, reason: "ok" };
}
