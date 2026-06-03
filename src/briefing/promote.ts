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

import type Database from "better-sqlite3";
import { getDatabase, writeWithRetry } from "../db/index.js";
import { createLogger } from "../lib/logger.js";
import {
  classifyReply,
  handlePushback,
  type ReRunJudgmentFn,
} from "../lib/v8-2/concession.js";
import {
  countJudgmentsForBriefing,
  getJudgmentsForBriefing,
} from "../lib/v8-2/judgments-store.js";
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

export type BriefingResolution =
  | "promoted"
  | "discarded"
  | "expired"
  // V8.2 §13 concession outcomes (the brief stays pending — operator dialogue):
  | "held_position"
  | "updated_with_evidence"
  | "deferred_no_rerun";

export interface ResolveResult {
  briefingId: string;
  surface: string;
  resolution: BriefingResolution;
  /** §13 concession path only: the operator-facing re-delivery / restatement
   *  text the caller (router) should send back on the same channel. Undefined
   *  for every V8.1 binary outcome, so the router sends nothing for those. */
  reply?: string;
}

/** Injected dependencies for the V8.2 §13 concession path. All optional — in
 *  production only `reRunJudgment` would ever be wired (and isn't yet, the
 *  judgment-assembly producer is a later phase), so the defaults keep the reply
 *  hot-path a pure V8.1 regex. */
export interface ResolveDeps {
  reRunJudgment?: ReRunJudgmentFn;
  /** Injected classifier (tests). Defaults to the live forced-tool classifier. */
  classify?: typeof classifyReply;
  /** Injected db (tests). Defaults to the `getDatabase()` singleton. */
  db?: Database.Database;
  /** Injected clock (tests). */
  nowIso?: string;
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

/** Apply a V8.1 binary outcome: transition the briefing + bump the triage
 *  counter. Returns the result, or null on a race (already resolved). */
function applyBinaryResolution(
  briefingId: string,
  surface: string,
  resolution: "promoted" | "discarded",
): ResolveResult | null {
  const changed = transitionBriefing(briefingId, resolution);
  if (!changed) return null; // raced — already resolved by another path
  recordTriageOutcome(surface, resolution);
  log.info({ briefingId, resolution }, "briefing resolved by operator reply");
  return { briefingId, surface, resolution };
}

/**
 * V8.2 §13 concession path — only reached when the pending brief carries ≥1
 * judgment. Classifies the reply (forced-tool), then:
 *   - pushback → the evidence gate (`handlePushback`): held / updated / deferred,
 *                the brief stays PENDING (the operator is in dialogue);
 *   - promote/discard → the V8.1 binary transition;
 *   - classifier failed (cls=null) → the legacy `DISCARD_RE` regex.
 * A `null` return means a genuine race (judgment vanished) — the caller does
 * NOT fall through to a binary outcome, so a pushback is never silently
 * promoted.
 */
async function resolveWithJudgments(
  pending: { briefingId: string; surface: string },
  replyText: string,
  deps: ResolveDeps,
): Promise<ResolveResult | null> {
  const classify = deps.classify ?? classifyReply;
  const judgments = getJudgmentsForBriefing(pending.briefingId, deps.db);
  const c = await classify(replyText, judgments);

  if (c.cls === "pushback" && c.judgmentId != null) {
    const concession = await handlePushback(c.judgmentId, replyText, {
      reRunJudgment: deps.reRunJudgment,
      db: deps.db,
      nowIso: deps.nowIso,
    });
    if (!concession) return null; // race — don't promote a pushed-back brief
    return {
      briefingId: pending.briefingId,
      surface: pending.surface,
      resolution: concession.kind,
      reply: concession.reply,
    };
  }

  // promote / discard / classifier-failed → V8.1 binary outcome. A failed
  // classify (cls=null) defers to the same legacy regex the no-judgment path
  // uses, so the worst case degrades to V8.1 behavior, never a fabricated hold.
  const resolution: "promoted" | "discarded" =
    c.cls === "discard"
      ? "discarded"
      : c.cls === null && DISCARD_RE.test(replyText)
        ? "discarded"
        : "promoted";
  return applyBinaryResolution(pending.briefingId, pending.surface, resolution);
}

/**
 * Resolve the briefing awaiting interaction, given the operator's reply text.
 * Called from the messaging router's inbound chokepoint for OWNER channels
 * only. Returns the resolution, or null when no delivered briefing is pending.
 *
 * V8.1 path (no judgments): a non-rejecting reply promotes, an explicit
 * rejection discards. V8.2 §13 (≥1 judgment): classify → evidence gate. The
 * V8.2 branch is gated on `countJudgmentsForBriefing > 0`, which is 0 until the
 * judgment-assembly producer ships — so the hot path stays a pure regex with
 * zero new LLM calls for all current traffic.
 *
 * NEVER throws — a failure here must not break operator message handling.
 */
export async function resolveBriefingOnOperatorReply(
  replyText: string,
  deps: ResolveDeps = {},
): Promise<ResolveResult | null> {
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

    // V8.2 §13: judgment-bearing briefs go through the concession evidence gate.
    if (countJudgmentsForBriefing(pending.briefingId, deps.db) > 0) {
      return await resolveWithJudgments(pending, replyText, deps);
    }

    // V8.1 legacy binary path (no judgments) — unchanged.
    const resolution: "promoted" | "discarded" = DISCARD_RE.test(replyText)
      ? "discarded"
      : "promoted";
    return applyBinaryResolution(
      pending.briefingId,
      pending.surface,
      resolution,
    );
  } catch (err) {
    log.warn({ err }, "resolveBriefingOnOperatorReply error (swallowed)");
    return null;
  }
}
