/**
 * Morning-surface trigger — V8.1 Phase 7, spec §6 Trigger 2.
 *
 * A daily cron (default 06:00 America/Mexico_City) constructs a morning
 * briefing via `constructBriefing` and persists it as a `proposed_briefings`
 * row with `status='pending'`. `insertProposedBriefing` supersedes any prior
 * pending morning row, so briefings never stack.
 *
 * V8.1 Phase 8: when `V81_BRIEF_DELIVERY_ENABLED=true` the constructed
 * briefing is also DELIVERED to the operator (`deliverBriefing`). The flag is
 * off until Phase 9 activation, so by default this trigger still only
 * generates + persists a `pending` briefing — no operator-facing change.
 *
 * SHADOW-RUN (audit C1): with delivery off, this trigger generates a briefing
 * daily WHILE the legacy `morning-briefing` ritual still emails the operator.
 * Two generations/day is intentional — the shadow briefings are what Phase 9
 * activation curates. When delivery is switched on, `scheduler.ts` skips the
 * legacy ritual, so there is exactly one delivered brief in every flag state.
 *
 * SEED GATE (closure-audit W1): the entry gate said re-check `general_events`
 * seed sufficiency before operator-facing delivery. Live count is 36 seed
 * events — within the spec §5 target band (30-50) — so the gate is cleared;
 * delivery is built behind a flag regardless, and `constructBriefing` still
 * self-flags a thin retrieval window via a `stale_data` producer concern.
 */

import { constructBriefing } from "../briefing/construct.js";
import {
  deliverBriefing,
  isBriefingDeliveryEnabled,
} from "../briefing/delivery.js";
import { expireStalePendingBriefings } from "../briefing/storage.js";
import { sweepDueReflectionFollowups } from "../briefing/reflection-followups.js";
import { isV82ProducerEnabled } from "../lib/v8-2/flags.js";
import { runJudgmentAssembly } from "../lib/v8-2/produce.js";
import { createLogger } from "../lib/logger.js";
import { recordTriggerRun } from "./throttle.js";

const log = createLogger("triggers:morning-surface");

/** Wall-clock cap on the whole V8.2 judgment-assembly shadow pass (serial,
 *  multi-LLM-call). The brief is already constructed + persisted before this
 *  runs, so the cap only bounds dormant shadow work, never the live brief. */
const JUDGMENT_ASSEMBLY_DEADLINE_MS = 5 * 60_000;

export interface MorningSurfaceResult {
  ok: boolean;
  briefingId?: string;
  /** True when the briefing was also delivered to the operator (flag-gated). */
  delivered?: boolean;
  failureStage?: string;
  detail?: string;
}

/**
 * Construct and persist one pending morning briefing — and, when
 * `V81_BRIEF_DELIVERY_ENABLED=true`, deliver it to the operator. Never throws:
 * a failure is logged, recorded to `trigger_runs`, and returned as `ok:false`.
 */
export async function runMorningSurface(): Promise<MorningSurfaceResult> {
  let result: MorningSurfaceResult;
  try {
    // Daily sweep: expire delivered briefings the operator never engaged with
    // (audit W1 — the lazy per-reply expiry in promote.ts misses this case).
    const expired = expireStalePendingBriefings();
    if (expired > 0) {
      log.info({ expired }, "expired stale delivered briefings");
    }

    // Daily sweep: fire any due self-recheck followups (V8.2 §13 / V8.3 §12).
    // Isolated in its own try/catch — a followup-ledger hiccup must never sink
    // the primary morning briefing. No producers write rows yet (Phase 0), so
    // this is a no-op until those consumers land.
    try {
      await sweepDueReflectionFollowups();
    } catch (err) {
      log.error({ err }, "reflection followup sweep failed (non-fatal)");
    }

    const construct = await constructBriefing({ surface: "morning" });
    if (construct.ok) {
      const briefingId = construct.briefing.briefing_id;
      result = { ok: true, briefingId };

      // V8.2 §17 shadow — the judgment-assembly producer. Flag-gated
      // (`V82_JUDGMENT_PRODUCER_ENABLED`), isolated in its OWN try/catch
      // (mirrors the reflection-followup sweep above): it writes `judgments` /
      // `attributed_claims` rows + runs the critic for measurement, but those
      // rows are NOT delivered (the brief still delivers its V8.1 prose). A
      // producer failure here must NEVER break the live brief or its delivery.
      // A pass-level AbortController caps the whole (serial, multi-LLM-call)
      // pass so a slow shadow run can't hold the morning flow unbounded — each
      // per-judgment step already honors the signal.
      if (isV82ProducerEnabled()) {
        const ac = new AbortController();
        const deadline = setTimeout(
          () => ac.abort(new Error("judgment-assembly pass deadline")),
          JUDGMENT_ASSEMBLY_DEADLINE_MS,
        );
        try {
          const produced = await runJudgmentAssembly(construct.briefing, {
            signal: ac.signal,
          });
          log.info(
            { briefingId, ...produced },
            "v8.2 judgment-assembly produced shadow judgments",
          );
        } catch (err) {
          log.error(
            { err, briefingId },
            "v8.2 judgment-assembly failed (non-fatal)",
          );
        } finally {
          clearTimeout(deadline);
        }
      }

      // Phase 8 delivery — flag-gated. Off until Phase 9 activation, so by
      // default the briefing stays a persisted `pending` row.
      if (isBriefingDeliveryEnabled()) {
        const delivery = await deliverBriefing(briefingId);
        result.delivered = delivery.delivered;
        if (!delivery.delivered) {
          log.warn(
            { briefingId, reason: delivery.reason },
            "morning briefing constructed but not delivered",
          );
        }
      }

      log.info(
        {
          briefingId,
          verdict: construct.briefing.critic_verdict,
          judgments: construct.briefing.judgments.length,
          delivered: result.delivered ?? false,
        },
        "morning briefing constructed and persisted",
      );
    } else {
      result = {
        ok: false,
        failureStage: construct.stage,
        detail: construct.detail,
      };
      log.error(
        { stage: construct.stage, detail: construct.detail },
        "morning briefing construction failed",
      );
    }
  } catch (err) {
    result = {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
    log.error({ err }, "morning-surface trigger threw");
  }

  recordTriggerRun(
    "cron_morning",
    result.ok ? "fired" : "failed",
    result.ok
      ? `briefing ${result.briefingId}${result.delivered ? " (delivered)" : ""}`
      : (result.failureStage ?? result.detail ?? "error"),
  );
  return result;
}
