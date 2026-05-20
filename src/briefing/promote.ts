/**
 * Briefing promote / discard — V8.1 Phase 8 (spec §9 / §10).
 *
 * The operator's first reply after a briefing is delivered resolves it: any
 * non-rejecting reply PROMOTES it, an explicit rejection DISCARDS it (spec §14
 * Q6 — "ANY non-rejection reply within the expiry window = promotion"). A
 * delivered briefing whose `expires_at` has passed EXPIRES instead.
 *
 * Promote/discard counts feed `triage_policies` — the learned-policy table
 * (spec §9, LangChain-ambient port). Phase 8 records the counters; the LLM
 * `policy_text` rewrite loop is a deferred follow-up (it needs real
 * promote/discard history to be meaningful — chicken/egg with delivery).
 *
 * RECONCILIATION vs spec §9: promoted briefings are NOT yet written back into
 * `general_events` (the Conway Pattern 1 memory write-back needs the embedding
 * pipeline) — deferred. Discarded briefings are retained as-is (`status=
 * 'discarded'` rows stay), which already satisfies the §9 "retained for
 * correspondence-mode recall" requirement.
 */

import { getDatabase, writeWithRetry } from "../db/index.js";
import { createLogger } from "../lib/logger.js";
import { getResolvablePendingBriefing, transitionBriefing } from "./storage.js";

const log = createLogger("briefing:promote");

/**
 * Explicit-rejection phrases (Spanish + English). A reply matching this
 * discards the briefing; ANY other reply promotes it (spec §14 Q6 — the bar
 * for a discard is a CLEAR rejection, so the set is deliberately tight).
 *
 * Deliberately EXCLUDED (audit W5): "no ahora" / "más tarde" / "salta" /
 * "omit*" — "lo veo más tarde" is engagement (keep the brief), not rejection,
 * and the broad stems false-matched unrelated words ("ignoraba", "saltamos").
 */
const DISCARD_RE =
  /\b(desc[aá]rt\w*|arch[ií]v\w*|no me interesa|no me sirve|sk[ií]p)\b/i;

export type BriefingResolution = "promoted" | "discarded" | "expired";

export interface ResolveResult {
  briefingId: string;
  surface: string;
  resolution: BriefingResolution;
}

/**
 * Increment a surface's triage counters (spec §9). UPSERT — the `triage_
 * policies` row is created on the surface's first outcome.
 */
function recordTriageOutcome(
  surface: string,
  outcome: "promoted" | "discarded",
): void {
  const col = outcome === "promoted" ? "promote_count" : "discard_count";
  writeWithRetry(() => {
    getDatabase()
      .prepare(
        `INSERT INTO triage_policies (surface, ${col}, last_outcome, updated_at)
         VALUES (?, 1, ?, datetime('now'))
         ON CONFLICT(surface) DO UPDATE SET
           ${col} = ${col} + 1,
           last_outcome = excluded.last_outcome,
           updated_at = datetime('now')`,
      )
      .run(surface, outcome);
  });
}

/**
 * Resolve the briefing awaiting interaction, given the operator's reply text.
 * Called from the messaging router's inbound chokepoint for OWNER channels
 * only. Returns the resolution, or null when no delivered briefing is pending.
 *
 * NEVER throws — a failure here must not break operator message handling.
 */
export function resolveBriefingOnOperatorReply(
  replyText: string,
): ResolveResult | null {
  try {
    const pending = getResolvablePendingBriefing();
    if (!pending) return null;

    // A delivered briefing the operator never engaged with, now past expiry.
    if (Date.parse(pending.expiresAt) < Date.now()) {
      const expired = transitionBriefing(pending.briefingId, "expired");
      if (expired) {
        log.info({ briefingId: pending.briefingId }, "briefing expired unread");
      }
      return expired
        ? {
            briefingId: pending.briefingId,
            surface: pending.surface,
            resolution: "expired",
          }
        : null;
    }

    const resolution: BriefingResolution = DISCARD_RE.test(replyText)
      ? "discarded"
      : "promoted";
    const changed = transitionBriefing(pending.briefingId, resolution);
    if (!changed) return null; // raced — already resolved by another path

    recordTriageOutcome(pending.surface, resolution);
    log.info(
      { briefingId: pending.briefingId, resolution },
      "briefing resolved by operator reply",
    );
    return {
      briefingId: pending.briefingId,
      surface: pending.surface,
      resolution,
    };
  } catch (err) {
    log.warn({ err }, "resolveBriefingOnOperatorReply error (swallowed)");
    return null;
  }
}
