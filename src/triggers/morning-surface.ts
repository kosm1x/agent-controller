/**
 * Morning-surface trigger — V8.1 Phase 7, spec §6 Trigger 2.
 *
 * A daily cron (default 06:00 America/Mexico_City) constructs a morning
 * briefing via `constructBriefing` and persists it as a `proposed_briefings`
 * row with `status='pending'`. `insertProposedBriefing` supersedes any prior
 * pending morning row, so briefings never stack.
 *
 * RECONCILIATION vs spec §6 / entry brief: Phase 7 GENERATES the briefing but
 * does NOT deliver it. Delivery (Telegram + email) and the migration of
 * `rituals/morning.ts` to a thin wrapper are spec §12 Phase 8. Phase 7's
 * trigger ends at a persisted pending briefing — the anti-mission line ("no
 * autopilot: a Phase 7 trigger's job ends at a persisted pending briefing").
 * The existing `morning-briefing` ritual still emails the operator unchanged;
 * the new pipeline runs alongside it until Phase 8.
 *
 * ENTRY GATE (closure-audit W1): an operator-facing brief must not ship on a
 * thin retrieval layer (12 seed `general_events`, auto-discovery not landed).
 * Phase 7 keeps the brief NON-operator-facing, so the gate is honoured by
 * deferral — Phase 8 MUST re-check seed sufficiency before wiring delivery.
 * `constructBriefing` already self-flags a thin window with a `stale_data`
 * producer concern, so a persisted pending row carries the signal forward.
 */

import { constructBriefing } from "../briefing/construct.js";
import { createLogger } from "../lib/logger.js";
import { recordTriggerRun } from "./throttle.js";

const log = createLogger("triggers:morning-surface");

export interface MorningSurfaceResult {
  ok: boolean;
  briefingId?: string;
  failureStage?: string;
  detail?: string;
}

/**
 * Construct and persist one pending morning briefing. Never throws — a
 * failure is logged, recorded to `trigger_runs`, and returned as `ok:false`.
 */
export async function runMorningSurface(): Promise<MorningSurfaceResult> {
  let result: MorningSurfaceResult;
  try {
    const construct = await constructBriefing({ surface: "morning" });
    if (construct.ok) {
      result = { ok: true, briefingId: construct.briefing.briefing_id };
      log.info(
        {
          briefingId: construct.briefing.briefing_id,
          verdict: construct.briefing.critic_verdict,
          judgments: construct.briefing.judgments.length,
        },
        "morning briefing constructed and persisted (pending — not delivered)",
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
      ? `briefing ${result.briefingId}`
      : (result.failureStage ?? result.detail ?? "error"),
  );
  return result;
}
