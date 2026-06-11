/**
 * V8.1 Phase 7 — trigger wiring (spec §6).
 *
 * `startTriggers()` registers the three triggers that finally fire the V8.1
 * reflection / briefing pipeline built in Phases 4-6:
 *   1. N-turn  — `task.completed` subscription   (src/triggers/n-turn.ts);
 *   2. Cron    — daily morning-surface           (src/triggers/morning-surface.ts);
 *   3. Idle    — 30-min idle-detect check        (src/triggers/idle-detect.ts).
 *
 * Called from `src/index.ts` alongside `startRitualScheduler()`, under the
 * same `RITUALS_ENABLED` gate. `V81_TRIGGERS_ENABLED=false` is a kill switch
 * that disables the triggers without touching the rest of the scheduler.
 *
 * Phase 7 triggers produce only NON-operator-facing artifacts — pending
 * `proposed_briefings` rows and logged reflection passes. Nothing reaches the
 * operator until Phase 8 wires surface delivery.
 */

import cron, { type ScheduledTask } from "node-cron";
import { getEventBus } from "../lib/event-bus.js";
import { RITUALS_TIMEZONE } from "../rituals/config.js";
import { handleTaskCompleted } from "./n-turn.js";
import { runMorningSurface } from "./morning-surface.js";
import { runIdleDetectCheck } from "./idle-detect.js";

const jobs: ScheduledTask[] = [];

/** Default morning-surface cron — 06:00 local. Override via V81_MORNING_BRIEF_CRON. */
const DEFAULT_MORNING_CRON = "0 6 * * *";
/** Idle-detect poll cadence — every 30 minutes. */
const IDLE_DETECT_CRON = "*/30 * * * *";

export function startTriggers(): void {
  if (process.env.V81_TRIGGERS_ENABLED === "false") {
    console.log("[triggers] disabled via V81_TRIGGERS_ENABLED=false");
    return;
  }

  // Trigger 1 — N-turn reflection on foreground task completion.
  getEventBus().subscribe("task.completed", handleTaskCompleted);
  console.log("[triggers] n-turn: subscribed to task.completed");

  // Trigger 2 — daily morning surface.
  const requested = process.env.V81_MORNING_BRIEF_CRON || DEFAULT_MORNING_CRON;
  const morningExpr = cron.validate(requested)
    ? requested
    : DEFAULT_MORNING_CRON;
  if (morningExpr !== requested) {
    console.error(
      `[triggers] morning-surface: invalid cron "${requested}", using ${DEFAULT_MORNING_CRON}`,
    );
  }
  jobs.push(
    cron.schedule(morningExpr, () => void runMorningSurface(), {
      timezone: RITUALS_TIMEZONE,
    }),
  );
  console.log(
    `[triggers] morning-surface: scheduled (${morningExpr}, tz=${RITUALS_TIMEZONE})`,
  );

  // Trigger 3 — idle-detect. Catch at the cron boundary: the check's DB
  // reads (detectStalledTasks/isThrottled) run outside any try inside, so a
  // throw was an unhandled rejection and a silently-skipped check.
  jobs.push(
    cron.schedule(
      IDLE_DETECT_CRON,
      () =>
        void runIdleDetectCheck().catch((err) => {
          console.error("[triggers] idle-detect check failed:", err);
        }),
      { timezone: RITUALS_TIMEZONE },
    ),
  );
  console.log(
    `[triggers] idle-detect: scheduled (${IDLE_DETECT_CRON}, tz=${RITUALS_TIMEZONE})`,
  );
}

/** Stop all cron-scheduled triggers. The N-turn subscription persists with
 *  the event bus (process-lifetime). */
export function stopTriggers(): void {
  for (const job of jobs) job.stop();
  jobs.length = 0;
  console.log("[triggers] all cron jobs stopped");
}
