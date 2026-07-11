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
/**
 * A verdict must be the ENTIRE message, not a token found somewhere inside it.
 *
 * This anchoring is the load-bearing part, and a substring allow-list is NOT a
 * substitute (qa-auditor C1, 2026-07-10). `resolveBriefingOnOperatorReply` runs
 * on EVERY inbound owner message while a brief is pending, so any token that is
 * also an ordinary Spanish word silently resolves the brief from an unrelated
 * instruction: "dale prioridad al CRM", "listo, ya subí el sitio", "ok, mando el
 * correo", "confirmo la reunión de las 3" would all have PROMOTED that morning's
 * brief. An allow-list only helps when its tokens are rare OUTSIDE the intended
 * act — these are not. So: match the whole message, and keep the vocabulary to
 * words that are meaningless except as a ruling on a brief.
 *
 * Leading/trailing punctuation, emoji and an optional courtesy "gracias" are
 * tolerated; anything more substantive leaves the brief `pending` (fails closed
 * — a missed accept is a lost data point, a false accept poisons §17 6a, which
 * gates V8.3 autonomy).
 *
 * The `u` flag matters: without it `\b` is ASCII-only, so `\bútil` never fires on
 * a leading accented `ú` and the CORRECTLY spelled "útil" was silently dropped
 * (qa-auditor W2). Anchoring removes the `\b` dependency entirely.
 */
const VERDICT_STRIP_RE = /^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu;
const COURTESY_RE = /\s*,?\s*(gracias|thanks|grax)\s*$/iu;

/**
 * A QUESTION is never a verdict. Punctuation stripping would otherwise reduce
 * "¿sirve?" — the operator ASKING whether something is useful — to the bare
 * accept token "sirve". Checked against the RAW text, before any stripping.
 */
const INTERROGATIVE_RE = /[?¿]/u;

const DISCARD_WHOLE_RE =
  /^(desc[aá]rt\w*|arch[ií]v\w*|no\s+(me\s+)?(interesa|sirve)|no\s+es\s+[uú]til|sk[ií]p)$/iu;
const ACCEPT_WHOLE_RE = /^(s[ií]\s+)?(sirve|es\s+[uú]til|[uú]til)$/iu;

/**
 * The operator's explicit verdict on the delivered brief, or `null` when the
 * message says nothing about it.
 *
 * WHY THIS EXISTS (2026-07-10). Until today a brief was resolved by ANY inbound
 * owner message: `router.ts` calls `resolveBriefingOnOperatorReply` on the
 * messaging chokepoint, and the old rule was "anything that isn't a discard
 * promotes" (the rendered footer even said so: _"Responde lo que sea para
 * conservar este resumen"_). Two consequences, both observed live:
 *
 *   1. FALSE PROMOTE — texting Jarvis about an unrelated project promoted that
 *      morning's brief. 28/28 promotions in the 30d window were of this kind;
 *      not one was a reply to a brief (`promoted_by_message_id` is NULL on all).
 *   2. FALSE DISCARD — on 2026-07-09 the operator wrote "Dejamos para después el
 *      Denue americano… Cierra ese tema" (about the DENUE project). It misses
 *      DISCARD_RE, so the V8.2 LLM classifier judged it — and discarded the
 *      morning brief.
 *
 * So `status` recorded WHETHER THE OPERATOR TEXTED JARVIS, uncorrelated with the
 * brief's content. That destroyed §17 check 6a, whose whole job is to prove the
 * green/red confidence labels discriminate: green and red both scored 100%
 * acceptance. Since 6a is a documented blocker on V8.3's L≥3 autonomous
 * execution, a meaningless 6a is a safety problem, not a cosmetic one.
 *
 * Fix: resolution requires the message to BE a verdict (see the anchoring note
 * above). An unrelated message returns `null` → the brief stays `pending` and a
 * later verdict (or the TTL → `expired`) resolves it. Deterministic, no LLM.
 * Fails closed: when in doubt, `null`.
 *
 * NOTE this is a keyword contract, not a reply-binding one. The robust fix is to
 * bind resolution to an actual reply to the brief's message
 * (`proposed_briefings.promoted_by_message_id` exists for exactly this and is
 * NULL on every row — `IncomingMessage.replyTo` is declared in `messaging/
 * types.ts` but no adapter populates it). Until that is wired, anchoring is what
 * keeps an unrelated instruction from resolving a brief.
 * See feedback_briefing_acceptance_was_engagement.
 */
export function classifyOperatorVerdict(
  replyText: string,
): "promoted" | "discarded" | null {
  if (INTERROGATIVE_RE.test(replyText)) return null;
  const normalized = replyText
    .replace(COURTESY_RE, "")
    .replace(VERDICT_STRIP_RE, "")
    .trim();
  if (normalized === "") return null;
  // DISCARD is tested first so the negated forms ("no sirve", "no es útil")
  // can never fall through to the `sirve` / `útil` accept branch.
  if (DISCARD_WHOLE_RE.test(normalized)) return "discarded";
  if (ACCEPT_WHOLE_RE.test(normalized)) return "promoted";
  return null;
}

/**
 * Verdict forms that double as standalone IMPERATIVES. "archívalo" /
 * "descártalo" / "skip" can be instructions about prior conversation context
 * ("archive that email we discussed"), not rulings on the brief (qa-audit W1,
 * 2026-07-11). The router must NOT consume the message for those — it resolves
 * the brief fire-and-forget (old behavior + ack) and lets the chat pipeline
 * act on the instruction too. Tested against the same normalization
 * `classifyOperatorVerdict` uses.
 */
const IMPERATIVE_VERDICT_RE = /^(desc[aá]rt|arch[ií]v|sk[ií]p)/iu;

/**
 * True when the message is a verdict AND can mean nothing but a ruling on the
 * brief ("sirve", "útil", "no sirve", "no me interesa"…) — safe for the router
 * to swallow. False for non-verdicts and for imperative-shaped verdicts.
 */
export function isExclusivelyBriefVerdict(replyText: string): boolean {
  if (classifyOperatorVerdict(replyText) === null) return false;
  const normalized = replyText
    .replace(COURTESY_RE, "")
    .replace(VERDICT_STRIP_RE, "")
    .trim();
  return !IMPERATIVE_VERDICT_RE.test(normalized);
}

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
  /** Operator-facing text the caller (router) should send back on the same
   *  channel. §13 concession outcomes carry their re-delivery / restatement;
   *  binary outcomes carry a short deterministic ack (2026-07-11: the old
   *  "router sends nothing for binary" design assumed the parallel chat task
   *  would acknowledge — live, the model answered a bare "sirve" with an
   *  empty STATUS: DONE and the operator got total silence). Only `expired`
   *  stays reply-less: it fires on ANY owner message after the TTL, and an
   *  out-of-context interjection there would be noise. */
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
  return {
    briefingId,
    surface,
    resolution,
    reply:
      resolution === "promoted"
        ? "✓ Brief conservado."
        : "🗑️ Brief descartado.",
  };
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
  /**
   * The operator's deterministic verdict, or `null` when the message carries
   * none. A `null` verdict can still be a PUSHBACK (which holds the brief
   * pending), but it can never resolve the brief — the classifier's own
   * promote/discard opinion is NOT authoritative.
   */
  verdict: "promoted" | "discarded" | null,
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

  // No deterministic verdict → the message was not a ruling on this brief. The
  // classifier's promote/discard opinion is deliberately IGNORED here: it is what
  // discarded the 2026-07-09 brief on an unrelated DENUE instruction. Leave the
  // brief `pending`; a later "sirve"/"descarta" (or the TTL → `expired`) rules.
  if (verdict === null) return null;

  // The operator's DETERMINISTIC verdict is authoritative. The classifier may
  // only ESCALATE an accept into a discard (it read a rejection the regex
  // missed), never the reverse — an LLM must not overturn an explicit
  // "descarta" into a promote. A failed classify (cls=null) falls back to
  // `verdict`, so a classifier outage can never fabricate an acceptance.
  const resolution: "promoted" | "discarded" =
    c.cls === "discard" ? "discarded" : verdict;
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

    // An EXPLICIT verdict is required to RESOLVE the brief. A message that says
    // nothing about it leaves it `pending` — that is neither an acceptance nor a
    // rejection. (Was: "anything that isn't a discard promotes".)
    const verdict = classifyOperatorVerdict(replyText);

    // V8.2 §13: judgment-bearing briefs still reach the concession gate even
    // with a null verdict, because a PUSHBACK ("no estoy de acuerdo con X") is
    // neither accept nor reject and must still be classified — it feeds the §17
    // sycophancy check. `resolveWithJudgments` will hold the brief pending
    // unless `verdict` is non-null, so the classifier can never resolve it.
    if (countJudgmentsForBriefing(pending.briefingId, deps.db) > 0) {
      return await resolveWithJudgments(pending, replyText, verdict, deps);
    }

    // V8.1 binary path (no judgments): without a verdict there is nothing to do.
    if (verdict === null) return null;
    return applyBinaryResolution(pending.briefingId, pending.surface, verdict);
  } catch (err) {
    log.warn({ err }, "resolveBriefingOnOperatorReply error (swallowed)");
    return null;
  }
}
