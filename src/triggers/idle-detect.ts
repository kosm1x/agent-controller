/**
 * Idle-detect alert trigger — V8.1 Phase 7, spec §6 Trigger 3.
 *
 * Runs on a 30-minute cron. Fires a stalled-focused reflection pass when BOTH
 * conditions hold:
 *   - no foreground (`spawn_type='root'`) task has been touched in 4h;
 *   - at least one task is stalled (Phase 5 `detectStalledTasks`).
 *
 * This is the "operator went away mid-task" case — a quiet system with an
 * unfinished task is exactly when an unprompted nudge has value.
 *
 * Throttled to at most one fire per 12h (spec §6) and bounded by the shared
 * §14-Q4 reflection budget. A check that does not fire writes nothing to
 * `trigger_runs` — the 12h throttle is consumed only by a real fire, so a
 * 30-min poll loop that keeps finding the same idle+stalled state still fires
 * just once per 12h.
 *
 * RECONCILIATION vs spec §6: the spec's "emits Telegram-only nudge" is Phase 8
 * (surface delivery). Phase 7's idle-detect ends at a logged reflection pass —
 * no operator-facing message. The cursor is `pattern_detector`, the §7 cursor
 * for blocker/stall-focused passes.
 */

import { getDatabase } from "../db/index.js";
import { detectStalledTasks } from "../detection/index.js";
import { runReflection } from "../reflection/runner.js";
import { createLogger } from "../lib/logger.js";
import {
  isThrottled,
  recordTriggerRun,
  reflectionBudgetAvailable,
} from "./throttle.js";

const log = createLogger("triggers:idle-detect");

/** No foreground activity for this long ⇒ "idle" (spec §6 Trigger 3). */
const IDLE_SQL_WINDOW = "-4 hours";
/** At most one idle-detect fire per this window (spec §6). */
const IDLE_THROTTLE_WINDOW = "-12 hours";

export interface IdleDetectResult {
  fired: boolean;
  reason:
    | "fired"
    | "not-idle"
    | "no-stalled-task"
    | "throttled"
    | "budget-exhausted";
  stalledCount: number;
}

/**
 * True when no `spawn_type='root'` task has been updated within
 * `IDLE_SQL_WINDOW`. Zero root tasks also reads as idle — the stalled-task
 * gate below then short-circuits (nothing to reflect on).
 *
 * `tasks.updated_at` is written via `datetime('now')` (UTC); the comparison
 * is SQLite-native UTC math, so there is no timezone trap.
 */
function isIdle(): boolean {
  const row = getDatabase()
    .prepare(
      `SELECT 1 FROM tasks
        WHERE spawn_type = 'root'
          AND updated_at > datetime('now', ?)
        LIMIT 1`,
    )
    .get(IDLE_SQL_WINDOW);
  return row === undefined;
}

/**
 * Run one idle-detect check. Returns the decision (also useful for tests);
 * the cron wrapper ignores the return value.
 */
export async function runIdleDetectCheck(): Promise<IdleDetectResult> {
  if (!isIdle()) {
    return { fired: false, reason: "not-idle", stalledCount: 0 };
  }

  const stalled = detectStalledTasks();
  if (stalled.length === 0) {
    return { fired: false, reason: "no-stalled-task", stalledCount: 0 };
  }

  if (isThrottled("idle_detect", IDLE_THROTTLE_WINDOW)) {
    return { fired: false, reason: "throttled", stalledCount: stalled.length };
  }

  if (!reflectionBudgetAvailable()) {
    // Budget is a global condition — log it, but write no row, so the 12h
    // throttle is not consumed and the next poll can fire once budget frees.
    log.info("idle-detect skipped — 24h reflection budget exhausted");
    return {
      fired: false,
      reason: "budget-exhausted",
      stalledCount: stalled.length,
    };
  }

  recordTriggerRun(
    "idle_detect",
    "fired",
    `${stalled.length} stalled task(s) after 4h idle`,
  );
  try {
    const result = await runReflection({
      cursorName: "pattern_detector",
      trigger: "idle-detect",
    });
    log.info(
      {
        ran: result.ran,
        reason: result.reason,
        stalledCount: stalled.length,
      },
      "idle-detect reflection pass complete",
    );
  } catch (err) {
    log.error({ err }, "idle-detect reflection pass threw");
  }
  return { fired: true, reason: "fired", stalledCount: stalled.length };
}
